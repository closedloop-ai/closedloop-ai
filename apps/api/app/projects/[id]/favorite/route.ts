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
import { projectFavoriteReceiptWrite } from "../../project-operation-receipt";
import { projectsService } from "../../service";

/**
 * POST /projects/:id/favorite - Add a project to the user's favorites
 */
export const POST = withAnyAuth<FavoriteResponse, "/projects/[id]/favorite">(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const result = await projectsService.addFavorite(
          id,
          user.id,
          user.organizationId,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, projectFavoriteReceiptWrite(written))
          )
        );

        if (!result) {
          return notFoundResponse("Project");
        }

        return successResponse(withOperationReceipt(result, receipts));
      } catch (error) {
        return errorResponse("Failed to add project to favorites", error);
      }
    }
  )
);

/**
 * DELETE /projects/:id/favorite - Remove a project from the user's favorites
 */
export const DELETE = withAnyAuth<FavoriteResponse, "/projects/[id]/favorite">(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        const result = await projectsService.removeFavorite(
          id,
          user.id,
          user.organizationId,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, projectFavoriteReceiptWrite(written))
          )
        );

        if (!result) {
          return notFoundResponse("Project");
        }

        return successResponse(withOperationReceipt(result, receipts));
      } catch (error) {
        return errorResponse("Failed to remove project from favorites", error);
      }
    }
  )
);
