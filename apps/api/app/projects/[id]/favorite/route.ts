import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";

/**
 * POST /projects/:id/favorite - Add a project to the user's favorites
 */
export const POST = withAnyAuth<
  { favorited: boolean },
  "/projects/[id]/favorite"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const result = await projectsService.addFavorite(
      id,
      user.id,
      user.organizationId
    );

    if (!result) {
      return notFoundResponse("Project");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to add project to favorites", error);
  }
});

/**
 * DELETE /projects/:id/favorite - Remove a project from the user's favorites
 */
export const DELETE = withAnyAuth<
  { favorited: boolean },
  "/projects/[id]/favorite"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const result = await projectsService.removeFavorite(
      id,
      user.id,
      user.organizationId
    );

    if (!result) {
      return notFoundResponse("Project");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to remove project from favorites", error);
  }
});
