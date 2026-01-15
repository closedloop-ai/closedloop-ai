import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  Project,
} from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<Project[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    const projects = await database.project.findMany({
      where: organizationId ? { organizationId } : undefined,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(success(projects));
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return NextResponse.json(failure("Failed to fetch projects"));
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const body = (await request.json()) as CreateProjectInput;

    const project = await database.project.create({
      data: {
        organizationId: body.organizationId,
        name: body.name,
        description: body.description,
      },
    });

    return NextResponse.json(success(project));
  } catch (error) {
    console.error("Failed to create project:", error);
    return NextResponse.json(failure("Failed to create project"));
  }
}
