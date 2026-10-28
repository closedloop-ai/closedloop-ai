import type { GitHubClerkLinkClientFailureReport } from "@repo/api/src/types/github";
import { GitHubClerkLinkClientFailureStage } from "@repo/api/src/types/github";
import { readClerkErrorCode } from "./clerk-error-code";

/**
 * ISS-11315: what a refused `signIn.sso` on `/connect/github` is worth
 * recording.
 *
 * This is the SIGN-UP hand-off leg, and until now it discarded its refusal
 * entirely: the start effect's `fail` took no argument, so `result.error` and a
 * rejection were both dropped on the floor and the screen rendered one
 * leg-agnostic sentence with nothing emitted anywhere. That is the identical
 * defect ISS-11244 closed on the sibling signed-in link leg, left open on the
 * half a NEW user meets first — which is why a production recording of desktop
 * onboarding locking (2026-09-27, Closedloop 0.17.239-universal) could show
 * that the hand-off was REFUSED and could not say by what.
 *
 * `sso()` reports failure two ways — as a `{ error }` VALUE and by rejecting —
 * and both are classified here so the record does not depend on which path
 * Clerk took.
 */
export function classifySsoRefusal(
  error: unknown
): GitHubClerkLinkClientFailureReport {
  const report: GitHubClerkLinkClientFailureReport = {
    stage: GitHubClerkLinkClientFailureStage.SignUpHandoffRefused,
  };
  const code = readClerkErrorCode(error);
  if (code !== null) {
    report.clerkErrorCode = code;
  }
  return report;
}
