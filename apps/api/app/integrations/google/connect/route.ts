import type { ConnectGoogleResponse } from "@repo/api/src/types/google";
import { organizationsService } from "@/app/organizations/service";
import { env } from "@/env";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { googleService } from "../service";
import { connectGoogleValidator } from "../validators";

/**
 * POST /integrations/google/connect
 *
 * Completes Google OAuth by exchanging the authorization code for tokens.
 * The app handles OAuth initiation and callback, then sends the code here.
 * Token exchange happens here to keep client_secret in the API only.
 */
export const POST = withAuth<
  ConnectGoogleResponse,
  "/integrations/google/connect"
>(async ({ clerkOrgId }, request) => {
  // Parse and validate request body
  const { body, errorResponse: parseError } = await parseBody(
    request,
    connectGoogleValidator
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
  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/integrations/google/callback`;

  // Complete OAuth callback using service
  const result = await googleService.completeOAuthCallback(
    body.code,
    body.codeVerifier,
    redirectUri,
    organization.id
  );

  if (!result.success) {
    return errorResponse(result.error, null, 400);
  }

  // Get the integration to return the email
  const status = await googleService.getIntegrationStatus(organization.id);

  if (!(status.success && status.connected)) {
    return errorResponse("Failed to verify Google connection", null, 500);
  }

  return successResponse({
    connected: true,
    email: status.email,
  });
});
