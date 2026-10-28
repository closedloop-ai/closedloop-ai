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
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody } from "@/lib/route-utils";
import { artifactBulkPriorityService } from "../../artifact-bulk-priority-service";
import {
  emitBatchItemFieldEditRefusalAnalytics,
  hasBatchItemFieldEditRefusal,
} from "../../batch-field-edit-refusal-analytics";
import {
  captureBatchPriorityActivity,
  emitBatchPrioritySideEffects,
} from "../../batch-priority-side-effects";
import {
  appliedBatchItemIds,
  batchFieldUpdateReceiptRecorder,
} from "../../document-batch-field-receipts";
import { batchUpdatePriorityValidator } from "../../validators";

/**
 * POST /documents/batch-update-priority/v2 — the v1 request body, answered with
 * one result per distinct requested document id (ISS-9464). v1 is unchanged.
 *
 * v1 refuses the whole batch when any id is missing from the org or any guarded
 * row moved under it. This commits the eligible items and reports the rest item
 * by item.
 */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/documents/batch-update-priority/v2"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchUpdatePriorityValidator
        );
        if (parseError) {
          return parseError;
        }

        const plan = await resolveBatchSelection(body, user.organizationId);
        if (!plan.ok) {
          return batchSelectionErrorResponse(plan.error);
        }

        const transactionId = newBulkTransactionId();

        const recordReceipts = batchFieldUpdateReceiptRecorder(
          receipts,
          ArtifactFieldEditField.Priority
        );
        // ISS-10993: the per-item write and its activity receipt share ONE
        // transaction. `withDb.tx` joins an ambient transaction, so the service's
        // own transaction runs on this one and a receipt that cannot be written
        // rolls the committed subset back with it. ISS-9579 puts the selection
        // lock on that same transaction, ahead of the service call.
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const written =
              await artifactBulkPriorityService.batchUpdatePriorityPerItem(
                documentIds,
                body.priority,
                user.organizationId,
                body.expectedPriorityById
              );
            await captureBatchPriorityActivity(tx, {
              user,
              authMethod,
              priority: body.priority,
              surface: body.surface,
              changedIds: written.changedIds,
              beforePriorities: written.beforePriorities,
              transactionId,
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
        const { beforePriorities, changedIds, resultsById } = written;

        // The committed subset, never the requested set: `changedIds` holds only
        // the ids this batch actually moved.
        emitBatchPrioritySideEffects({
          user,
          authMethod,
          priority: body.priority,
          surface: body.surface,
          changedIds,
          beforePriorities,
          transactionId,
          reportNoChange: !hasBatchItemFieldEditRefusal(resultsById.values()),
        });
        emitBatchItemFieldEditRefusalAnalytics({
          organizationId: user.organizationId,
          userId: user.id,
          authMethod,
          field: ArtifactFieldEditField.Priority,
          surface: body.surface,
          after: body.priority,
          results: resultsById.values(),
        });

        return batchMutationResponse(
          orderBatchResults(documentIds, resultsById),
          transactionId
        );
      } catch (error) {
        return errorResponse("Failed to update document priorities", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
