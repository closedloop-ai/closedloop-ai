import { updateWorkstreamSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { Workstream } from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
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
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const { id } = await params;
    const workstream = await database.workstream.findUnique({
      where: { id },
    });

    if (!workstream) {
      return notFoundResponse("Workstream");
    }

    return successResponse(workstream as Workstream);
  } catch (error) {
    return errorResponse("Failed to fetch workstream", error);
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const { id } = await params;
    const body = await parseBody(request, updateWorkstreamSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // If state is being changed, update stateChangedAt
    const updateData: Record<string, unknown> = { ...body };
    if (body.state) {
      updateData.stateChangedAt = new Date();
    }

    const workstream = await database.workstream.update({
      where: { id },
      data: updateData,
    });

    return successResponse(workstream as Workstream);
  } catch (error) {
    return errorResponse("Failed to update workstream", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.workstream.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete workstream", error);
  }
}
