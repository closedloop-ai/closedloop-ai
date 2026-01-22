import type { ApiResult } from "@repo/api/src/types/common";
import type { TeamMember, TeamRole } from "@repo/api/src/types/teams";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "../../../../users/service";
import { teamsService, toTeamMemberApi } from "../../../service";

type MemberRouteParams = {
  params: Promise<{ teamId: string; userId: string }>;
};

const updateMemberSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]),
});

/**
 * PUT /teams/:teamId/members/:userId - Update a member's role
 */
export async function PUT(
  request: Request,
  { params }: MemberRouteParams
): Promise<NextResponse<ApiResult<TeamMember>>> {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return unauthorizedResponse();
    }

    const currentUser = await usersService.findByClerkId(clerkUserId);
    if (!currentUser) {
      return unauthorizedResponse();
    }

    const { teamId, userId: targetUserId } = await params;
    const team = await teamsService.findById(teamId);

    if (!team) {
      return notFoundResponse("Team");
    }

    // Check user has permission (must be team owner or admin)
    const hasPermission = await teamsService.hasRole(
      teamId,
      currentUser.id,
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
      updateMemberSchema
    );

    if (parseError) {
      return parseError;
    }

    const member = await teamsService.updateMemberRole({
      teamId,
      userId: targetUserId,
      role: body.role as TeamRole,
    });

    return successResponse(toTeamMemberApi(member));
  } catch (error) {
    return errorResponse("Failed to update team member", error);
  }
}

/**
 * DELETE /teams/:teamId/members/:userId - Remove a member from a team
 */
export async function DELETE(
  _: Request,
  { params }: MemberRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return unauthorizedResponse();
    }

    const currentUser = await usersService.findByClerkId(clerkUserId);
    if (!currentUser) {
      return unauthorizedResponse();
    }

    const { teamId, userId: targetUserId } = await params;
    const team = await teamsService.findById(teamId);

    if (!team) {
      return notFoundResponse("Team");
    }

    // Check user has permission (must be team owner or admin)
    const hasPermission = await teamsService.hasRole(
      teamId,
      currentUser.id,
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
}
