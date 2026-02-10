import type { TeamMember } from "@repo/api/src/types/teams";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { teamsService } from "../../../service";
import { updateMemberValidator } from "../../../validators";

/**
 * PUT /teams/:teamId/members/:userId - Update a member's role
 */
export const PUT = withAuth<TeamMember, "/teams/[teamId]/members/[userId]">(
  async ({ user }, request, params) => {
    try {
      const { teamId, userId: targetUserId } = await params;
      const team = await teamsService.findById(teamId, user.organizationId);

      if (!team) {
        return notFoundResponse("Team");
      }

      // Check user has permission (must be team owner or admin)
      const hasPermission = await teamsService.hasRole(
        teamId,
        user.id,
        "ADMIN"
      );
      if (!hasPermission) {
        return forbiddenResponse();
      }

      // Check target member exists
      const targetMember = await teamsService.getMember(teamId, targetUserId);
      if (!targetMember) {
        return notFoundResponse("Team member");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateMemberValidator
      );
      if (parseError) {
        return parseError;
      }

      const member = await teamsService.updateMemberRole({
        teamId,
        userId: targetUserId,
        role: body.role,
      });

      return successResponse(member);
    } catch (error) {
      return errorResponse("Failed to update team member", error);
    }
  }
);

/**
 * DELETE /teams/:teamId/members/:userId - Remove a member from a team
 */
export const DELETE = withAuth<
  { deleted: true },
  "/teams/[teamId]/members/[userId]"
>(async ({ user }, _, params) => {
  try {
    const { teamId, userId: targetUserId } = await params;
    const team = await teamsService.findById(teamId, user.organizationId);

    if (!team) {
      return notFoundResponse("Team");
    }

    // Check user has permission (must be team owner or admin)
    const hasPermission = await teamsService.hasRole(teamId, user.id, "ADMIN");
    if (!hasPermission) {
      return forbiddenResponse();
    }

    // Check target member exists
    const targetMember = await teamsService.getMember(teamId, targetUserId);
    if (!targetMember) {
      return notFoundResponse("Team member");
    }

    // Prevent removing the last owner
    if (targetMember.role === "OWNER") {
      const members = await teamsService.getMembers(teamId);
      const ownerCount = members.filter((m) => m.role === "OWNER").length;
      if (ownerCount <= 1) {
        return errorResponse(
          "Cannot remove the last owner of a team",
          new Error("Last owner"),
          400
        );
      }
    }

    await teamsService.removeMember(teamId, targetUserId);

    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to remove team member", error);
  }
});
