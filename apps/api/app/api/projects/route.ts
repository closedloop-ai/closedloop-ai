import { createProjectSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type { Project } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

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

    return NextResponse.json(success(projects as Project[]));
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return NextResponse.json(failure("Failed to fetch projects"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Project>>> {
  try {
    const rawBody = await request.json();
    const parseResult = createProjectSchema.safeParse(rawBody);

    if (!parseResult.success) {
      const errorMessage = parseResult.error.issues
        .map((issue) => issue.message)
        .join(", ");
      return NextResponse.json(failure(errorMessage), { status: 400 });
    }

    const body = parseResult.data;

    const project = await database.project.create({
      data: {
        organizationId: body.organizationId,
        name: body.name,
        description: body.description,
      },
    });

    return NextResponse.json(success(project as Project));
  } catch (error) {
    console.error("Failed to create project:", error);
    return NextResponse.json(failure("Failed to create project"), {
      status: 500,
    });
  }
}
