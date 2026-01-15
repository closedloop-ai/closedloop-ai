import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type {
  UpdateWorkstreamInput,
  Workstream,
} from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const { id } = await params;
    const workstream = await database.workstream.findUnique({
      where: { id },
    });

    if (!workstream) {
      return NextResponse.json(failure("Workstream not found"), {
        status: 404,
      });
    }

    return NextResponse.json(success(workstream as Workstream));
  } catch (error) {
    console.error("Failed to fetch workstream:", error);
    return NextResponse.json(failure("Failed to fetch workstream"));
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const { id } = await params;
    const body = (await request.json()) as Omit<UpdateWorkstreamInput, "id">;

    // If state is being changed, update stateChangedAt
    const updateData: Record<string, unknown> = { ...body };
    if (body.state) {
      updateData.stateChangedAt = new Date();
    }

    const workstream = await database.workstream.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json(success(workstream as Workstream));
  } catch (error) {
    console.error("Failed to update workstream:", error);
    return NextResponse.json(failure("Failed to update workstream"));
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.workstream.delete({ where: { id } });
    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete workstream:", error);
    return NextResponse.json(failure("Failed to delete workstream"));
  }
}
