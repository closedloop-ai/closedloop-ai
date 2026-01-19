import { createProjectSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  forbiddenResponse,
  getAuthContext,
  isErrorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

export async function GET(
  _request: Request
): Promise<NextResponse<ApiResult<Project[]>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    // Filter projects by user's organization
    const projects = await database.project.findMany({
      where: { organizationId: authContext.organizationId },
      orderBy: { createdAt: "desc" },
    });

    return successResponse(projects as Project[]);
  } catch (error) {
    return errorResponse("Failed to fetch projects", error);
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const body = await parseBody(request, createProjectSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Verify the user is creating a project in their own organization
    if (body.organizationId !== authContext.organizationId) {
      return forbiddenResponse();
    }

    const project = await database.project.create({
      data: {
        organizationId: body.organizationId,
        name: body.name,
        description: body.description,
      },
    });

    return successResponse(project as Project);
  } catch (error) {
    return errorResponse("Failed to create project", error);
  }
}
