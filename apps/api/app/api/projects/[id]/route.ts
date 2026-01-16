import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  Project,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { database, type Prisma } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

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
      return NextResponse.json(failure("Project not found"), { status: 404 });
    }

    return NextResponse.json(success(project as Project));
  } catch (error) {
    console.error("Failed to fetch project:", error);
    return NextResponse.json(failure("Failed to fetch project"));
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const { id } = await params;
    const body = (await request.json()) as Omit<UpdateProjectInput, "id">;

    const data: Prisma.ProjectUpdateInput = {
      name: body.name,
      description: body.description,
      settings: body.settings,
    };

    const project = await database.project.update({
      where: { id },
      data,
    });

    return NextResponse.json(success(project as Project));
  } catch (error) {
    console.error("Failed to update project:", error);
    return NextResponse.json(failure("Failed to update project"));
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.project.delete({ where: { id } });
    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete project:", error);
    return NextResponse.json(failure("Failed to delete project"));
  }
}
