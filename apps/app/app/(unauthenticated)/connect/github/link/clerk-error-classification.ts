import type { GitHubClerkLinkClientFailureReport } from "@repo/api/src/types/github";
import { GitHubClerkLinkClientFailureStage } from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import { isReverificationCancelledError } from "@repo/auth/errors";
import { readClerkErrorCode } from "../clerk-error-code";
import {
  CLERK_LINK_ERROR_DESCRIPTION,
  type ClerkLinkErrorCode,
  GENERIC_FAILURE_DESCRIPTION,
  LINK_THREW_DESCRIPTION,
  type PendingLeg,
  REQUEST_UNANSWERED_DESCRIPTION,
  REVERIFICATION_CANCELLED_DESCRIPTION,
} from "./link-failure-copy";

/**
 * ISS-11244: what a throw out of the link routine is worth saying about.
 *
 * The bare `startLink().catch(() => fail(GENERIC_FAILURE_DESCRIPTION))` this
 * replaces discarded the thrown value without looking at it, so every refusal
 * from `existing.destroy()`, `user.createExternalAccount()` and the link POST
 * rendered one leg-agnostic sentence and left no artifact anywhere. Clerk
 * rejects with a `ClerkAPIResponseError` whose `errors[].code` is the only
 * thing that names WHICH refusal happened — and that code was the value being
 * thrown away, which is why the failure could not be diagnosed from outside
 * the reporter's browser.
 *
 * ISS-11315 moved the schema itself to {@link readClerkErrorCode}, one
 * directory up: the sign-up hand-off leg needs the same extraction, and two
 * copies of a wire-shape parser is the SSOT drift this repo names by hand.
 */

export type ClerkLinkThrowClassification = {
  /** What the failure panel says. Never the unrecognised-residue sentence. */
  readonly description: string;
  /**
   * What reaches the monitor. Carried for a RECOGNISED code too, not only the
   * tail: the monitor's value here is the distribution — which codes reach real
   * users and how often — and a classified sentence is not evidence that the
   * code was expected.
   */
  readonly report: GitHubClerkLinkClientFailureReport;
};

/**
 * Turn an unknown thrown value into the sentence to render and the record to
 * report. The leg is the fallback axis because it is a fact the page provably
 * holds: it chose the branch before the first await, which is the same reason
 * {@link LINK_THREW_DESCRIPTION}'s sibling `REQUEST_UNANSWERED_DESCRIPTION`
 * already names the leg on a timeout. A throw is therefore never left
 * unattributed, whether or not Clerk named a code.
 *
 * `ApiError` IS TESTED FIRST, AND THAT ORDER IS LOAD-BEARING. The sync leg's
 * `apiClient.post` carries its own `DEFAULT_API_TIMEOUT_MS` deadline, armed
 * inside the effect body — before React can commit the `InFlight` state that
 * schedules the page's own equal-length timer — so on a hung request the
 * client's deadline always rejects first and the page's
 * {@link REQUEST_UNANSWERED_DESCRIPTION} path never runs. Reaching the Clerk
 * schema with it would render "didn't complete" for a request the CLIENT
 * abandoned: a Closedloop-side deadline told as a GitHub-side refusal, which is
 * the exact conflation this ticket exists to remove. `ApiError` also carries no
 * `errors[]` array at all, so without this arm every sync-leg throw — a
 * timeout, an expired session, a refused POST — reported one codeless record.
 */
export function classifyLinkThrow(
  error: unknown,
  leg: PendingLeg
): ClerkLinkThrowClassification {
  if (error instanceof ApiError) {
    return classifyApiError(error, leg);
  }
  // ISS-11315: a dismissed re-verification prompt. `useReverification` rejects
  // with a `ClerkRuntimeError` carrying `reverification_cancelled` rather than
  // a Clerk API response (`@clerk/shared@4.8.3`
  // `dist/runtime/react/index.mjs:1930`), so it is recognised by the SDK's own
  // predicate and never by a code lookup.
  //
  // It gets its OWN sentence, not the leg one. The page knows more here than
  // "the round trip did not finish" — it knows the reader closed a prompt —
  // and withholding that leaves someone who made a deliberate choice reading
  // the residue-adjacent sentence ISS-11244 AC4 exists to prevent. Recorded
  // apart too: "the user changed their mind" and "Clerk refused" are different
  // facts, and the monitor is where that difference is read.
  if (isReverificationCancelledError(error)) {
    return {
      description: REVERIFICATION_CANCELLED_DESCRIPTION,
      report: {
        stage: GitHubClerkLinkClientFailureStage.ReverificationCancelled,
      },
    };
  }
  const code = readClerkErrorCode(error);
  if (error instanceof ClerkLinkVerificationError) {
    return {
      description: GENERIC_FAILURE_DESCRIPTION,
      report: {
        stage: GitHubClerkLinkClientFailureStage.Threw,
        ...(code === null ? {} : { clerkErrorCode: code }),
      },
    };
  }
  if (code === null) {
    return {
      description: LINK_THREW_DESCRIPTION[leg],
      report: { stage: GitHubClerkLinkClientFailureStage.Threw },
    };
  }
  const recognized = isRecognizedClerkLinkErrorCode(code)
    ? CLERK_LINK_ERROR_DESCRIPTION[code]
    : null;
  return {
    description: recognized ?? LINK_THREW_DESCRIPTION[leg],
    report: {
      clerkErrorCode: code,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    },
  };
}

/**
 * Clerk types `ClerkAPIError.code` as an open `string` and ships no exhaustive
 * list, so this is a RECOGNITION test and never a closed union over Clerk's
 * vocabulary. A code outside it is not an error to swallow — it renders the
 * leg-named sentence and is reported verbatim.
 */
function isRecognizedClerkLinkErrorCode(
  code: string
): code is ClerkLinkErrorCode {
  return Object.hasOwn(CLERK_LINK_ERROR_DESCRIPTION, code);
}

/**
 * A throw from the shared API client, which is the only thing on either leg
 * that reaches this page as an `ApiError`.
 *
 * A client-side deadline keeps the page's own stopped-waiting sentence: the
 * request was abandoned here, the server may well have finished it, and
 * `ApiError`'s own `getFriendlyError` states that same distinction for the same
 * reason. Everything else gets the leg sentence, which claims only that the
 * round trip did not complete.
 *
 * The record is emitted EITHER WAY, with the code that separates them. A
 * timeout the user is correctly told about is still a customer who could not
 * connect, and a report is the only artifact this leg leaves when the page
 * stops waiting before the server ever answers.
 */
function classifyApiError(
  error: ApiError,
  leg: PendingLeg
): ClerkLinkThrowClassification {
  const report: GitHubClerkLinkClientFailureReport = {
    apiErrorStatus: error.status,
    stage: GitHubClerkLinkClientFailureStage.Threw,
  };
  if (error.code !== undefined) {
    report.apiErrorCode = error.code;
  }
  return {
    description: error.isTimeout()
      ? REQUEST_UNANSWERED_DESCRIPTION[leg]
      : LINK_THREW_DESCRIPTION[leg],
    report,
  };
}

/** ISS-12627: keep a callback refusal on the existing classified throw path. */
export class ClerkLinkVerificationError extends Error {
  readonly errors: unknown[];

  constructor(error: unknown) {
    super("GitHub external-account verification failed");
    this.errors = [error];
  }
}
