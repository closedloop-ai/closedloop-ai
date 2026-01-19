import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateUserSchema } from "../schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  _request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { id } = await params;

    const user = await database.user.findUnique({
      where: { id },
    });

    if (!user) {
      return notFoundResponse("User");
    }

    return successResponse(user as User);
  } catch (error) {
    return errorResponse("Failed to fetch user", error);
  }
}

export async function PUT(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { id } = await params;

    const existing = await database.user.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("User");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateUserSchema
    );
    if (parseError) {
      return parseError;
    }

    const user = await database.user.update({
      where: { id },
      data: body,
    });

    return successResponse(user as User);
  } catch (error) {
    return errorResponse("Failed to update user", error);
  }
}

// Note: DELETE intentionally not implemented - users should be deactivated, not deleted
// This preserves audit trail and referential integrity
