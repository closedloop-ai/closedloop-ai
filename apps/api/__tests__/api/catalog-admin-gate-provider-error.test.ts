/**
 * ISS-6692 — the catalog admin gate fails CLOSED on a Clerk provider error.
 * ISS-8661 — and says so with a status a caller can tell apart from a denial.
 *
 * FAIL-CLOSED IS UNCHANGED and is still what these tests pin: an unresolvable
 * role never admits, and the gated write never runs. What changed is the
 * status. `getOrgAdminStatus` always distinguished `not_admin` from
 * `provider_error`, but every gate answered 403 for both, so a Clerk outage was
 * reported to the user as "you lack permission" and the `log.error` was the
 * only thing that could tell an operator otherwise. The gate now answers 503
 * with a `role_unresolved` code for the unresolved case and keeps 403 for the
 * genuine denial, so the distinction survives onto the wire; the log assertions
 * stay, because they are still the operator-side half of the same split.
 *
 * The Clerk client is stubbed, NOT the gate — stubbing the gate cannot exercise
 * the split, because the throw has to originate at the provider call.
 */
import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { Result } from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  getOrganizationMembershipRole: vi.fn(),
  createCatalogItem: vi.fn(),
  listCatalogItemsForOrg: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: mocks.user,
          clerkOrgId: "clerk-org-1",
          clerkUserId: "clerk-user-1",
        },
        request,
        context.params
      ),
}));

vi.mock("@/app/catalog/service", () => ({
  createCatalogItem: mocks.createCatalogItem,
  listCatalogItemsForOrg: mocks.listCatalogItemsForOrg,
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { POST } from "@/app/catalog/route";
import { OrgAdminGateErrorCode } from "@/lib/auth/org-admin-denial";

const PROVIDER_ERROR_LOG_MESSAGE = "Failed to resolve Clerk org role";

function invoke() {
  return POST(
    new NextRequest("https://api.example.test/catalog", {
      method: "POST",
      body: JSON.stringify({ targetKind: "plugin", name: "My Plugin" }),
    }),
    { params: Promise.resolve({}) }
  );
}

describe("catalog admin gate — Clerk provider error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCatalogItem.mockResolvedValue(Result.ok({ id: "item-1" }));
  });

  // Both privileged Clerk roles, because dropping either from `OrgAdminRole`
  // locks that role out of every admin-gated catalog route with no other signal.
  it.each([OrgAdminRole.Admin, OrgAdminRole.Owner])(
    "creates the item when Clerk reports the %s role",
    async (role) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      const response = await invoke();

      expect(response.status).toBe(200);
      expect(mocks.createCatalogItem).toHaveBeenCalled();
      expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledWith(
        "clerk-org-1",
        "clerk-user-1"
      );
    }
  );

  it("returns 503 role_unresolved and logs the provider error when Clerk throws", async () => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk 503")
    );

    const response = await invoke();

    expect(response.status).toBe(503);
    // The whole point of ISS-8661: an outage must not wear the denial status.
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
    // Fail CLOSED: an unresolvable role must never be treated as admin.
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      PROVIDER_ERROR_LOG_MESSAGE,
      expect.objectContaining({ clerkOrgId: "clerk-org-1" })
    );
  });

  it("returns 403 without a provider-error log for a genuine non-admin role", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await invoke();

    // A DECISION, and it keeps the decision status. Paired with the case above
    // so neither status can drift into the other's meaning.
    expect(response.status).toBe(403);
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalledWith(
      PROVIDER_ERROR_LOG_MESSAGE,
      expect.anything()
    );
  });
});
