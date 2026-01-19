import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  CreateWorkstreamInput,
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

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

    // Note: Removed project include to avoid N+1 query pattern
    // If project name is needed, fetch it separately or join at the caller level
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

    return NextResponse.json(success(workstreams as Workstream[]));
  } catch (error) {
    console.error("Failed to fetch workstreams:", error);
    return NextResponse.json(failure("Failed to fetch workstreams"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const body = (await request.json()) as CreateWorkstreamInput;

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

    return NextResponse.json(success(workstream as Workstream));
  } catch (error) {
    console.error("Failed to create workstream:", error);
    return NextResponse.json(failure("Failed to create workstream"), {
      status: 500,
    });
  }
}
