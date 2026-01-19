import { createUserSchema } from "@repo/api/src/schemas/organization";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";
import {
  errorResponse,
  isErrorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<User[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");

    if (!organizationId) {
      return NextResponse.json(failure("organizationId is required"), {
        status: 400,
      });
    }

    const users = await database.user.findMany({
      where: { organizationId },
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
    const body = await parseBody(request, createUserSchema);
    if (isErrorResponse(body)) {
      return body;
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
