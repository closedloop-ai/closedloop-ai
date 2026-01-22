import type { ApiResult } from "@repo/api/src/types/common";
import type {
  Team,
  TeamWithCounts,
  UpdateTeamInput,
} from "@repo/api/src/types/teams";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "../../users/service";
import { teamsService } from "../service";

type TeamIdRouteParams = IdRouteParams<"teamId">;

const updateTeamSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().optional(),
});

/**
 * GET /teams/:teamId - Get a single team by ID
 */
export async function GET(
  _: Request,
  { params }: TeamIdRouteParams
): Promise<NextResponse<ApiResult<TeamWithCounts>>> {
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

    // Check user has access (is member of team or same org)
    if (team.organizationId !== user.organizationId) {
      return forbiddenResponse();
    }

    const response: TeamWithCounts = {
      id: team.id,
      organizationId: team.organizationId,
      name: team.name,
      slug: team.slug,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      memberCount: team._count.members,
      projectCount: team._count.projects,
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch team", error);
  }
}

/**
 * PUT /teams/:teamId - Update a team
 */
export async function PUT(
  request: Request,
  { params }: TeamIdRouteParams
): Promise<NextResponse<ApiResult<Team>>> {
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
      updateTeamSchema
    );

    if (parseError) {
      return parseError;
    }

    const input: Omit<UpdateTeamInput, "id"> = {
      ...(body.name && { name: body.name }),
      ...(body.slug && { slug: body.slug }),
    };

    const updatedTeam = await teamsService.update(teamId, input);

    return successResponse(updatedTeam as Team);
  } catch (error) {
    return errorResponse("Failed to update team", error);
  }
}

/**
 * DELETE /teams/:teamId - Delete a team
 */
export async function DELETE(
  _: Request,
  { params }: TeamIdRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
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

    // Check user has permission (must be team owner)
    const hasPermission = await teamsService.hasRole(teamId, user.id, "OWNER");
    if (!hasPermission) {
      return forbiddenResponse();
    }

    await teamsService.delete(teamId);

    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete team", error);
  }
}
