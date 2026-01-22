import type {
  CreateTeamInput,
  TeamWithCounts,
} from "@repo/api/src/types/teams";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { teamsService } from "./service";

const createTeamSchema = z.object({
  name: z.string().min(1, "Team name is required"),
  slug: z.string().optional(),
});

/**
 * GET /teams - List all teams for the current user's organization
 */
export const GET = withAuth<TeamWithCounts[], "/teams">(async ({ user }) => {
  try {
    const teams = await teamsService.findByOrganization(user.organizationId);

    const teamsWithCounts: TeamWithCounts[] = teams.map((team) => ({
      id: team.id,
      organizationId: team.organizationId,
      name: team.name,
      slug: team.slug,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      memberCount: team._count.members,
      projectCount: team._count.projects,
    }));

    return successResponse(teamsWithCounts);
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
        createTeamSchema
      );

      if (parseError) {
        return parseError;
      }

      const input: CreateTeamInput = {
        organizationId: user.organizationId,
        name: body.name,
        slug: body.slug,
      };

      // Create team and add creator as owner
      const team = await teamsService.createWithOwner(input, user.id);

      // Fetch the team with counts for response
      const teamWithCounts = await teamsService.findById(team.id);

      if (!teamWithCounts) {
        return errorResponse(
          "Team created but could not be retrieved",
          new Error("Team not found")
        );
      }

      const response: TeamWithCounts = {
        id: teamWithCounts.id,
        organizationId: teamWithCounts.organizationId,
        name: teamWithCounts.name,
        slug: teamWithCounts.slug,
        createdAt: teamWithCounts.createdAt,
        updatedAt: teamWithCounts.updatedAt,
        memberCount: teamWithCounts._count.members,
        projectCount: teamWithCounts._count.projects,
      };

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to create team", error);
    }
  }
);
