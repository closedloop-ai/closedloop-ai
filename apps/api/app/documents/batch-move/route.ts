import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
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
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { batchMoveDocumentsValidator } from "../validators";

/**
 * POST /documents/batch-move
 * Move multiple documents to a target project atomically.
 * Accepts an array of document IDs and a target project ID.
 *
 * DOC-36 R15 makes this route the bulk change-project implementation and R16
 * assigns that action the `write` scope. Declared below rather than left to
 * `withAnyAuth`'s method-inferred default, which resolves to the same value:
 * an inferred default is not a stated rule. Read from the shared table rather
 * than respelled, so a later scope change cannot leave the rule and the route
 * disagreeing.
 */
export const POST = withAnyAuth<
  string[],
  typeof BatchMutationRoute.DocumentsMove
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
            const moved = await documentBatchMoveService.batchMove(
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
            return moved;
          }
        );
        if (!outcome.ok) {
          return batchSelectionErrorResponse(outcome.error);
        }
        const result = outcome.value;

        if (result.ok) {
          emitBatchMoveSideEffects({
            user,
            authMethod,
            projectChanges: result.value.projectChanges,
            transactionId,
          });
          return successResponse(result.value.movedIds);
        }

        // Same split as /artifact-links/batch-move: a missing document is 404,
        // a missing target project is 400.
        if (result.error === Status.NotFound) {
          return notFoundResponse("Document");
        }
        if (result.error === Status.BadRequest) {
          return badRequestResponse("Target project not found");
        }
        return badRequestResponse("Failed to move documents");
      } catch (error) {
        return errorResponse("Failed to move artifacts", error);
      }
    }
  ),
  {
    requiredScopes: [
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeProject],
    ],
  }
);
