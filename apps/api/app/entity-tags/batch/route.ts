import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { AuditAction } from "@repo/api/src/types/audit";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { recordBatchTagWrite } from "../../tags/batch-tag-receipts";
import { emitBatchTagSideEffects } from "../../tags/batch-tag-side-effects";
import { EntityNotFoundError, tagService } from "../../tags/service";
import { batchEntityTagValidator } from "../../tags/validators";

/**
 * POST /entity-tags/batch
 * Apply a tag to multiple entities at once (idempotent).
 */
export const POST = withAnyAuth(
  withOperationReceipts<{ appliedCount: number }, "/entity-tags/batch">(
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
        const result = await tagService.batchApplyTag(
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

        emitBatchTagSideEffects({
          user,
          authMethod,
          action: AuditAction.ArtifactTagApplied,
          tagId: body.tagId,
          changedIds: result.newlyTaggedIds,
          transactionId,
        });

        // `newlyTaggedIds` is internal; the wire shape is unchanged.
        return successResponse({ appliedCount: result.appliedCount });
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse(error.message);
        }
        return errorResponse("Failed to apply tags", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
