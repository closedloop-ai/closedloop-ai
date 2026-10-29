import type { BatchMoveArtifactsResult } from "@repo/api/src/types/artifact";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  captureBatchMoveActivity,
  emitBatchMoveSideEffects,
} from "@/lib/batch-move-side-effects";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { statusMutationErrorResponse } from "@/lib/mutation-error-response";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { batchMoveReceiptRecorder } from "../batch-move-receipts";
import { artifactLinksService } from "../service";
import { batchMoveArtifactsValidator } from "../validators";

/**
 * POST /artifact-links/batch-move
 * Move an artifact and optionally all its downstream artifacts to a target project.
 */
export const POST = withAnyAuth<
  BatchMoveArtifactsResult,
  typeof BatchMutationRoute.ArtifactLinksMove
>(
  withOperationReceipts(
    OperationKind.Move,
    async ({ authMethod, user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchMoveArtifactsValidator
        );
        if (parseError) {
          return parseError;
        }

        const transactionId = newBulkTransactionId();
        const recordReceipts = batchMoveReceiptRecorder(receipts);
        // ISS-10993: the move and its activity receipt share ONE transaction.
        // `withDb.tx` joins an ambient transaction, so the service's own
        // `withDb.tx` runs on this one and a receipt that cannot be written rolls
        // the move back with it.
        const result = await withDb.tx(async (tx) => {
          const moved = await artifactLinksService.batchMoveArtifacts(
            user.organizationId,
            body
          );
          if (moved.ok) {
            await captureBatchMoveActivity(tx, {
              user,
              authMethod,
              projectChanges: moved.value.projectChanges,
              transactionId,
              surface: body.surface,
            });
            await recordReceipts?.(tx, moved.value.projectChanges);
          }
          return moved;
        });

        if (result.ok) {
          emitBatchMoveSideEffects({
            user,
            authMethod,
            projectChanges: result.value.projectChanges,
            transactionId,
            surface: body.surface,
          });
          // `projectChanges` is internal; the wire shape is unchanged.
          return successResponse({
            movedArtifacts: result.value.movedArtifacts,
          });
        }

        // ISS-10995: a refused optimistic guard carries its own envelope —
        // `stale_project_id` plus `details.staleProjectIds`, the same one
        // `PATCH /agent-sessions/{id}` answers with.
        if (typeof result.error === "object") {
          return statusMutationErrorResponse(result.error);
        }
        // The service distinguishes between "source artifact missing"
        // (NotFound) and "target project missing" (BadRequest). Mirror that
        // in the HTTP response instead of flattening both to 400.
        if (result.error === Status.NotFound) {
          return notFoundResponse("Artifact");
        }
        if (result.error === Status.BadRequest) {
          return badRequestResponse("Target project not found");
        }
        return badRequestResponse("Failed to move items");
      } catch (error) {
        return errorResponse("Failed to move artifacts", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
