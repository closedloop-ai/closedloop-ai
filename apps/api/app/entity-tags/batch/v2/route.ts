import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { AuditAction } from "@repo/api/src/types/audit";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { batchApplyTagService } from "@/app/tags/batch-apply-tag-service";
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
 * POST /entity-tags/batch/v2 — the v1 request body, answered with one result
 * per distinct requested artifact id (ISS-9464). v1 is unchanged.
 *
 * v1 refuses the whole batch when any id is missing from the org; this applies
 * the tag to the ids that resolved and reports the rest `artifacts_not_found`.
 * A tag outside the caller's org fails every item the same way, so it stays a
 * 404 envelope.
 */
export const POST = withAnyAuth(
  withOperationReceipts<BatchMutationResponse, "/entity-tags/batch/v2">(
    OperationKind.Tag,
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
        // ISS-10993: the write and its activity receipt share ONE transaction —
        // the INSERT's, handed in as a callback rather than opened around the
        // call. `withDb.tx` joins an ambient transaction instead of nesting, so a
        // transaction opened here would also swallow the service's post-commit
        // GitHub label reconciliation. ISS-12552: the per-artifact operation
        // receipts ride the same callback.
        const result = await batchApplyTagService.applyPerItem(
          body.tagId,
          body.entityType,
          body.entityIds,
          user.organizationId,
          recordBatchTagWrite(receipts, OperationKind.Tag, {
            user,
            authMethod,
            action: AuditAction.ArtifactTagApplied,
            tagId: body.tagId,
            transactionId,
          })
        );

        if (result.ok) {
          emitBatchTagSideEffects({
            user,
            authMethod,
            action: AuditAction.ArtifactTagApplied,
            tagId: body.tagId,
            changedIds: result.value.newlyTaggedIds,
            transactionId,
          });
          return batchMutationResponse(
            orderBatchResults(body.entityIds, result.value.results),
            transactionId
          );
        }

        if (result.error === Status.NotFound) {
          return notFoundResponse("Tag");
        }
        return errorResponse("Failed to apply tags", result.error);
      } catch (error) {
        return errorResponse("Failed to apply tags", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
