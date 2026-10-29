import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { ArtifactFieldEditField } from "@repo/api/src/types/artifact-field-edit-receipt";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import {
  batchSelectionErrorResponse,
  resolveBatchSelection,
  withLockedBatchSelection,
} from "@/app/documents/batch-selection-resolver";
import { captureBatchAssigneeAssignment } from "@/lib/artifact-activity-capture";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
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
import { USER_NOT_IN_ORGANIZATION_MESSAGE } from "@/lib/user-org-membership";
import { batchUpdateDocumentAssignee } from "../../document-assignee-batch-item-service";
import { emitBatchDocumentAssigneeSideEffects } from "../../document-assignee-batch-side-effects";
import { batchUpdateAssigneeValidator } from "../../document-assignee-batch-validator";
import {
  appliedBatchItemIds,
  batchFieldUpdateReceiptRecorder,
} from "../../document-batch-field-receipts";

/** Set document/issue owner with an ordered outcome for every distinct id. */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/documents/batch-update-assignee/v2"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchUpdateAssigneeValidator
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
          ArtifactFieldEditField.AssigneeId
        );
        const outcome = await withLockedBatchSelection(
          plan.value,
          user.organizationId,
          async (tx, documentIds) => {
            const written = await batchUpdateDocumentAssignee(
              tx,
              documentIds,
              body.assigneeId,
              user.organizationId
            );
            if (written.validAssignee) {
              await captureBatchAssigneeAssignment({
                tx,
                organizationId: user.organizationId,
                changes: written.changes,
                actor: { userId: user.id, authMethod },
                transactionId,
              });
            }
            await recordReceipts?.(tx, {
              appliedIds: appliedBatchItemIds(written.resultsById),
              changedIds: written.changes.map((change) => change.artifactId),
            });
            return { documentIds, written };
          }
        );
        if (!outcome.ok) {
          return batchSelectionErrorResponse(outcome.error);
        }
        const { documentIds, written } = outcome.value;
        if (!written.validAssignee) {
          return badRequestResponse(USER_NOT_IN_ORGANIZATION_MESSAGE);
        }
        emitBatchDocumentAssigneeSideEffects({
          actorUserId: user.id,
          organizationId: user.organizationId,
          assigneeId: body.assigneeId,
          changes: written.changes,
        });
        return batchMutationResponse(
          orderBatchResults(documentIds, written.resultsById),
          transactionId
        );
      } catch (error) {
        return errorResponse("Failed to update document assignees", error);
      }
    }
  ),
  {
    requiredScopes: [
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeOwner],
    ],
  }
);
