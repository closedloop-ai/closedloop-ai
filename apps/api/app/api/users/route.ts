import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type { CreateUserInput, User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

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

    return NextResponse.json(success(users as User[]));
  } catch (error) {
    console.error("Failed to fetch users:", error);
    return NextResponse.json(failure("Failed to fetch users"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const body = (await request.json()) as CreateUserInput;

    const user = await database.user.create({
      data: {
        organizationId: body.organizationId,
        email: body.email,
        name: body.name,
        avatarUrl: body.avatarUrl,
        role: body.role ?? "ENGINEER",
      },
    });

    return NextResponse.json(success(user as User));
  } catch (error) {
    console.error("Failed to create user:", error);
    return NextResponse.json(failure("Failed to create user"), {
      status: 500,
    });
  }
}
