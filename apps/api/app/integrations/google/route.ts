import type {
  GoogleDisconnectResponse,
  GoogleIntegrationStatus,
} from "@repo/api/src/types/google";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import { errorResponse, successResponse } from "@/lib/route-utils";
import { googleService } from "./service";

/**
 * GET /integrations/google
 *
 * Get the Google integration status for the current organization.
 * Returns connection status and user email.
 */
export const GET = withAnyAuth<GoogleIntegrationStatus, "/integrations/google">(
  async ({ user }) => {
    try {
      const result = await googleService.getIntegrationStatus(
        user.organizationId
      );

      if (result.success && result.connected) {
        return successResponse({
          connected: true,
          email: result.email,
        });
      }

      return successResponse({
        connected: false,
        email: null,
      });
    } catch (error) {
      return errorResponse("Failed to get Google integration status", error);
    }
  }
);

/**
 * DELETE /integrations/google
 *
 * Disconnect the Google integration for the current organization.
 * Revokes the access token and deletes the integration record.
 */
export const DELETE = withAnyAuth<
  GoogleDisconnectResponse,
  "/integrations/google"
>(
  async ({ user }) => {
    try {
      await googleService.disconnect(user.organizationId);
      return successResponse({ disconnected: true });
    } catch (error) {
      return errorResponse("Failed to disconnect Google integration", error);
    }
  },
  { requiredScopes: ["delete"] }
);
