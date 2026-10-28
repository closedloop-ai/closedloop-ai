import { Status } from "@repo/api/src/types/result";
import type { Team, TeamWithCounts } from "@repo/api/src/types/teams";
import { TeamRole } from "@repo/api/src/types/teams";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  conflictResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireTeamRole } from "../require-team-role";
import {
  TEAM_SLUG_CONFLICT_MESSAGE,
  teamsService,
  toTeamWithCounts,
} from "../service";
import { updateTeamValidator } from "../validators";

/**
 * GET /teams/:teamId - Get a single team by ID
 */
export const GET = withAnyAuth<TeamWithCounts, "/teams/[teamId]">(
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

      const authError = await requireTeamRole(teamId, user, TeamRole.Admin);
      if (authError) {
        return authError;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateTeamValidator
      );
      if (parseError) {
        return parseError;
      }

      const updated = await teamsService.update(
        teamId,
        user.organizationId,
        body
      );

      if (!updated.ok) {
        if (updated.error === Status.Conflict) {
          return conflictResponse(TEAM_SLUG_CONFLICT_MESSAGE);
        }
        return notFoundResponse("Team");
      }

      return successResponse(updated.value);
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

      const authError = await requireTeamRole(teamId, user, TeamRole.Owner);
      if (authError) {
        return authError;
      }

      const deleted = await teamsService.delete(teamId, user.organizationId);

      if (!deleted.ok) {
        return notFoundResponse("Team");
      }

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete team", error);
    }
  }
);
