import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
  withLockedBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactBulkPriorityService } from "../artifact-bulk-priority-service";
import { emitBatchFieldEditRefusalAnalytics } from "../batch-field-edit-refusal-analytics";
import {
  captureBatchPriorityActivity,
  emitBatchPrioritySideEffects,
} from "../batch-priority-side-effects";
import { batchFieldUpdateReceiptRecorder } from "../document-batch-field-receipts";
import { batchUpdatePriorityValidator } from "../validators";

/**
 * POST /documents/batch-update-priority
 * Set one priority on multiple documents atomically.
 */
export const POST = withAnyAuth<
  string[],
  typeof BatchMutationRoute.DocumentsUpdatePriority
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
        // ISS-10993: the batch write and its activity receipt share ONE
        // transaction. `withDb.tx` joins an ambient transaction, so the service's
        // own `withDb.tx` runs on this one and a receipt that cannot be written
        // rolls the priority change back with it. ISS-9579 puts the selection
        // lock on that same transaction, ahead of the service call — this route
        // refuses the WHOLE batch over a missing id, so a server-resolved id that
        // vanished first would 400 a select-all over a row nobody named.
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const written =
              await artifactBulkPriorityService.batchUpdatePriority(
                documentIds,
                body.priority,
                user.organizationId,
                body.expectedPriorityById
              );
            if (written.ok) {
              await captureBatchPriorityActivity(tx, {
                user,
                authMethod,
                priority: body.priority,
                surface: body.surface,
                changedIds: written.value.changedIds,
                beforePriorities: written.value.beforePriorities,
                transactionId,
              });
              await recordReceipts?.(tx, {
                appliedIds: written.value.updatedIds,
                changedIds: written.value.changedIds,
              });
            }
            return written;
          }
        );
        if (!outcome.ok) {
          return batchSelectionErrorResponse(outcome.error);
        }
        const result = outcome.value;
        if (!result.ok) {
          // ISS-9440: rendered by the same helper the status batch uses, so the
          // 400 (a caller's unknown id) and the 409 (rows moved under the batch
          // — retryable, never flattened into a 400) carry one `code`/`details`
          // envelope across both routes.
          emitBatchFieldEditRefusalAnalytics({
            organizationId: user.organizationId,
            userId: user.id,
            authMethod,
            field: ArtifactFieldEditField.Priority,
            surface: body.surface,
            after: body.priority,
            error: result.error,
          });
          return statusMutationErrorResponse(result.error);
        }
        const { updatedIds, changedIds, beforePriorities } = result.value;

        emitBatchPrioritySideEffects({
          user,
          authMethod,
          priority: body.priority,
          surface: body.surface,
          changedIds,
          beforePriorities,
          transactionId,
        });

        return successResponse(updatedIds);
      } catch (error) {
        return errorResponse("Failed to update document priorities", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
