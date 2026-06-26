import type { FavoriteResponse } from "@repo/api/src/types/project";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactFavoritesService } from "../../favorites-service";

export const POST = withAnyAuth<FavoriteResponse, "/artifacts/[id]/favorite">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const result = await artifactFavoritesService.addFavorite(
        id,
        user.id,
        user.organizationId
      );

      if (!result) {
        return notFoundResponse("Artifact");
      }

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to add artifact to favorites", error);
    }
  }
);

export const DELETE = withAnyAuth<FavoriteResponse, "/artifacts/[id]/favorite">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const result = await artifactFavoritesService.removeFavorite(
        id,
        user.id,
        user.organizationId
      );

      if (!result) {
        return notFoundResponse("Artifact");
      }

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to remove artifact from favorites", error);
    }
  }
);
