import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { withDb } from "@repo/database";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  batchMutationResponse,
  orderBatchResults,
} from "@/lib/batch-mutation-response";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody } from "@/lib/route-utils";
import { favoriteBatchReceiptRecorder } from "../../../favorite-receipt";
import { batchSetArtifactFavorites } from "../../../favorites-batch-service";

export const batchFavoritesBodySchema = z
  .object({
    artifactIds: z.array(z.uuid()).min(1).max(BATCH_MUTATION_ENTITY_LIMIT),
    favorite: z.boolean(),
  })
  .strict();

/** Set favorite state for up to 500 artifacts with per-item outcomes. */
export const POST = withAnyAuth<
  BatchMutationResponse,
  "/artifacts/favorites/batch/v2"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          batchFavoritesBodySchema
        );
        if (parseError) {
          return parseError;
        }
        const transactionId = newBulkTransactionId();
        const resultsById = await withDb.tx((tx) =>
          batchSetArtifactFavorites(
            tx,
            body.artifactIds,
            user.id,
            user.organizationId,
            body.favorite,
            favoriteBatchReceiptRecorder(receipts)
          )
        );
        return batchMutationResponse(
          orderBatchResults(body.artifactIds, resultsById),
          transactionId
        );
      } catch (error) {
        return errorResponse("Failed to update artifact favorites", error);
      }
    }
  ),
  {
    requiredScopes: [
      ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.ChangeFavorite],
    ],
  }
);
