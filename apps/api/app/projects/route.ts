import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  ProjectPriority,
  ProjectWithDetails,
} from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "../users/service";
import { createProjectSchema } from "./schemas";
import { projectsService } from "./service";

/**
 * GET /projects - List all projects
 * Query params:
 *   - teamId: Filter by team
 */
export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<ProjectWithDetails[]>>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const user = await usersService.findByClerkId(userId);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(request.url);
    const teamId = url.searchParams.get("teamId");

    const projects = teamId
      ? await projectsService.findByTeam(teamId)
      : await projectsService.findByOrganization(user.organizationId);

    return successResponse(
      projects.map((p) => projectsService.toProjectWithDetails(p))
    );
  } catch (error) {
    return errorResponse("Failed to fetch projects", error);
  }
}

/**
 * POST /projects - Create a new project
 */
export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<ProjectWithDetails>>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const user = await usersService.findByClerkId(userId);
    if (!user) {
      return unauthorizedResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createProjectSchema
    );
    if (parseError) {
      return parseError;
    }

    const input: CreateProjectInput = {
      organizationId: user.organizationId,
      name: body.name,
      description: body.description,
      priority: body.priority as ProjectPriority | undefined,
      ownerId: body.ownerId,
      targetDate: body.targetDate ? new Date(body.targetDate) : undefined,
      teamIds: body.teamIds,
    };

    const project = await projectsService.create(input);

    // Fetch the full project with details
    const projectWithDetails = await projectsService.findById(project.id);

    if (!projectWithDetails) {
      return errorResponse(
        "Project created but could not be retrieved",
        new Error("Project not found")
      );
    }

    return successResponse(
      projectsService.toProjectWithDetails(projectWithDetails)
    );
  } catch (error) {
    return errorResponse("Failed to create project", error);
  }
}
