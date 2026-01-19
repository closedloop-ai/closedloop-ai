import { createWorkstreamSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type {
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import { NextResponse } from "next/server";
import {
  errorResponse,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

// TODO: Add org filtering once auth middleware provides organizationId
export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<Workstream[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const state = searchParams.get("state");
    const search = searchParams.get("search");
    const limit = searchParams.get("limit");

    if (!projectId) {
      return NextResponse.json(failure("projectId is required"), {
        status: 400,
      });
    }

    // Verify project exists
    const project = await database.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return notFoundResponse("Project");
    }

    const workstreams = await database.workstream.findMany({
      where: {
        projectId,
        ...(state ? { state: state as WorkstreamState } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      ...(limit ? { take: Number.parseInt(limit, 10) } : {}),
    });

    return successResponse(workstreams as Workstream[]);
  } catch (error) {
    return errorResponse("Failed to fetch workstreams", error);
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const body = await parseBody(request, createWorkstreamSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Verify project exists
    const project = await database.project.findUnique({
      where: { id: body.projectId },
    });

    if (!project) {
      return notFoundResponse("Project");
    }

    const workstream = await database.workstream.create({
      data: {
        projectId: body.projectId,
        title: body.title,
        description: body.description,
        type: body.type ?? "FEATURE_DELIVERY",
        createdById: body.createdById,
        assignedToId: body.assignedToId,
        hasUIChanges: body.hasUIChanges ?? false,
      },
    });

    return successResponse(workstream as Workstream);
  } catch (error) {
    return errorResponse("Failed to create workstream", error);
  }
}
