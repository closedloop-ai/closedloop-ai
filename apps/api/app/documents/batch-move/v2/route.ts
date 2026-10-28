import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
  withLockedBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { batchMoveReceiptRecorder } from "@/app/documents/document-batch-move-receipts";
import { documentBatchMoveService } from "@/app/documents/document-batch-move-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  captureBatchMoveActivity,
  emitBatchMoveSideEffects,
} from "@/lib/batch-move-side-effects";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
} from "@/lib/route-utils";
import { batchMoveDocumentsValidator } from "../../validators";

/**
 * POST /documents/batch-move/v2 — the v1 request body, answered with one result
 * per distinct requested document id (ISS-9464). v1 is unchanged.
 *
 * A missing id no longer refuses the batch: the documents that were found move,
 * and the rest come back `artifacts_not_found`. A target project outside the
 * caller's org fails every item the same way, so it stays a 400 envelope.
 *
 * Same credentials and scope as v1: a Clerk session, a Desktop session, or an
 * API key with the DOC-36 R16 change-project scope (ISS-11409).
 */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/documents/batch-move/v2"
>(
  withOperationReceipts(
    OperationKind.Move,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchMoveDocumentsValidator
        );
        if (parseError) {
          return parseError;
        }

        const plan = await resolveBatchSelection(body, user.organizationId);
        if (!plan.ok) {
          return batchSelectionErrorResponse(plan.error);
        }

        const transactionId = newBulkTransactionId();
        const recordReceipts = batchMoveReceiptRecorder(receipts);
        // ISS-10993: the move and its activity receipt share ONE transaction.
        // `withDb.tx` joins an ambient transaction, so the service's own
        // `withDb.tx` runs on this one and a receipt that cannot be written rolls
        // the move back with it. ISS-9579 puts the selection lock on that same
        // transaction, ahead of the service call.
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const moved = await documentBatchMoveService.batchMovePerItem(
              documentIds,
              body.targetProjectId,
              user.organizationId
            );
            if (moved.ok) {
              await captureBatchMoveActivity(tx, {
                user,
                authMethod,
                projectChanges: moved.value.projectChanges,
                transactionId,
              });
              await recordReceipts?.(tx, moved.value.projectChanges);
            }
            return { documentIds, moved };
          }
        );
        if (!outcome.ok) {
          return batchSelectionErrorResponse(outcome.error);
        }
        const { documentIds, moved: result } = outcome.value;

        if (result.ok) {
          // As v1, and only the rows that committed are in `projectChanges`.
          emitBatchMoveSideEffects({
            user,
            authMethod,
            projectChanges: result.value.projectChanges,
            transactionId,
          });
          return batchMutationResponse(
            orderBatchResults(documentIds, result.value.results),
            transactionId
          );
        }

        if (result.error === Status.BadRequest) {
          return badRequestResponse("Target project not found");
        }
        return errorResponse("Failed to move documents", result.error);
      } catch (error) {
        return errorResponse("Failed to move documents", error);
      }
    }
  ),
  {
    requiredScopes: [
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeProject],
    ],
  }
);
