import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
  withLockedBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody } from "@/lib/route-utils";
import {
  emitBatchItemFieldEditRefusalAnalytics,
  hasBatchItemFieldEditRefusal,
} from "../../batch-field-edit-refusal-analytics";
import {
  captureBatchStatusActivity,
  emitBatchStatusSideEffects,
} from "../../batch-status-side-effects";
import {
  appliedBatchItemIds,
  batchFieldUpdateReceiptRecorder,
} from "../../document-batch-field-receipts";
import { documentStatusBatchItemService } from "../../document-status-batch-item-service";
import { validateUndoTransactionReference } from "../../document-status-mutation-service";
import { batchUpdateStatusValidator } from "../../validators";

/**
 * POST /documents/batch-update-status/v2 — the v1 request body, answered with
 * one result per distinct requested document id (ISS-9464). v1 is unchanged.
 *
 * v1 refuses the whole batch on the first problem it finds — a missing id, a
 * status its subtype cannot hold, a row that moved under an optimistic guard.
 * This commits the eligible items and reports the rest item by item, so the
 * envelope stays 200 for anything the caller could not have prevented.
 */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/documents/batch-update-status/v2"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchUpdateStatusValidator
        );
        if (parseError) {
          return parseError;
        }

        // ISS-10458 review (tamsinb, whitlockk): an undo may only name a transaction
        // this organization actually committed. Checked BEFORE the write, so a
        // bad reference costs nothing and no receipt can claim to reverse a
        // transaction that does not exist here.
        const undoReference = await validateUndoTransactionReference(
          user.organizationId,
          body.undoOfTransactionId
        );
        if (!undoReference.ok) {
          return statusMutationErrorResponse(undoReference.error);
        }

        const plan = await resolveBatchSelection(body, user.organizationId);
        if (!plan.ok) {
          return batchSelectionErrorResponse(plan.error);
        }

        const transactionId = newBulkTransactionId();
        const sideEffectInput = {
          user,
          authMethod,
          status: body.status,
          surface: body.surface,
          transactionId,
          undoOfTransactionId: body.undoOfTransactionId,
        };

        const recordReceipts = batchFieldUpdateReceiptRecorder(
          receipts,
          ArtifactFieldEditField.Status
        );
        // ISS-10993: the per-item write and its activity receipt share ONE
        // transaction. `withDb.tx` joins an ambient transaction, so the service's
        // own transactions run on this one and a receipt that cannot be written
        // rolls the committed subset back with it. ISS-9579 puts the selection
        // lock on that same transaction, ahead of the service call.
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const written =
              await documentStatusBatchItemService.batchUpdateStatus(
                documentIds,
                body.status,
                user.organizationId,
                body.expectedStatusById
              );
            await captureBatchStatusActivity(tx, {
              ...sideEffectInput,
              transitions: written.transitions,
              changedIds: written.changedIds,
            });
            await recordReceipts?.(tx, {
              appliedIds: appliedBatchItemIds(written.resultsById),
              changedIds: written.changedIds,
            });
            return { documentIds, written };
          }
        );
        if (!outcome.ok) {
          return batchSelectionErrorResponse(outcome.error);
        }
        const { documentIds, written } = outcome.value;
        const { changedIds, resultsById, transitions } = written;

        // The committed subset, never the requested set: `transitions` and
        // `changedIds` hold only the ids this batch actually moved.
        await emitBatchStatusSideEffects({
          ...sideEffectInput,
          transitions,
          changedIds,
          reportNoChange: !hasBatchItemFieldEditRefusal(resultsById.values()),
        });
        emitBatchItemFieldEditRefusalAnalytics({
          organizationId: user.organizationId,
          userId: user.id,
          authMethod,
          field: ArtifactFieldEditField.Status,
          surface: body.surface,
          after: body.status,
          results: resultsById.values(),
        });

        return batchMutationResponse(
          orderBatchResults(documentIds, resultsById),
          transactionId
        );
      } catch (error) {
        return errorResponse("Failed to update document statuses", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
