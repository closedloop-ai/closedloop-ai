import type { GitHubClerkLinkClientFailureResponse } from "@repo/api/src/types/github";
import { recordClerkLinkClientFailure } from "@/app/integrations/github/clerk-link-service";
import { reportGitHubClerkLinkClientFailureValidator } from "@/app/integrations/github/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseBody, successResponse } from "@/lib/route-utils";

/**
 * POST /integrations/github/clerk-link/client-failure
 *
 * ISS-11244: records a link failure only the browser observed, into the existing
 * `github_clerk_link_failed` monitor. The GitHub hand-off leg
 * (`user.createExternalAccount`, `existing.destroy()`) never reaches this API,
 * so a refusal there left no artifact anywhere — the user saw an unrecognised-
 * shape sentence and nothing was emitted.
 *
 * ISS-11315 added the SIGN-UP hand-off leg to the same monitor
 * (`signup_handoff_refused`): `/connect/github`'s `signIn.sso` was discarding
 * its refusal the same way, on the half of the journey a new user meets first.
 * One monitor rather than two, because the question an operator asks is "could
 * this person connect GitHub" and splitting the answer by route hides half of
 * it. That leg can be reached by a browser with no usable session, and this
 * route is `withAnyAuth` — such a report is refused and lost, which is the
 * accepted cost of not opening an unauthenticated write on the auth boundary.
 *
 * Deliberately separate from `POST /integrations/github/clerk-link` rather than a
 * flag on it: that route RESOLVES the caller's GitHub identity and kicks a
 * post-connect sync, neither of which a failed hand-off has any business doing.
 *
 * Records and nothing else, so the reporting browser is already on its terminal
 * failure panel and has nothing to do with the answer.
 */
export const POST = withAnyAuth<
  GitHubClerkLinkClientFailureResponse,
  "/integrations/github/clerk-link/client-failure"
>(async ({ user }, request) => {
  const { body, errorResponse } = await parseBody(
    request,
    reportGitHubClerkLinkClientFailureValidator
  );
  if (errorResponse) {
    return errorResponse;
  }
  recordClerkLinkClientFailure({
    apiErrorCode: body.apiErrorCode,
    apiErrorStatus: body.apiErrorStatus,
    clerkErrorCode: body.clerkErrorCode,
    organizationId: user.organizationId,
    stage: body.stage,
    userId: user.id,
  });
  return successResponse({ recorded: true });
});
