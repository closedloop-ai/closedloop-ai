import {
  type InviteMemberResult,
  InviteMemberStatus,
} from "@repo/api/src/types/onboarding";
import { describe, expect, it } from "vitest";
import { foldInviteOutcome } from "../onboarding-invite-outcome";

/**
 * ISS-8348. The invitation route answers 200 for every non-throwing send and
 * reports each address separately, so "did it work" has four answers. The step
 * above this fold used to state the number of addresses the user TYPED, which
 * is wrong for three of them.
 */
describe("foldInviteOutcome", () => {
  it("reports a clean batch as sent, counting the invited rows", () => {
    expect(
      foldInviteOutcome({
        invited: 2,
        results: [result("a@x.com"), result("b@x.com")],
      })
    ).toEqual({ status: "sent", invited: 2 });
  });

  it("does NOT call a batch sent when some addresses were already members", () => {
    // The defect this fold exists for: 5 submitted, 2 invited, 3 already in the
    // org, ZERO failures. A failed-only check reports "5 emails sent".
    const outcome = foldInviteOutcome({
      invited: 2,
      results: [
        result("a@x.com"),
        result("b@x.com"),
        result("c@x.com", InviteMemberStatus.AlreadyMember),
        result("d@x.com", InviteMemberStatus.AlreadyMember),
        result("e@x.com", InviteMemberStatus.AlreadyMember),
      ],
    });

    expect(outcome).toEqual({
      status: "partial",
      invited: 2,
      alreadyMember: 3,
      failed: 0,
    });
  });

  it("separates a batch that invited nobody because everyone was a member", () => {
    expect(
      foldInviteOutcome({
        invited: 0,
        results: [
          result("a@x.com", InviteMemberStatus.AlreadyMember),
          result("b@x.com", InviteMemberStatus.AlreadyMember),
        ],
      })
    ).toEqual({ status: "already-member", alreadyMember: 2 });
  });

  it("reports a mixed batch with failures as partial, not failed", () => {
    expect(
      foldInviteOutcome({
        invited: 1,
        results: [
          result("a@x.com"),
          result("b@x.com", InviteMemberStatus.Failed),
        ],
      })
    ).toEqual({ status: "partial", invited: 1, alreadyMember: 0, failed: 1 });
  });

  it("reports a batch that invited nobody and failed as failed, with the reason", () => {
    const outcome = foldInviteOutcome({
      invited: 0,
      results: [
        {
          email: "a@x.com",
          reason: "Blocked",
          status: InviteMemberStatus.Failed,
        },
      ],
    });

    expect(outcome).toEqual({
      status: "failed",
      failed: 1,
      message: "Blocked",
    });
  });

  it("refuses to settle a batch carrying a status this build does not know", () => {
    // apps/app and apps/api deploy separately, so a newer peer can add a
    // per-email status. Absorbing it into whichever bucket happens to be
    // non-zero is how "No new invitations needed" gets said about a batch that
    // invited people.
    const outcome = foldInviteOutcome({
      invited: 0,
      results: [
        { email: "a@x.com", status: "queued" as InviteMemberStatus },
        result("b@x.com", InviteMemberStatus.AlreadyMember),
      ],
    });

    expect(outcome.status).not.toBe("already-member");
    expect(outcome.status).toBe("failed");
  });

  it("refuses a response whose tally claims more invites than it has rows", () => {
    // The summary and the rows are two accounts of the same send. Trusting the
    // summary renders "5 invitations sent" over a single invited address —
    // exactly the overstated count this fold exists to stop, arriving by a
    // different door than `already_member`.
    const outcome = foldInviteOutcome({
      invited: 5,
      results: [result("a@x.com")],
    });

    expect(outcome.status).not.toBe("sent");
    expect(outcome.status).toBe("failed");
  });

  it("refuses a tally mismatch rather than downgrading it to partial", () => {
    // A mismatch alongside a real failure must not settle either: `partial`
    // would still state an invited count no address backs.
    const outcome = foldInviteOutcome({
      invited: 4,
      results: [
        result("a@x.com"),
        result("b@x.com", InviteMemberStatus.Failed),
      ],
    });

    expect(outcome.status).not.toBe("partial");
    expect(outcome.status).toBe("failed");
  });

  it("accepts a tally that agrees with its rows", () => {
    // The reconciliation must not reject the shipped route, which derives
    // `invited` from these same rows (apps/api .../invitations/service.ts).
    expect(
      foldInviteOutcome({
        invited: 1,
        results: [
          result("a@x.com"),
          result("b@x.com", InviteMemberStatus.AlreadyMember),
        ],
      })
    ).toEqual({ status: "partial", invited: 1, alreadyMember: 1, failed: 0 });
  });

  it("counts the invited rows when a peer omits the invited tally", () => {
    const outcome = foldInviteOutcome({
      results: [result("a@x.com"), result("b@x.com")],
    } as Parameters<typeof foldInviteOutcome>[0]);

    expect(outcome).toEqual({ status: "sent", invited: 2 });
  });

  it("always carries a message on a failure, even when the peer sends none", () => {
    const outcome = foldInviteOutcome({
      invited: 0,
      results: [result("a@x.com", InviteMemberStatus.Failed)],
    });

    if (outcome.status !== "failed") {
      throw new Error("expected a failure");
    }
    // Without a message the step renders no alert and no error at all — the
    // Send button just re-enables, which reads as "nothing happened".
    expect(outcome.message).toBeTruthy();
  });

  it("refuses to call an outcome-free response a send", () => {
    const outcome = foldInviteOutcome({ invited: 0, results: [] });

    expect(outcome.status).toBe("failed");
  });
});

function result(
  email: string,
  status: InviteMemberStatus = InviteMemberStatus.Invited
): InviteMemberResult {
  return { email, status };
}
