import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { recordOrganizationWrite } from "@/lib/organization-write-receipt";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../service";

/**
 * DELETE /compute-targets/:id
 * Deletes a user-owned compute target.
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/compute-targets/[id]">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, _request, params, receipts) => {
      try {
        const { id } = await params;
        const deleted = await computeTargetsService.deleteOwned(
          id,
          user.organizationId,
          user.id,
          recordOrganizationWrite(receipts)
        );
        if (!deleted) {
          return notFoundResponse("Compute target");
        }

        relayEventBus.closeTargetConnections(id);

        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete compute target", error);
      }
    }
  )
);
