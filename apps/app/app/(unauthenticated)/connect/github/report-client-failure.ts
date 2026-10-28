import type {
  GitHubClerkLinkClientFailureReport,
  GitHubClerkLinkClientFailureResponse,
} from "@repo/api/src/types/github";
import type { useApiClient } from "@repo/app/shared/api/use-api-client";

/** The one route both connect legs report a browser-only failure to. */
const CLIENT_FAILURE_PATH = "/integrations/github/clerk-link/client-failure";

/**
 * ISS-11244: hand a failure only this browser observed to the existing
 * `github_clerk_link_failed` monitor. Fire-and-forget by construction — the
 * caller is already rendering its terminal failure panel, so the report's own
 * outcome changes nothing it shows, and a swallowed rejection here is the one
 * case where that is correct rather than lazy. `no-client-debug-logging`
 * (rightly) forbids logging it in the browser instead.
 *
 * ISS-11315 lifted it out of the link client so the sign-up hand-off leg
 * reports through the SAME helper and the same route rather than growing a
 * second reporter. The route is `withAnyAuth`, so an unauthenticated report is
 * REFUSED and lost.
 *
 * ON THE SIGN-UP LEG THAT IS MOST OF THEM, and an earlier draft of this comment
 * said the opposite (ISS-11315 review, tamsinb). A browser arriving at
 * `/connect/github` to sign UP is usually signed out: `useApiClient` sends no
 * bearer, `withAnyAuth` falls through to `withAuth`, and the POST is a 401 this
 * helper swallows. The refusals that DO get recorded from here are the ones
 * Clerk raises about an existing client session — `session_exists` and its
 * neighbours — so read a gap in this monitor as "no signed-in browser observed
 * one", never as "no refusals happened".
 *
 * Kept that way on purpose: an unauthenticated write endpoint on the auth
 * boundary is a bigger cost than a lost diagnostic, and opening one is a call
 * for a human rather than a consequence of wanting better coverage. What is
 * pinned instead is the DEGRADATION — a refused report leaves the caller's
 * terminal panel intact (`github-connect-redirect-client.test.tsx`).
 */
export function reportClientFailure(
  apiClient: ReturnType<typeof useApiClient>,
  report: GitHubClerkLinkClientFailureReport
): void {
  try {
    apiClient
      .post<GitHubClerkLinkClientFailureResponse>(CLIENT_FAILURE_PATH, report)
      .catch(() => {
        // Intentionally silent: an async rejection is a lost diagnostic.
      });
  } catch {
    // A SYNCHRONOUS throw, not a rejection — a client that refuses before it
    // returns a promise. Contained here so it cannot escape into the caller's
    // render path; the caller has already told the user what failed.
  }
}
