import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { updateUserSchema } from "../schemas";
import { usersService } from "../service";

export async function GET(
  _: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { orgId } = await auth();
    const { id } = await params;

    if (orgId !== id) {
      return forbiddenResponse();
    }

    const user = await usersService.findById(id);

    if (!user) {
      return notFoundResponse("User");
    }

    return successResponse(user);
  } catch (error) {
    return errorResponse("Failed to fetch user", error);
  }
}

export async function PUT(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { orgId } = await auth();
    if (!orgId) {
      return unauthorizedResponse();
    }

    const { id } = await params;

    const existing = await database.user.findUnique({
      where: { id, organizationId: orgId },
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

    const user = await usersService.update(id, body);

    return successResponse(user as User);
  } catch (error) {
    return errorResponse("Failed to update user", error);
  }
}

// Note: DELETE intentionally not implemented - users should be deactivated, not deleted
// This preserves audit trail and referential integrity
