import type {
  LinearDisconnectResponse,
  LinearIntegrationStatus,
} from "@repo/api/src/types/linear";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import { errorResponse, successResponse } from "@/lib/route-utils";
import { linearService } from "./service";

/**
 * GET /integrations/linear
 *
 * Get the Linear integration status for the current organization.
 * Returns connection status, organization name, and available teams.
 */
export const GET = withAnyAuth<LinearIntegrationStatus, "/integrations/linear">(
  async ({ user }) => {
    try {
      const result = await linearService.getIntegrationStatus(
        user.organizationId
      );
      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to get Linear integration status", error);
    }
  }
);

/**
 * DELETE /integrations/linear
 *
 * Disconnect the Linear integration for the current organization.
 * Revokes the access token and deletes the integration record.
 */
export const DELETE = withAnyAuth<
  LinearDisconnectResponse,
  "/integrations/linear"
>(
  async ({ user }) => {
    try {
      await linearService.disconnect(user.organizationId);
      return successResponse({ disconnected: true });
    } catch (error) {
      return errorResponse("Failed to disconnect Linear", error);
    }
  },
  { requiredScopes: ["delete"] }
);
