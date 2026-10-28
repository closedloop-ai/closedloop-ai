/**
 * ISS-6934 — the role→admit decision in `ADMIN_ROLES` had no unit test at all.
 *
 * `getOrgAdminStatus` is the ONLY place a Clerk membership role is turned into
 * an admin verdict; every admin-gated route in `apps/api` reaches that decision
 * through it or through the `requireOrgAdmin` gate. Dropping `org:owner`
 * from `ADMIN_ROLES` would lock every org owner out of every one of those
 * routes, so `org:owner` and `org:admin` are asserted as SEPARATE cases: a
 * suite that only exercises `org:admin` stays green under exactly that change.
 *
 * The Clerk client is stubbed and the real module under test runs, so each case
 * executes the `ADMIN_ROLES` membership check against a synthetic role rather
 * than asserting that the check exists.
 *
 * ISS-8661 added the second half: `requireOrgAdmin` must answer a role it could
 * not RESOLVE differently from one it resolved and rejected, so a Clerk outage
 * stops reading as "you lack permission".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipRole: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { getOrgAdminStatus, requireOrgAdmin } from "@/lib/auth/org-admin";
import {
  OrgAdminGateErrorCode,
  ROLE_UNRESOLVED_MESSAGE,
} from "@/lib/auth/org-admin-denial";

const CLERK_ORG_ID = "clerk-org-1";
const CLERK_USER_ID = "clerk-user-1";

describe("getOrgAdminStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits the org:admin role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );

    await expect(
      getOrgAdminStatus(CLERK_ORG_ID, CLERK_USER_ID)
    ).resolves.toEqual({ isAdmin: true, reason: "admin" });
    expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledWith(
      CLERK_ORG_ID,
      CLERK_USER_ID
    );
  });

  it("admits the org:owner role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Owner
    );

    await expect(
      getOrgAdminStatus(CLERK_ORG_ID, CLERK_USER_ID)
    ).resolves.toEqual({ isAdmin: true, reason: "admin" });
    expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledWith(
      CLERK_ORG_ID,
      CLERK_USER_ID
    );
  });

  // Without a denial case the two admissions above would also pass if
  // ADMIN_ROLES were widened to admit everyone.
  it("denies an unprivileged role as not_admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    await expect(
      getOrgAdminStatus(CLERK_ORG_ID, CLERK_USER_ID)
    ).resolves.toEqual({ isAdmin: false, reason: "not_admin" });
  });

  it("denies a caller with no membership as not_admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(null);

    await expect(
      getOrgAdminStatus(CLERK_ORG_ID, CLERK_USER_ID)
    ).resolves.toEqual({ isAdmin: false, reason: "not_admin" });
  });
});

describe("requireOrgAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([ClerkOrgRoleFixture.Admin, ClerkOrgRoleFixture.Owner])(
    "admits the %s role with no refusal response",
    async (role) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      await expect(
        requireOrgAdmin(CLERK_ORG_ID, CLERK_USER_ID)
      ).resolves.toBeNull();
    }
  );

  it("refuses an unprivileged role with 403", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await requireOrgAdmin(CLERK_ORG_ID, CLERK_USER_ID);

    expect(response?.status).toBe(403);
  });

  // ISS-8661. The status is the whole point: before this, a Clerk outage and a
  // genuine denial were the same 403, so the caller was told they lack
  // permission when the truth was that nobody could check.
  it("refuses an UNRESOLVED role with 503 and a role_unresolved code", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk down")
    );

    const response = await requireOrgAdmin(CLERK_ORG_ID, CLERK_USER_ID);

    expect(response?.status).toBe(503);
    expect(response?.status).not.toBe(403);
    await expect(response?.json()).resolves.toEqual({
      success: false,
      error: ROLE_UNRESOLVED_MESSAGE,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
  });

  // Fails CLOSED either way: an unresolved role is never an admission.
  it("never admits a caller whose role could not be resolved", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk down")
    );

    await expect(
      requireOrgAdmin(CLERK_ORG_ID, CLERK_USER_ID)
    ).resolves.not.toBeNull();
  });
});
