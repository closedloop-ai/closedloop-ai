import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import type { UpdateUserInput, User } from "@repo/api/src/types/organization";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { id } = await params;
    const user = await database.user.findUnique({
      where: { id },
    });

    if (!user) {
      return NextResponse.json(failure("User not found"), { status: 404 });
    }

    return NextResponse.json(success(user as User));
  } catch (error) {
    console.error("Failed to fetch user:", error);
    return NextResponse.json(failure("Failed to fetch user"));
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<User>>> {
  try {
    const { id } = await params;
    const body = (await request.json()) as Omit<UpdateUserInput, "id">;

    const user = await database.user.update({
      where: { id },
      data: body,
    });

    return NextResponse.json(success(user as User));
  } catch (error) {
    console.error("Failed to update user:", error);
    return NextResponse.json(failure("Failed to update user"));
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.user.delete({ where: { id } });
    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete user:", error);
    return NextResponse.json(failure("Failed to delete user"));
  }
}
