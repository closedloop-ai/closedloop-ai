import {
  type InviteMemberResult,
  InviteMemberStatus,
  type InviteMembersResponse,
} from "@repo/api/src/types/onboarding";
import {
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
} from "../components/guided-onboarding-data";

/**
 * Classify a settled invitation batch.
 *
 * The route answers 200 for every non-throwing send and reports each address
 * separately, so "did it work" has four answers, not two. The one that bites is
 * `already_member`: it is neither an invite nor a failure, so a check that only
 * looks for `failed` reads a batch that invited NOBODY as a clean send.
 * `InviteTeamDialog` already guards that with `invited === 0`; this fold keeps
 * the same rule and additionally separates the mixed case, because a send that
 * invited two of five people is not a send of five.
 *
 * Every variant carries its own counts so the copy above it can never reach for
 * the number of addresses the user typed.
 */
export function foldInviteOutcome(
  response: InviteMembersResponse
): OnboardingInviteOutcome {
  const results = response.results ?? [];
  if (results.length === 0) {
    // No per-email outcome at all. The composer will not submit an empty batch,
    // so this is a contract violation rather than a send — refuse to call it
    // sent rather than reporting `invited: 0` as success.
    return {
      failed: 0,
      message: NO_OUTCOME_MESSAGE,
      status: OnboardingInviteStatus.Failed,
    };
  }

  const alreadyMember = countBy(results, InviteMemberStatus.AlreadyMember);
  const failed = countBy(results, InviteMemberStatus.Failed);
  // The rows are the evidence; `response.invited` is a summary of them. Count
  // the rows rather than trusting the summary, so the number rendered is one
  // this build can point at an address for. A peer that omits the field is
  // then just a peer whose summary we never needed.
  const invited = countBy(results, InviteMemberStatus.Invited);

  // Reconcile against the rows themselves. A newer peer can emit a status this
  // build has never heard of, and an unaccounted row must not be absorbed into
  // whichever bucket happens to be non-zero — that is how "no new invitations
  // needed" gets said about a batch that invited people.
  const unaccounted = results.length - invited - alreadyMember - failed;
  // A summary that contradicts its own rows means one of the two is wrong and
  // nothing here can say which, so neither number is reportable. Today's route
  // derives the tally from these same rows, so this can only fire on a peer
  // that disagrees with itself.
  const tallyDisagrees =
    Number.isFinite(response.invited) && response.invited !== invited;
  if (unaccounted > 0 || tallyDisagrees) {
    return {
      failed: 0,
      message: UNRECOGNIZED_OUTCOME_MESSAGE,
      status: OnboardingInviteStatus.Failed,
    };
  }

  if (invited > 0 && alreadyMember === 0 && failed === 0) {
    return { invited, status: OnboardingInviteStatus.Sent };
  }
  if (invited > 0) {
    return {
      alreadyMember,
      failed,
      invited,
      status: OnboardingInviteStatus.Partial,
    };
  }
  if (failed > 0) {
    return {
      failed,
      message: firstReason(results),
      status: OnboardingInviteStatus.Failed,
    };
  }
  if (alreadyMember > 0) {
    return { alreadyMember, status: OnboardingInviteStatus.AlreadyMember };
  }
  return {
    failed: 0,
    message: UNRECOGNIZED_OUTCOME_MESSAGE,
    status: OnboardingInviteStatus.Failed,
  };
}

/** A batch that never reached the server at all. */
export function failedInviteOutcome(message?: string): OnboardingInviteOutcome {
  return {
    status: OnboardingInviteStatus.Failed,
    failed: 0,
    message: message ?? GENERIC_FAILURE_MESSAGE,
  };
}

function countBy(
  results: readonly InviteMemberResult[],
  status: InviteMemberStatus
): number {
  return results.filter((result) => result.status === status).length;
}

/**
 * `reason` is optional in the shared contract and the two sides deploy
 * separately, so a peer can report a failure without one. A failure with no
 * message renders nothing at all, which looks like the send simply did nothing.
 */
function firstReason(results: readonly InviteMemberResult[]): string {
  const reason = results.find(
    (result) => result.status === InviteMemberStatus.Failed
  )?.reason;
  return reason ?? GENERIC_FAILURE_MESSAGE;
}

const NO_OUTCOME_MESSAGE = "No invitations were sent.";

const GENERIC_FAILURE_MESSAGE =
  "We couldn't send those invitations. Try again.";

const UNRECOGNIZED_OUTCOME_MESSAGE =
  "We couldn't confirm those invitations. Check your team list before retrying.";
