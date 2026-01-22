import type { Team, TeamWithCounts } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { teamsService, toTeamWithCounts } from "../service";
import { updateTeamValidator } from "../validators";

/**
 * GET /teams/:teamId - Get a single team by ID
 */
export const GET = withAuth<TeamWithCounts, "/teams/[teamId]">(
  async ({ user }, _, params) => {
    try {
      const { teamId } = await params;
      const team = await teamsService.findById(teamId, user.organizationId);

      if (!team) {
        return notFoundResponse("Team");
      }

      return successResponse(toTeamWithCounts(team));
    } catch (error) {
      return errorResponse("Failed to fetch team", error);
    }
  }
);

/**
 * PUT /teams/:teamId - Update a team
 */
export const PUT = withAuth<Team, "/teams/[teamId]">(
  async ({ user }, request, params) => {
    try {
      const { teamId } = await params;

      // Check user has permission (must be team owner or admin)
      const hasPermission = await teamsService.hasRole(
        teamId,
        user.id,
        "ADMIN"
      );
      if (!hasPermission) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateTeamValidator
      );
      if (parseError) {
        return parseError;
      }

      const updatedTeam = await teamsService.update(
        teamId,
        user.organizationId,
        body
      );

      if (!updatedTeam) {
        return notFoundResponse("Team");
      }

      return successResponse(updatedTeam);
    } catch (error) {
      return errorResponse("Failed to update team", error);
    }
  }
);

/**
 * DELETE /teams/:teamId - Delete a team
 */
export const DELETE = withAuth<{ deleted: true }, "/teams/[teamId]">(
  async ({ user }, _, params) => {
    try {
      const { teamId } = await params;

      // Check user has permission (must be team owner)
      const hasPermission = await teamsService.hasRole(
        teamId,
        user.id,
        "OWNER"
      );
      if (!hasPermission) {
        return forbiddenResponse();
      }

      await teamsService.delete(teamId, user.organizationId);

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete team", error);
    }
  }
);
