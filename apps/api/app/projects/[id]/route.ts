import type { ApiResult } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateProjectSchema } from "../schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  _request: Request,
  { params }: IdRouteParams
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const { id } = await params;

    const existing = await database.project.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Project");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateProjectSchema
    );
    if (parseError) {
      return parseError;
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;

    const existing = await database.project.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Project");
    }

    await database.project.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete project", error);
  }
}
