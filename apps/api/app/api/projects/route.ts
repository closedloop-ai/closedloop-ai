import { createProjectSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";
import {
  errorResponse,
  isErrorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<Project[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json(failure("organizationId is required"), {
        status: 400,
      });
    }

    const projects = await database.project.findMany({
      where: { organizationId },
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
