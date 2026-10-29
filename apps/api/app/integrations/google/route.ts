import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  GoogleDisconnectResponse,
  GoogleIntegrationStatus,
} from "@repo/api/src/types/google";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";

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
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, _request, _params, receipts) => {
      try {
        await googleService.disconnect(
          user.organizationId,
          recordOrganizationWrite(receipts)
        );
        // ISS-12552: with no integration to disconnect nothing is written.
        await recordNoOpUnlessRecorded(receipts);
        return successResponse(
          withOperationReceipt({ disconnected: true }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to disconnect Google integration", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
