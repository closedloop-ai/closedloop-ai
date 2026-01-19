import { createProjectSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  isErrorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

// TODO: Add org filtering once auth middleware provides organizationId
export async function GET(
  _request: Request
): Promise<NextResponse<ApiResult<Project[]>>> {
  try {
    const projects = await database.project.findMany({
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
    const body = await parseBody(request, createProjectSchema);
    if (isErrorResponse(body)) {
      return body;
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
