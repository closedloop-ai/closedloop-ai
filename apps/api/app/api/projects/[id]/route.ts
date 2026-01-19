import { updateProjectSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  type RouteParams,
  successResponse,
} from "@/lib/route-utils";

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const { id } = await params;
    const project = await database.project.findUnique({
      where: { id },
    });

    if (!project) {
      return notFoundResponse("Project");
    }

    return successResponse(project as Project);
  } catch (error) {
    return errorResponse("Failed to fetch project", error);
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const { id } = await params;
    const body = await parseBody(request, updateProjectSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    const data: Prisma.ProjectUpdateInput = {
      name: body.name,
      description: body.description,
      settings: body.settings as Prisma.InputJsonValue,
    };

    const project = await database.project.update({
      where: { id },
      data,
    });

    return successResponse(project as Project);
  } catch (error) {
    return errorResponse("Failed to update project", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.project.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete project", error);
  }
}
