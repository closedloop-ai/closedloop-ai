import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { userAuditActor } from "@/app/audit/audit-emit-service";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody } from "@/lib/route-utils";
import { batchDeleteReceiptRecorder } from "../../document-delete-receipt";
import { documentService } from "../../document-service";
import { batchDeleteValidator } from "../../validators";
import { batchDeleteResultsById } from "./batch-delete-results";

/**
 * POST /documents/batch-delete/v2 — the v1 request body, answered with one
 * result per distinct requested document id (ISS-9464). v1 is unchanged.
 *
 * The delete itself already commits partially, so this needs no service of its
 * own: it relabels v1's `{ deletedIds, failedIds }` as per-item results, where
 * a `failedId` is an id that did not resolve in the caller's org.
 */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/documents/batch-delete/v2"
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

        // As v1: no selection lock, because this family reports rather than
        // refuses and its room cleanup runs after the delete commits.
        const plan = await resolveBatchSelection(body, user.organizationId);
        if (!plan.ok) {
          return batchSelectionErrorResponse(plan.error);
        }

        const transactionId = newBulkTransactionId();
        const { deletedIds, failedIds } = await documentService.batchDelete(
          plan.value.documentIds,
          user.organizationId,
          userAuditActor(user.id),
          transactionId,
          batchDeleteReceiptRecorder(receipts)
        );

        return batchMutationResponse(
          orderBatchResults(
            plan.value.documentIds,
            batchDeleteResultsById(deletedIds, failedIds)
          ),
          transactionId
        );
      } catch (error) {
        return errorResponse("Failed to delete documents", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
