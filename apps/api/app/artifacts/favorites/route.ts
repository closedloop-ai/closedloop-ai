import type { Artifact } from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { artifactFavoritesService } from "../favorites-service";

export const GET = withAnyAuth<Artifact[], "/artifacts/favorites">(
  async ({ user }) => {
    try {
      const artifacts = await artifactFavoritesService.findFavoritesByUser(
        user.id,
        user.organizationId
      );

      return successResponse(artifacts);
    } catch (error) {
      return errorResponse("Failed to fetch favorite artifacts", error);
    }
  }
);
