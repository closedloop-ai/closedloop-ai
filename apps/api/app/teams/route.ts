import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { teamsService, toTeamWithCounts } from "./service";
import { createTeamValidator } from "./validators";

/**
 * GET /teams - List all teams for the current user's organization
 */
export const GET = withAuth<TeamWithCounts[], "/teams">(async ({ user }) => {
  try {
    const teams = await teamsService.findByOrganization(user.organizationId);
    return successResponse(teams.map(toTeamWithCounts));
  } catch (error) {
    return errorResponse("Failed to fetch teams", error);
  }
});

/**
 * POST /teams - Create a new team
 */
export const POST = withAuth<TeamWithCounts, "/teams">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createTeamValidator
      );

      if (parseError) {
        return parseError;
      }

      // Create team and add creator as owner
      const team = await teamsService.createWithOwner(
        user.organizationId,
        user.id,
        body
      );

      // Fetch the team with counts for response
      const teamWithCounts = await teamsService.findById(
        team.id,
        user.organizationId
      );

      if (!teamWithCounts) {
        return errorResponse(
          "Team created but could not be retrieved",
          new Error("Team not found")
        );
      }

      return successResponse(toTeamWithCounts(teamWithCounts));
    } catch (error) {
      return errorResponse("Failed to create team", error);
    }
  }
);
