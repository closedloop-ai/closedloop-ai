import type { ConnectGitHubResponse } from "@repo/api/src/types/github";
import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { organizationsService } from "@/app/organizations/service";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import type { GitHubBackfillStart } from "../backfill-service";
import { githubBackfillService } from "../backfill-service";
import { githubService } from "../service";
import { claimGitHubInstallationValidator } from "../validators";

/**
 * The post-connect backfill runs in this route's `waitUntil` lane (ISS-7408),
 * and the platform bounds that lane by the function's own ceiling rather than
 * by when the response was sent. Undeclared, the sweep would be killed at the
 * default mid-run — invisibly, since nobody is waiting on it any more.
 */
export const maxDuration = 300;

/**
 * POST /integrations/github/connect
 *
 * Claims a GitHub App installation for the caller's organization and syncs
 * its repositories (PLN-1742 M5). The installation is verified through the
 * App's own JWT — there is no OAuth code exchange and no stored user token;
 * user credentials come exclusively from Clerk linking.
 */
export const POST = withAuth<
  ConnectGitHubResponse,
  "/integrations/github/connect"
>(async ({ clerkOrgId, user }, request) => {
  // Parse and validate request body
  const { body, errorResponse: parseError } = await parseBody(
    request,
    claimGitHubInstallationValidator
  );

  if (parseError) {
    return parseError;
  }

  // Find the organization
  const organization = await organizationsService.findByClerkId(clerkOrgId);

  if (!organization) {
    return errorResponse("Organization not found", null, 404);
  }

  const result = await githubService.claimGitHubInstallation({
    installationId: body.installationId,
    organizationId: organization.id,
    userId: user.id,
  });

  switch (result.status) {
    case "connected": {
      // ISS-7408: the response no longer waits on a bounded first slice. That
      // slice swept one repository end to end — 32s avg, 70s p95 on the OAuth
      // callback the user is sitting on — and then the lane below swept the
      // same repository again. Its only output was a status word that
      // `GET /integrations/github/backfill` reports either way.
      // The durable claim is awaited; only the sweep goes to `waitUntil`. The
      // claim is what makes the status surface report `running`, so a response
      // sent ahead of it would let the client's first poll read a stale
      // terminal status and stop (ISS-7408).
      let start: GitHubBackfillStart;
      try {
        start = await githubBackfillService.startPostConnectBackfill({
          organizationId: organization.id,
          approvedForVisibleWrites: true,
          bypassCooldown: true,
        });
      } catch (error) {
        // The installation is ALREADY claimed by this point. Letting this throw
        // would answer a successful connect with a 500 the callback renders as
        // "connection failed", for an org that is in fact connected (#5689
        // review) — the same shape the deleted `runBoundedFirstSlice` guarded
        // with its own try/catch. The backfill is what degraded, not the
        // connection, so the response says exactly that.
        log.error("github.connect.backfill_claim_failed", {
          error,
          organizationId: organization.id,
        });
        return successResponse({
          connected: true,
          backfill: { status: GitHubBackfillStatus.Degraded },
        });
      }
      if (start.claimed) {
        waitUntil(
          start.completion.catch((error: unknown) => {
            log.error("github.connect.background_backfill_failed", {
              error,
              organizationId: organization.id,
            });
          })
        );
      }
      // Unclaimed means a run is already sweeping for this org, which is the
      // same answer from the caller's side: a backfill is running.
      return successResponse({
        connected: true,
        backfill: { status: GitHubBackfillStatus.Running },
      });
    }
    case "requires_confirmation":
      return successResponse({
        connected: false,
        status: "requires_confirmation",
        priorAccount: result.priorAccount,
        newAccount: result.newAccount,
        newInstallationId: result.newInstallationId,
      });
    default:
      // The claim's machine-readable code (currently only `link_required`)
      // rides the failure body so the web callback can route the caller to
      // the fix instead of a generic error. Optional and additive — an older
      // client that ignores it still renders `result.error`.
      return errorResponse(
        result.error,
        null,
        400,
        result.code ? { code: result.code } : undefined
      );
  }
});
