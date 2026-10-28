import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { FavoriteResponse } from "@repo/api/src/types/project";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { favoriteReceiptWrite } from "../../favorite-receipt";
import { artifactFavoritesService } from "../../favorites-service";

export const POST = withAnyAuth<FavoriteResponse, "/artifacts/[id]/favorite">(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const result = await artifactFavoritesService.addFavorite(
          id,
          user.id,
          user.organizationId,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, favoriteReceiptWrite(id, written))
          )
        );

        if (!result) {
          return notFoundResponse("Artifact");
        }

        return successResponse(withOperationReceipt(result, receipts));
      } catch (error) {
        return errorResponse("Failed to add artifact to favorites", error);
      }
    }
  )
);

export const DELETE = withAnyAuth<FavoriteResponse, "/artifacts/[id]/favorite">(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const result = await artifactFavoritesService.removeFavorite(
          id,
          user.id,
          user.organizationId,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, favoriteReceiptWrite(id, written))
          )
        );

        if (!result) {
          return notFoundResponse("Artifact");
        }

        return successResponse(withOperationReceipt(result, receipts));
      } catch (error) {
        return errorResponse("Failed to remove artifact from favorites", error);
      }
    }
  )
);
