import type { ConnectGitHubResponse } from "@repo/api/src/types/github";
import { organizationsService } from "@/app/organizations/service";
import { env } from "@/env";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
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

  if (!result.success) {
    return errorResponse(result.error, null, 400);
  }

  return successResponse({
    connected: true,
  });
});
