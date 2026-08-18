import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrganizationInvitation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    createOrganizationInvitation: mocks.createOrganizationInvitation,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, info: vi.fn() },
}));

import { invitationsService } from "./service";

const CLERK_ORG_ID = "clerk-org-1";
const INVITER = "clerk-user-1";

describe("invitationsService.inviteMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints one Clerk invitation per email with the inviter and org scope", async () => {
    mocks.createOrganizationInvitation.mockImplementation(
      ({ emailAddress }: { emailAddress: string }) =>
        Promise.resolve({ id: `inv_${emailAddress}` })
    );

    const result = await invitationsService.inviteMembers({
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      emailAddresses: ["a@example.com", "b@example.com"],
    });

    expect(result.invited).toBe(2);
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledTimes(2);
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: CLERK_ORG_ID,
        emailAddress: "a@example.com",
        inviterUserId: INVITER,
        role: "org:member",
      })
    );
    expect(result.results.map((r) => r.status)).toEqual(["invited", "invited"]);
  });

  it("defaults to org:member and honors an explicit admin role", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });

    await invitationsService.inviteMembers({
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      emailAddresses: ["a@example.com"],
      role: "org:admin",
    });

    expect(mocks.createOrganizationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ role: "org:admin" })
    );
  });

  it("treats a Clerk duplicate error as already_member without aborting the batch", async () => {
    mocks.createOrganizationInvitation
      .mockRejectedValueOnce({ errors: [{ code: "duplicate_record" }] })
      .mockResolvedValueOnce({ id: "inv_2" });

    const result = await invitationsService.inviteMembers({
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      emailAddresses: ["dupe@example.com", "new@example.com"],
    });

    expect(result.invited).toBe(1);
    expect(result.results[0].status).toBe("already_member");
    expect(result.results[1].status).toBe("invited");
  });

  it("records a failed result and logs when Clerk errors unexpectedly", async () => {
    mocks.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "internal_error", message: "Clerk is down" }],
    });

    const result = await invitationsService.inviteMembers({
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      emailAddresses: ["a@example.com"],
    });

    expect(result.invited).toBe(0);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].reason).toBe("Clerk is down");
    expect(mocks.logError).toHaveBeenCalled();
  });
});
