import type { ApiResult } from "@repo/api/src/types/common";
import type {
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { createWorkstreamSchema } from "./schemas";

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
      return badRequestResponse("projectId is required");
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
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createWorkstreamSchema
    );
    if (parseError) {
      return parseError;
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
        createdById: userId,
        assignedToId: body.assignedToId,
        hasUIChanges: body.hasUIChanges ?? false,
      },
    });

    return successResponse(workstream as Workstream);
  } catch (error) {
    return errorResponse("Failed to create workstream", error);
  }
}
