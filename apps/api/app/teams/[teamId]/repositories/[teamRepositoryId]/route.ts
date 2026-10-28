import type { TeamRepository } from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireTeamRole } from "../../../require-team-role";
import { teamsService } from "../../../service";
import { updateTeamRepositoryValidator } from "../../../validators";

/**
 * PUT /teams/:teamId/repositories/:teamRepositoryId - Update default/primary flags
 * for a team repository. Requires team admin role.
 */
export const PUT = withAuth<
  TeamRepository,
  "/teams/[teamId]/repositories/[teamRepositoryId]"
>(async ({ user }, request, params) => {
  try {
    const { teamId, teamRepositoryId } = await params;

    const authError = await requireTeamRole(teamId, user, TeamRole.Admin);
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateTeamRepositoryValidator
    );
    if (parseError) {
      return parseError;
    }

    const result = await teamsService.updateRepository(
      teamId,
      teamRepositoryId,
      body
    );

    if (!result.ok) {
      return notFoundResponse("Team repository");
    }

    return successResponse(result.value);
  } catch (error) {
    return errorResponse("Failed to update team repository", error);
  }
});

/**
 * DELETE /teams/:teamId/repositories/:teamRepositoryId - Remove a repository
 * from a team's curated list. Requires team admin role.
 */
export const DELETE = withAuth<
  { deleted: true },
  "/teams/[teamId]/repositories/[teamRepositoryId]"
>(async ({ user }, _, params) => {
  try {
    const { teamId, teamRepositoryId } = await params;

    const authError = await requireTeamRole(teamId, user, TeamRole.Admin);
    if (authError) {
      return authError;
    }

    const result = await teamsService.removeRepository(
      teamId,
      teamRepositoryId
    );
    if (!result.ok) {
      return notFoundResponse("Team repository");
    }

    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to remove team repository", error);
  }
});
