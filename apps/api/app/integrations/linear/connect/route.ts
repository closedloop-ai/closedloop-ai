import type { ConnectLinearResponse } from "@repo/api/src/types/linear";
import { organizationsService } from "@/app/organizations/service";
import { env } from "@/env";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { linearService } from "../service";
import { connectLinearValidator } from "../validators";

/**
 * POST /integrations/linear/connect
 *
 * Completes Linear OAuth by exchanging the authorization code for tokens.
 * The app handles OAuth initiation and callback, then sends the code here.
 * Token exchange happens here to keep client_secret in the API only.
 */
export const POST = withAuth<
  ConnectLinearResponse,
  "/integrations/linear/connect"
>(async ({ clerkOrgId, clerkUserId }, request) => {
  // Parse and validate request body
  const { body, errorResponse: parseError } = await parseBody(
    request,
    connectLinearValidator
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
  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/linear/callback`;

  // Complete OAuth callback using service
  const result = await linearService.completeOAuthCallback(
    body.code,
    body.codeVerifier,
    redirectUri,
    organization.id,
    clerkUserId
  );

  if (!result.success) {
    return errorResponse(result.error, null, 400);
  }

  // Get the integration to return the organization name
  const status = await linearService.getIntegrationStatus(organization.id);

  if (!(status.success && status.connected)) {
    return errorResponse("Failed to verify Linear connection", null, 500);
  }

  return successResponse({
    connected: true,
    organizationName: status.organizationName,
  });
});
