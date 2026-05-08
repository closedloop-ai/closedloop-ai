import type { TeamRepository } from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { AddRepositoryError, teamsService } from "../../service";
import { addTeamRepositoryValidator } from "../../validators";

/**
 * GET /teams/:teamId/repositories - List repositories configured for a team.
 * Any team member can view; admin role is not required.
 */
export const GET = withAuth<TeamRepository[], "/teams/[teamId]/repositories">(
  async ({ user }, _, params) => {
    try {
      const { teamId } = await params;

      const team = await teamsService.findById(teamId, user.organizationId);
      if (!team) {
        return notFoundResponse("Team");
      }

      const isMember = await teamsService.isMember(teamId, user.id);
      if (!isMember) {
        return forbiddenResponse();
      }

      const repositories = await teamsService.getRepositories(teamId);
      return successResponse(repositories);
    } catch (error) {
      return errorResponse("Failed to fetch team repositories", error);
    }
  }
);

/**
 * POST /teams/:teamId/repositories - Add a repository to a team's curated list.
 * Requires team admin role.
 */
export const POST = withAuth<TeamRepository, "/teams/[teamId]/repositories">(
  async ({ user }, request, params) => {
    try {
      const { teamId } = await params;

      const team = await teamsService.findById(teamId, user.organizationId);
      if (!team) {
        return notFoundResponse("Team");
      }

      const hasPermission = await teamsService.hasRole(
        teamId,
        user.id,
        TeamRole.Admin
      );
      if (!hasPermission) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        addTeamRepositoryValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await teamsService.addRepository(
        teamId,
        user.organizationId,
        body
      );

      if (!result.ok) {
        if (result.error === AddRepositoryError.RepoNotAvailable) {
          return badRequestResponse(
            "Repository is not available for this organization"
          );
        }
        return conflictResponse("Repository is already added to this team");
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to add team repository", error);
    }
  }
);
