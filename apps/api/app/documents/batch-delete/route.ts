import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { userAuditActor } from "@/app/audit/audit-emit-service";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { batchDeleteReceiptRecorder } from "../document-delete-receipt";
import { documentService } from "../document-service";
import { batchDeleteValidator } from "../validators";

/**
 * POST /documents/batch-delete
 * Delete multiple documents and clean up their Liveblocks rooms.
 */
export const POST = withAnyAuth<
  { deletedIds: string[]; failedIds: string[] },
  typeof BatchMutationRoute.DocumentsDelete
>(
  withOperationReceipts(
    OperationKind.Delete,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchDeleteValidator
        );
        if (parseError) {
          return parseError;
        }

        // The only batch family that does NOT take the ISS-9579 selection lock.
        // `batchDelete` refuses nothing — it reports a row it could not find as a
        // `failedId` — so a row a concurrent commit removed cannot turn a
        // select-all into a refusal, and its Liveblocks room cleanup runs after
        // the delete's transaction commits and must not be pulled inside one.
        const plan = await resolveBatchSelection(body, user.organizationId);
        if (!plan.ok) {
          return batchSelectionErrorResponse(plan.error);
        }

        const result = await documentService.batchDelete(
          plan.value.documentIds,
          user.organizationId,
          userAuditActor(user.id),
          newBulkTransactionId(),
          batchDeleteReceiptRecorder(receipts)
        );

        return successResponse(result);
      } catch (error) {
        return errorResponse("Failed to delete documents", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
