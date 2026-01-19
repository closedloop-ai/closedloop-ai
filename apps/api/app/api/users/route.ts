import { createUserSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  forbiddenResponse,
  getAuthContext,
  isErrorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

export async function GET(
  _request: Request
): Promise<NextResponse<ApiResult<User[]>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    // Filter users by the authenticated user's organization
    const users = await database.user.findMany({
      where: { organizationId: authContext.organizationId },
      orderBy: { createdAt: "desc" },
    });

    return successResponse(users as User[]);
  } catch (error) {
    return errorResponse("Failed to fetch users", error);
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const body = await parseBody(request, createUserSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Users can only create new users in their own organization
    if (body.organizationId !== authContext.organizationId) {
      return forbiddenResponse();
    }

    const user = await database.user.create({
      data: {
        organizationId: body.organizationId,
        email: body.email,
        name: body.name,
        avatarUrl: body.avatarUrl,
        role: body.role ?? "ENGINEER",
      },
    });

    return successResponse(user as User);
  } catch (error) {
    return errorResponse("Failed to create user", error);
  }
}
