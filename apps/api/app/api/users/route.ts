import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { createUserSchema } from "./schemas";

// TODO: Add org filtering once auth middleware provides organizationId
export async function GET(
  _request: Request
): Promise<NextResponse<ApiResult<User[]>>> {
  try {
    const users = await database.user.findMany({
      orderBy: { createdAt: "desc" },
    });

    return successResponse(users as User[]);
  } catch (error) {
    return errorResponse("Failed to fetch users", error);
  }
}

// TODO: Add org verification once auth middleware provides organizationId
export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createUserSchema
    );
    if (parseError) {
      return parseError;
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
