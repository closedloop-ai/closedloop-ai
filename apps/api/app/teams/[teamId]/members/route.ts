import type { AddTeamMemberInput, TeamMember } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { usersService } from "../../../users/service";
import { teamsService } from "../../service";
import { addMemberValidator } from "../../validators";

/**
 * GET /teams/:teamId/members - List all members of a team
 */
export const GET = withAuth<TeamMember[], "/teams/[teamId]/members">(
  async ({ user }, _, params) => {
    try {
      const { teamId } = await params;
      const team = await teamsService.findById(teamId, user.organizationId);

      if (!team) {
        return notFoundResponse("Team");
      }

      const members = await teamsService.getMembers(teamId);

      return successResponse(members);
    } catch (error) {
      return errorResponse("Failed to fetch team members", error);
    }
  }
);

/**
 * POST /teams/:teamId/members - Add a member to a team
 */
export const POST = withAuth<TeamMember, "/teams/[teamId]/members">(
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
        addMemberValidator
      );
      if (parseError) {
        return parseError;
      }

      // Verify the target user exists and is in the same org
      const targetUser = await usersService.findById(
        body.userId,
        user.organizationId
      );
      if (!targetUser) {
        return notFoundResponse("User");
      }

      const input: AddTeamMemberInput = {
        ...body,
        teamId,
      };

      const member = await teamsService.addMember(input);

      return successResponse(member);
    } catch (error) {
      return errorResponse("Failed to add team member", error);
    }
  }
);
