import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  LinearDisconnectResponse,
  LinearIntegrationStatus,
} from "@repo/api/src/types/linear";
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
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, _request, _params, receipts) => {
      try {
        await linearService.disconnect(
          user.organizationId,
          recordOrganizationWrite(receipts)
        );
        // ISS-12552: with no integration to disconnect nothing is written.
        await recordNoOpUnlessRecorded(receipts);
        return successResponse(
          withOperationReceipt({ disconnected: true }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to disconnect Linear", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
