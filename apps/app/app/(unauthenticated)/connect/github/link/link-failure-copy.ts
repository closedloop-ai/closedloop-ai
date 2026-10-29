import type { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { GitHubAccessDenialReason as GitHubAccessDenialReasonValue } from "@repo/api/src/types/github";

/**
 * ISS-10411 acceptance: "If device login succeeds but GitHub authorization
 * actually fails, clearly distinguish those outcomes." The user arrives here
 * straight out of a device authorization, so every failure sentence opens by
 * naming which half survived — without it the screen reads as though the
 * Closedloop sign-in failed too.
 */
export const SIGN_IN_INTACT_SENTENCE =
  "You're signed in to Closedloop — this is only about connecting GitHub.";

/**
 * The pre-flight ceiling: Clerk's client never loaded, so the start effect
 * never ran. Deliberately WITHOUT {@link SIGN_IN_INTACT_SENTENCE} — this is the
 * one failure state reached before `isLoaded`, so whether the Closedloop
 * sign-in survived is precisely the fact this screen does not have.
 */
export const PREFLIGHT_TIMEOUT_DESCRIPTION =
  "We couldn't start the GitHub connection. Try again.";

/**
 * Which round trip the page is waiting on. Decided synchronously, before the
 * first await, from whether Clerk already holds a verified GitHub account — so
 * within one mount it never changes: the GitHub hand-off ends by navigating
 * away, and the sync leg is reached only on the fresh mount after the return.
 */
export const PendingLeg = {
  /** `createExternalAccount` — the GitHub authorize hand-off. */
  GitHub: "github",
  /** `POST /integrations/github/clerk-link` — GitHub already answered. */
  ServerSync: "server_sync",
} as const;
export type PendingLeg = (typeof PendingLeg)[keyof typeof PendingLeg];

/**
 * The in-flight deadline expired with a request still outstanding — the page
 * itself stopped waiting. Reserved for that one state: a request that THREW
 * renders {@link LINK_THREW_DESCRIPTION} for the same leg instead (ISS-11244),
 * because a refusal is not a deadline and must not claim we stopped waiting.
 *
 * ISS-10411: keyed by the leg that was actually outstanding. The page does know
 * which one — it chose the branch — so a sentence that declined to say would be
 * withholding a fact it holds, and on the desktop journey "we stopped waiting
 * for an answer" reads as though the device authorization that just SUCCEEDED
 * is the step at fault. Exhaustive over {@link PendingLeg}: a leg added later
 * fails `tsc` here rather than falling back to a step it did not run.
 */
export const REQUEST_UNANSWERED_DESCRIPTION: Record<PendingLeg, string> = {
  [PendingLeg.GitHub]: `${SIGN_IN_INTACT_SENTENCE} We stopped waiting for GitHub to answer. Try again.`,
  [PendingLeg.ServerSync]: `${SIGN_IN_INTACT_SENTENCE} GitHub authorized the connection — we stopped waiting for Closedloop to finish saving it. Try again.`,
};

/**
 * Residue: a response shape we do not recognize. ISS-11244 narrowed what reaches
 * it — a THROW is now attributed by {@link LINK_THREW_DESCRIPTION}, so this is
 * used for a returned callback error (ISS-12627), whose cause stays in the
 * operator-only report, and paths that observed an unrecognised shape: a
 * `createExternalAccount` that returned no redirect URL, and a `linked: false`
 * carrying no reason. Both are reported to `github_clerk_link_failed`.
 */
export const GENERIC_FAILURE_DESCRIPTION = `${SIGN_IN_INTACT_SENTENCE} Something interrupted the GitHub connection. Try again.`;

export const RESUME_CLAIM_FAILURE_DESCRIPTION = `${SIGN_IN_INTACT_SENTENCE} Your GitHub account is linked, but connecting the installed app didn't finish. Try again.`;

/**
 * Shown while a request is still outstanding past the pre-flight ceiling, named
 * by the leg that is outstanding (ISS-10411). Still a STALL and never a
 * refusal — nothing here observed an outcome — but which round trip has gone
 * quiet is known, so it is said. Exhaustive over {@link PendingLeg}.
 */
export const STILL_CONNECTING_DESCRIPTION: Record<PendingLeg, string> = {
  [PendingLeg.GitHub]:
    "This is taking longer than usual. We're still waiting for GitHub to authorize the connection.",
  [PendingLeg.ServerSync]:
    "This is taking longer than usual. GitHub authorized the connection — we're still saving it.",
};

/**
 * Why a linked account can still not yield a usable credential. Exhaustive
 * over the wire vocabulary so a newly added reason fails `tsc` here instead
 * of rendering an unstyled blank.
 */
export const LINK_FAILURE_DESCRIPTION: Record<
  GitHubAccessDenialReason,
  string
> = {
  [GitHubAccessDenialReasonValue.NotConnected]: `${SIGN_IN_INTACT_SENTENCE} GitHub reports no linked account for you. Try connecting again.`,
  [GitHubAccessDenialReasonValue.InsufficientScope]: `${SIGN_IN_INTACT_SENTENCE} Your GitHub grant doesn't include repository access. Approve repository access when GitHub asks, then try again.`,
  [GitHubAccessDenialReasonValue.Revoked]: `${SIGN_IN_INTACT_SENTENCE} Your GitHub authorization is no longer valid. Try connecting again.`,
  [GitHubAccessDenialReasonValue.OrgRestricted]: `${SIGN_IN_INTACT_SENTENCE} Your GitHub organization restricts this app. Ask a GitHub org owner to approve it.`,
  [GitHubAccessDenialReasonValue.NoInstallation]: `${SIGN_IN_INTACT_SENTENCE} The Closedloop GitHub App isn't installed for this organization yet.`,
  [GitHubAccessDenialReasonValue.RateLimited]: `${SIGN_IN_INTACT_SENTENCE} GitHub is rate-limiting requests right now. Try again in a few minutes.`,
  [GitHubAccessDenialReasonValue.BudgetDeferred]: `${SIGN_IN_INTACT_SENTENCE} GitHub reads are paused right now. Try again in a few minutes.`,
  [GitHubAccessDenialReasonValue.Unavailable]: `${SIGN_IN_INTACT_SENTENCE} GitHub or the credential service is unreachable. Try again in a moment.`,
  [GitHubAccessDenialReasonValue.Contention]: `${SIGN_IN_INTACT_SENTENCE} Another sync is using this GitHub connection. Try again in a moment.`,
};

/**
 * ISS-11244: a throw out of the link routine, attributed to the leg that was
 * running. Before this the whole routine shared one bare catch rendering
 * {@link GENERIC_FAILURE_DESCRIPTION}, so a refusal from Clerk read as an
 * unrecognised response shape — the least informative sentence available — on
 * the one failure where the page did know which round trip it was in.
 *
 * Neither sentence asserts a CAUSE. A throw says the round trip did not complete,
 * not why; the code that would say why is reported to `github_clerk_link_failed`
 * instead of guessed at here. Exhaustive over {@link PendingLeg}, for the same
 * reason as its siblings.
 *
 * The sync sentence says "didn't finish" rather than naming a refused save on
 * purpose: the leg is fixed before the first await, but more than the link POST
 * can throw inside it — `reauthorize()` on the narrow-scope re-link path, and
 * `completeLinkedFlow` AFTER the server already answered `linked: true`, where
 * the save provably succeeded. "Saving was refused" would be false in both, and
 * the leg is the most this sentence actually knows.
 */
export const LINK_THREW_DESCRIPTION: Record<PendingLeg, string> = {
  [PendingLeg.GitHub]: `${SIGN_IN_INTACT_SENTENCE} We couldn't start the GitHub authorization. Try again.`,
  [PendingLeg.ServerSync]: `${SIGN_IN_INTACT_SENTENCE} GitHub authorized the connection — finishing it in Closedloop didn't complete. Try again.`,
};

/**
 * Clerk error codes this page can say something true about, by `code` on the
 * rejected `ClerkAPIResponseError`.
 *
 * Deliberately NOT a `GitHubAccessDenialReason`: that union is the server's wire
 * vocabulary and is persisted in `GitHubAccessCapability.denialReason`, so a
 * browser-only Clerk condition added there would cost a migration and put a
 * value in the column no server read can ever produce.
 */
export const ClerkLinkErrorCode = {
  /**
   * `existing.destroy()` refused, so the stale unverified account the routine
   * has to clear before re-linking is still attached. ISS-11244 asked whether
   * that call can fail on its own; this is the state where it did, and it is
   * distinguishable from the hand-off never starting because the user's next
   * attempt will hit the same undeleted account.
   */
  IdentificationDeletionFailed: "identification_deletion_failed",
} as const;
export type ClerkLinkErrorCode =
  (typeof ClerkLinkErrorCode)[keyof typeof ClerkLinkErrorCode];

/**
 * Exhaustive over {@link ClerkLinkErrorCode}, so recognising a further code
 * fails `tsc` here rather than silently falling back to the leg sentence.
 *
 * A SENTENCE HERE MUST NOT REVEAL ANOTHER ACCOUNT. Recognition dispatches on the
 * Clerk code alone, with nothing establishing the reader's relationship to any
 * other account — so if the collision this ticket hypothesises (one GitHub
 * identity, two Clerk users) is classified here later, a sentence saying the
 * identity is already linked elsewhere would turn this page into an
 * account-existence oracle for any signed-in user. Keep such copy generic and
 * leave the distinguishing detail to the reported code, which only operators see.
 */
export const CLERK_LINK_ERROR_DESCRIPTION: Record<ClerkLinkErrorCode, string> =
  {
    [ClerkLinkErrorCode.IdentificationDeletionFailed]: `${SIGN_IN_INTACT_SENTENCE} We couldn't clear your previous GitHub link. Try again.`,
  };

/**
 * The reader closed Clerk's re-verification prompt, so the SSO-connection call
 * it was gating never ran again (ISS-11315, ISS-11244 AC4).
 *
 * ITS OWN CONSTANT, not a {@link ClerkLinkErrorCode} entry, because it is not a
 * Clerk API response code: `useReverification` rejects with a
 * `ClerkRuntimeError` carrying `reverification_cancelled`
 * (`@clerk/shared@4.8.3` `dist/runtime/react/index.mjs:1930`), and
 * {@link CLERK_LINK_ERROR_DESCRIPTION} is keyed by `errors[].code` off a
 * `ClerkAPIResponseError`. Putting it there would key a runtime error by a
 * vocabulary it does not belong to.
 *
 * Wrapping the SSO-connection calls is what MADE this reachable — before it,
 * a challenge failed outright and no prompt existed to dismiss — so it is
 * classified in the same change. It names the dismissal and stays retryable:
 * the panel's "Try again" re-runs the call, which raises the prompt again, and
 * that is a path the reader can actually complete. Falling through to the leg
 * sentence would tell someone who chose to close a prompt only that the round
 * trip did not finish, which is the residue-adjacent outcome ISS-11244 AC4
 * exists to prevent.
 */
export const REVERIFICATION_CANCELLED_DESCRIPTION = `${SIGN_IN_INTACT_SENTENCE} Verification was dismissed, so GitHub wasn't connected. Try again to finish.`;
