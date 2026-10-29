import { InviteMemberStatus } from "@repo/api/src/types/onboarding";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrganizationInvitation: vi.fn(),
  logError: vi.fn(),
  recordInvitesSent: vi.fn(),
  recordUserInvitesSent: vi.fn(),
}));

vi.mock("../../onboarding/service", () => ({
  onboardingService: {
    recordInvitesSent: mocks.recordInvitesSent,
    recordUserInvitesSent: mocks.recordUserInvitesSent,
  },
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
const ORG_ID = "org-1";
const INVITER = "clerk-user-1";
const INVITER_USER_ID = "user-1";

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
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
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
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
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
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
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
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["a@example.com"],
    });

    expect(result.invited).toBe(0);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].reason).toBe("Clerk is down");
    expect(mocks.logError).toHaveBeenCalled();
  });

  // ISS-8866: "which tenant's invites are failing" is the question this line
  // exists for. `clerkOrgId` alone cannot answer it without a reverse-lookup
  // join, so the APP org id has to be on the meta beside it.
  it("attributes a Clerk invitation failure to the app organization, not only the Clerk org", async () => {
    mocks.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "internal_error", message: "Clerk is down" }],
    });

    await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["a@example.com"],
    });

    const meta = mocks.logError.mock.calls[0][1];
    expect(meta).toEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        clerkOrgId: CLERK_ORG_ID,
      })
    );
    // ORG_ID and CLERK_ORG_ID are deliberately different values, so an
    // `organizationId` sourced from `params.clerkOrgId` fails here rather than
    // reading as correct.
    expect(meta.organizationId).not.toBe(CLERK_ORG_ID);
  });

  it("logs nothing when every invitation mints", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });
    // `log.error` has a SECOND call site in this module — `recordInvitesSent`'s
    // catch — and `vi.clearAllMocks()` clears calls, not implementations, so a
    // sibling case's `mockRejectedValue` would otherwise reach this negative
    // assertion under any reordering or `--sequence.shuffle`.
    mocks.recordInvitesSent.mockResolvedValue(undefined);

    await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["a@example.com"],
    });

    expect(mocks.logError).not.toHaveBeenCalled();
  });

  // ISS-7089: the onboarding checklist's invite row completes off this marker,
  // because an invitation the invitee has not accepted yet produces no member
  // row for the row's other signal to count.
  it("records the send against the caller's own org once an invitation mints", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });

    await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    expect(mocks.recordInvitesSent).toHaveBeenCalledWith(ORG_ID);
  });

  it("records nothing when every invitation failed", async () => {
    mocks.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "internal_error", message: "Clerk is down" }],
    });

    const result = await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    expect(result.invited).toBe(0);
    expect(mocks.recordInvitesSent).not.toHaveBeenCalled();
  });

  it("still returns the minted invitations when the marker write fails", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });
    mocks.recordInvitesSent.mockRejectedValue(
      new Error("settings write failed")
    );

    const result = await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    // The invitation is already out; failing the request would tell the admin
    // nothing was sent.
    expect(result.invited).toBe(1);
    expect(mocks.logError).toHaveBeenCalled();
  });

  /*
   * ISS-11670. The guided invite step's `teamInvited` reads the PER-USER
   * invites-sent marker, and this send is its only producer — so these four
   * cases are what decide whether a reader is asked again. The one that bites is
   * `already_member`: the route answers 200 with `invited: 0` and zero failures,
   * the step renders a confirmation for it and offers Continue, and stamping on
   * that Continue is what re-raised the false "Invitations sent" state the
   * ticket exists to remove.
   */
  it("records the send against the inviting USER once an invitation mints", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });

    await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    expect(mocks.recordUserInvitesSent).toHaveBeenCalledWith(
      ORG_ID,
      INVITER_USER_ID
    );
    // INVITER and INVITER_USER_ID are deliberately different values, so a
    // marker keyed off the CLERK principal fails here rather than reading as
    // correct.
    expect(mocks.recordUserInvitesSent).not.toHaveBeenCalledWith(
      ORG_ID,
      INVITER
    );
  });

  it("records nothing against the user when every address was already a member", async () => {
    mocks.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "duplicate_record" }],
    });

    const result = await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["already@example.com"],
    });

    expect(result.invited).toBe(0);
    expect(result.results[0].status).toBe(InviteMemberStatus.AlreadyMember);
    expect(mocks.recordUserInvitesSent).not.toHaveBeenCalled();
  });

  it("records nothing against the user when every invitation failed", async () => {
    mocks.createOrganizationInvitation.mockRejectedValue({
      errors: [{ code: "internal_error", message: "Clerk is down" }],
    });

    await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    expect(mocks.recordUserInvitesSent).not.toHaveBeenCalled();
  });

  it("still returns the minted invitations when the per-user marker write fails", async () => {
    mocks.createOrganizationInvitation.mockResolvedValue({ id: "inv_1" });
    mocks.recordInvitesSent.mockResolvedValue(undefined);
    mocks.recordUserInvitesSent.mockRejectedValue(new Error("no run row"));

    const result = await invitationsService.inviteMembers({
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      inviterClerkUserId: INVITER,
      inviterUserId: INVITER_USER_ID,
      emailAddresses: ["invitee@example.com"],
    });

    expect(result.invited).toBe(1);
    expect(mocks.logError).toHaveBeenCalled();
  });
});
