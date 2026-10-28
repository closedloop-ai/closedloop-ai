import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  conflictResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  TEAM_SLUG_CONFLICT_MESSAGE,
  teamsService,
  toTeamWithCounts,
} from "./service";
import { createTeamValidator } from "./validators";

/**
 * GET /teams - List all teams for the current user's organization
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 *
 * `withAnyAuth` rather than `withAuth` (ISS-6966): a project must name a team,
 * and the `project_team_required` 400 can only name the teams that fit its
 * message budget, so an API-key caller needs a first-class way to read the
 * complete set. This is the route behind the `list-teams` MCP tool. The org is
 * the authenticated principal's own — `user.organizationId` comes from the key's
 * user, so an API key can only ever list its own organization's teams.
 *
 * POST stays `withAuth`: creating a team remains a browser-session action.
 */
export const GET = withAnyAuth<TeamWithCounts[], "/teams">(async ({ user }) => {
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
      const created = await teamsService.createWithOwner(
        user.organizationId,
        user.id,
        body
      );

      if (!created.ok) {
        return conflictResponse(TEAM_SLUG_CONFLICT_MESSAGE);
      }

      // Fetch the team with counts for response
      const teamWithCounts = await teamsService.findById(
        created.value.id,
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
