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
import { emitBatchFieldEditRefusalAnalytics } from "../batch-field-edit-refusal-analytics";
import {
  captureBatchStatusActivity,
  emitBatchStatusSideEffects,
} from "../batch-status-side-effects";
import { batchFieldUpdateReceiptRecorder } from "../document-batch-field-receipts";
import {
  documentStatusMutationService,
  validateUndoTransactionReference,
} from "../document-status-mutation-service";
import { batchUpdateStatusValidator } from "../validators";

/**
 * POST /documents/batch-update-status
 * Update the status of multiple documents atomically.
 */
export const POST = withAnyAuth<
  string[],
  typeof BatchMutationRoute.DocumentsUpdateStatus
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

        // ISS-10993: the batch write and its activity receipt share ONE
        // transaction. `withDb.tx` joins an ambient transaction, so the service's
        // own `withDb.tx` runs on this one and a receipt that cannot be written
        // rolls the status change back with it. ISS-9579 puts the selection lock
        // on that same transaction, ahead of the service call — this route
        // refuses the WHOLE batch over a missing id, so a server-resolved id that
        // vanished first would 400 a select-all over a row nobody named.
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
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const written =
              await documentStatusMutationService.batchUpdateStatus(
                documentIds,
                body.status,
                user.organizationId,
                body.expectedStatusById
              );
            if (written.ok) {
              await captureBatchStatusActivity(tx, {
                ...sideEffectInput,
                transitions: written.value.transitions,
                changedIds: written.value.changedIds,
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
        const updateResult = outcome.value;
        if (!updateResult.ok) {
          emitBatchFieldEditRefusalAnalytics({
            organizationId: user.organizationId,
            userId: user.id,
            authMethod,
            field: ArtifactFieldEditField.Status,
            surface: body.surface,
            after: body.status,
            error: updateResult.error,
          });
          return statusMutationErrorResponse(updateResult.error);
        }
        const { updatedIds, changedIds, transitions } = updateResult.value;

        await emitBatchStatusSideEffects({
          ...sideEffectInput,
          transitions,
          changedIds,
        });

        return successResponse(updatedIds);
      } catch (error) {
        return errorResponse("Failed to update document statuses", error);
      }
    }
  ),
  // The literal, not `DOCUMENT_STATUS_MUTATION_REQUIRED_SCOPES[...Bulk]`:
  // `undo-registry-routes.test.ts` reads this array off the AST and only
  // understands string literals, so a spread of the imported constant parses as
  // zero scopes and the route reads as enforcing none. The table is kept honest
  // instead by two tests pinning this same hand-written value.
  { requiredScopes: ["write"] }
);
