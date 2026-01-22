import type { ApiResult } from "@repo/api/src/types/common";
import type {
  AddTeamMemberInput,
  TeamMember,
  TeamRole,
} from "@repo/api/src/types/teams";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import { z } from "zod";
import {
  errorResponse,
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "../../../users/service";
import { teamsService, toTeamMemberApi } from "../../service";

type TeamIdRouteParams = IdRouteParams<"teamId">;

const addMemberSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]).optional(),
});

/**
 * GET /teams/:teamId/members - List all members of a team
 */
export async function GET(
  _: Request,
  { params }: TeamIdRouteParams
): Promise<NextResponse<ApiResult<TeamMember[]>>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const user = await usersService.findByClerkId(userId);
    if (!user) {
      return unauthorizedResponse();
    }

    const { teamId } = await params;
    const team = await teamsService.findById(teamId);

    if (!team) {
      return notFoundResponse("Team");
    }

    // Check user has access (member of team or same org)
    if (team.organizationId !== user.organizationId) {
      return forbiddenResponse();
    }

    const members = await teamsService.getMembers(teamId);

    return successResponse(members.map(toTeamMemberApi));
  } catch (error) {
    return errorResponse("Failed to fetch team members", error);
  }
}

/**
 * POST /teams/:teamId/members - Add a member to a team
 */
export async function POST(
  request: Request,
  { params }: TeamIdRouteParams
): Promise<NextResponse<ApiResult<TeamMember>>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const user = await usersService.findByClerkId(userId);
    if (!user) {
      return unauthorizedResponse();
    }

    const { teamId } = await params;
    const team = await teamsService.findById(teamId);

    if (!team) {
      return notFoundResponse("Team");
    }

    // Check user has permission (must be team owner or admin)
    const hasPermission = await teamsService.hasRole(teamId, user.id, "ADMIN");
    if (!hasPermission) {
      return forbiddenResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      addMemberSchema
    );

    if (parseError) {
      return parseError;
    }

    // Verify the target user exists and is in the same org
    const targetUser = await usersService.findById(
      body.userId,
      team.organizationId
    );
    if (!targetUser) {
      return notFoundResponse("User");
    }

    const input: AddTeamMemberInput = {
      teamId,
      userId: body.userId,
      role: body.role as TeamRole | undefined,
    };

    const member = await teamsService.addMember(input);

    return successResponse(toTeamMemberApi(member));
  } catch (error) {
    return errorResponse("Failed to add team member", error);
  }
}
