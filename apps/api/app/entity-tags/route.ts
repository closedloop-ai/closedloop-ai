import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { TagEntityType } from "@repo/api/src/types/tag";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { EntityNotFoundError, tagService } from "../tags/service";
import { entityTagValidator } from "../tags/validators";

export const POST = withAnyAuth(
  withOperationReceipts<{ applied: true }, "/entity-tags">(
    OperationKind.Tag,
    async ({ user, authMethod }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          entityTagValidator
        );
        if (parseError) {
          return parseError;
        }

        const applied = await tagService.applyTag(
          body.tagId,
          body.entityType,
          body.entityId,
          user.organizationId,
          { userId: user.id, authMethod },
          createArtifactFieldEditAnalyticsContext({
            organizationId: user.organizationId,
            userId: user.id,
            authMethod,
            surface: body.surface,
          }).receiptContext,
          receipts.whenRecording((tx) =>
            receipts.record(tx, {
              operationKind: OperationKind.Tag,
              outcome: OperationReceiptOutcome.Committed,
              ...artifactTarget(body.entityType, body.entityId),
            })
          )
        );
        // ISS-12552: re-applying an existing tag changed nothing, and its
        // insert rolled back, so the no-op receipt gets its own transaction.
        if (!applied) {
          await receipts.recordStandalone({
            operationKind: OperationKind.Tag,
            outcome: OperationReceiptOutcome.NoOp,
            ...artifactTarget(body.entityType, body.entityId),
          });
        }
        return successResponse(
          withOperationReceipt({ applied: true as const }, receipts)
        );
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse(error.message);
        }
        return errorResponse("Failed to apply tag", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth(
  withOperationReceipts<{ deleted: true }, "/entity-tags">(
    OperationKind.Untag,
    async ({ user, authMethod }, request, _params, receipts) => {
      try {
        const url = new URL(request.url);
        const tagId = url.searchParams.get("tagId");
        const entityType = url.searchParams.get("entityType");
        const entityId = url.searchParams.get("entityId");

        if (!(tagId && entityType && entityId)) {
          return badRequestResponse(
            "tagId, entityType, and entityId are required"
          );
        }

        const result = entityTagValidator.safeParse({
          tagId,
          entityType,
          entityId,
          surface: url.searchParams.get("surface") ?? undefined,
        });
        if (!result.success) {
          return badRequestResponse("Invalid parameters");
        }

        await tagService.removeTag(
          result.data.tagId,
          result.data.entityType,
          result.data.entityId,
          user.organizationId,
          { userId: user.id, authMethod },
          createArtifactFieldEditAnalyticsContext({
            organizationId: user.organizationId,
            userId: user.id,
            authMethod,
            surface: result.data.surface,
          }).receiptContext,
          receipts.whenRecording((tx, { removed }) =>
            receipts.record(tx, {
              operationKind: OperationKind.Untag,
              outcome: removed
                ? OperationReceiptOutcome.Committed
                : OperationReceiptOutcome.NoOp,
              ...artifactTarget(result.data.entityType, result.data.entityId),
            })
          )
        );
        return deleteResponse(receipts.receipt);
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse(error.message);
        }
        return errorResponse("Failed to remove tag", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);

/** A tag's receipt names its artifact; a project id is not an artifact. */
function artifactTarget(
  entityType: TagEntityType,
  entityId: string
): { targetArtifactId?: string } {
  return entityType === TagEntityType.Artifact
    ? { targetArtifactId: entityId }
    : {};
}
