import type { ConnectGitHubResponse } from "@repo/api/src/types/github";
import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { waitUntil } from "@vercel/functions";
import { organizationsService } from "@/app/organizations/service";
import { env } from "@/env";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { githubBackfillService } from "../backfill-service";
import { githubService } from "../service";
import { connectGitHubValidator } from "../validators";

/**
 * POST /integrations/github/connect
 *
 * Completes GitHub OAuth by exchanging the authorization code for a user access token,
 * verifying user access to the installation, claiming the installation, and syncing repositories.
 * The app handles OAuth initiation and callback, then sends the code here.
 * Token exchange happens here to keep client_secret in the API only.
 */
export const POST = withAuth<
  ConnectGitHubResponse,
  "/integrations/github/connect"
>(async ({ clerkOrgId, user }, request) => {
  // Parse and validate request body
  const { body, errorResponse: parseError } = await parseBody(
    request,
    connectGitHubValidator
  );

  if (parseError) {
    return parseError;
  }

  // Find the organization
  const organization = await organizationsService.findByClerkId(clerkOrgId);

  if (!organization) {
    return errorResponse("Organization not found", null, 404);
  }

  // Build redirect URI (must match what was used in OAuth initiation)
  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/github/callback`;

  // Complete OAuth callback using service
  const result = await githubService.completeOAuthCallback(
    body.code,
    body.installationId,
    redirectUri,
    organization.id,
    user.id
  );

  switch (result.status) {
    case "connected": {
      const backfillStatus = await runBoundedFirstSlice(organization.id);
      waitUntil(
        githubBackfillService
          .runPostConnectBackfill({
            organizationId: organization.id,
            approvedForVisibleWrites: true,
            bypassCooldown: true,
          })
          .catch(() => undefined)
      );
      return successResponse({
        connected: true,
        backfill: { status: backfillStatus },
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
      return errorResponse(result.error, null, 400);
  }
});

async function runBoundedFirstSlice(
  organizationId: string
): Promise<GitHubBackfillStatus> {
  try {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId,
      approvedForVisibleWrites: true,
      repositoryLimit: 1,
    });
    return summary.status === GitHubBackfillStatus.Degraded
      ? GitHubBackfillStatus.Degraded
      : GitHubBackfillStatus.FirstSliceStarted;
  } catch {
    return GitHubBackfillStatus.Degraded;
  }
}
