import type { ApiResult } from "@repo/api/src/types/common";
import type { Workstream } from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateWorkstreamSchema } from "../schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  _request: Request,
  { params }: IdRouteParams
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Workstream>>> {
  try {
    const { id } = await params;

    const existing = await database.workstream.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Workstream");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateWorkstreamSchema
    );
    if (parseError) {
      return parseError;
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;

    const existing = await database.workstream.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Workstream");
    }

    await database.workstream.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete workstream", error);
  }
}
