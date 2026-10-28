import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { AuditAction } from "@repo/api/src/types/audit";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import {
  BatchRemoveTagRefusal,
  batchRemoveTagService,
} from "@/app/tags/batch-remove-tag-service";
import { recordBatchTagWrite } from "@/app/tags/batch-tag-receipts";
import { emitBatchTagSideEffects } from "@/app/tags/batch-tag-side-effects";
import { batchEntityTagValidator } from "@/app/tags/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";

/**
 * Removes one tag from a bounded artifact batch. An absent membership is a
 * successful no-op; an unresolved artifact refuses the whole batch.
 */
export const POST = withAnyAuth(
  withOperationReceipts<BatchMutationResponse, "/entity-tags/batch-remove/v2">(
    OperationKind.Untag,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchEntityTagValidator
        );
        if (parseError) {
          return parseError;
        }

        const transactionId = newBulkTransactionId();
        const result = await batchRemoveTagService.removePerItem(
          body.tagId,
          body.entityType,
          body.entityIds,
          user.organizationId,
          recordBatchTagWrite(receipts, OperationKind.Untag, {
            user,
            authMethod,
            action: AuditAction.ArtifactTagRemoved,
            tagId: body.tagId,
            transactionId,
          })
        );

        if (result.ok) {
          emitBatchTagSideEffects({
            user,
            authMethod,
            action: AuditAction.ArtifactTagRemoved,
            tagId: body.tagId,
            changedIds: result.value.removedIds,
            transactionId,
          });
          return batchMutationResponse(
            orderBatchResults(body.entityIds, result.value.results),
            transactionId
          );
        }

        if (result.error === BatchRemoveTagRefusal.TagNotFound) {
          return notFoundResponse("Tag");
        }
        return notFoundResponse("One or more requested artifacts");
      } catch (error) {
        return errorResponse("Failed to remove tags", error);
      }
    }
  ),
  {
    requiredScopes: [ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.RemoveTag]],
  }
);
