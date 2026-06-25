import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: vi.fn(),
  },
}));

import { clerkService } from "@/lib/auth/clerk-service";
import { resolveOrgHeader } from "@/lib/auth/resolve-org-header";

const SESSION_CLERK_ORG_ID = "org_session_123";
const HEADER_CLERK_ORG_ID = "org_header_456";
const CLERK_USER_ID = "user_clerk_abc";
const SESSION_ORG_ROLE = "org:admin";

function createRequest(orgHeaderValue?: string): Request {
  const headers = new Headers();
  if (orgHeaderValue) {
    headers.set(ORG_IDENTITY_HEADER, orgHeaderValue);
  }
  return new Request("http://localhost/test", { headers });
}

describe("resolveOrgHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns session org when header is absent", async () => {
    const result = await resolveOrgHeader(
      createRequest(),
      CLERK_USER_ID,
      SESSION_CLERK_ORG_ID,
      SESSION_ORG_ROLE
    );

    expect(result).toEqual({
      kind: "session",
      clerkOrgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    });
    expect(clerkService.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("returns session org when header matches JWT org", async () => {
    const result = await resolveOrgHeader(
      createRequest(SESSION_CLERK_ORG_ID),
      CLERK_USER_ID,
      SESSION_CLERK_ORG_ID,
      SESSION_ORG_ROLE
    );

    expect(result).toEqual({
      kind: "session",
      clerkOrgId: SESSION_CLERK_ORG_ID,
      orgRole: SESSION_ORG_ROLE,
    });
    expect(clerkService.getOrganizationMembershipRole).not.toHaveBeenCalled();
  });

  it("returns header org with role when header differs and user is a member", async () => {
    const memberRole = "org:member";
    vi.mocked(clerkService.getOrganizationMembershipRole).mockResolvedValue(
      memberRole
    );

    const result = await resolveOrgHeader(
      createRequest(HEADER_CLERK_ORG_ID),
      CLERK_USER_ID,
      SESSION_CLERK_ORG_ID,
      SESSION_ORG_ROLE
    );

    expect(result).toEqual({
      kind: "header",
      clerkOrgId: HEADER_CLERK_ORG_ID,
      orgRole: memberRole,
    });
    expect(clerkService.getOrganizationMembershipRole).toHaveBeenCalledWith(
      HEADER_CLERK_ORG_ID,
      CLERK_USER_ID
    );
  });

  it("returns forbidden when header differs and user is not a member", async () => {
    vi.mocked(clerkService.getOrganizationMembershipRole).mockResolvedValue(
      null
    );

    const result = await resolveOrgHeader(
      createRequest(HEADER_CLERK_ORG_ID),
      CLERK_USER_ID,
      SESSION_CLERK_ORG_ID,
      SESSION_ORG_ROLE
    );

    expect(result).toEqual({ kind: "forbidden" });
    expect(clerkService.getOrganizationMembershipRole).toHaveBeenCalledWith(
      HEADER_CLERK_ORG_ID,
      CLERK_USER_ID
    );
  });

  it("returns forbidden when header differs and Clerk API throws", async () => {
    vi.mocked(clerkService.getOrganizationMembershipRole).mockRejectedValue(
      new Error("Clerk API unavailable")
    );

    const result = await resolveOrgHeader(
      createRequest(HEADER_CLERK_ORG_ID),
      CLERK_USER_ID,
      SESSION_CLERK_ORG_ID,
      SESSION_ORG_ROLE
    );

    expect(result).toEqual({ kind: "forbidden" });
  });
});
