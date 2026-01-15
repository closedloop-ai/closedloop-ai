import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type { Prd, UpdatePrdInput } from "@repo/api/src/types/prd";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Prd>>> {
  const { id } = await params;

  try {
    const prd = await database.prd.findUnique({
      where: { id },
    });

    if (!prd) {
      return NextResponse.json(failure("PRD not found"), { status: 404 });
    }

    return NextResponse.json(success(prd));
  } catch (error) {
    console.error("Failed to fetch PRD:", error);
    return NextResponse.json(failure("Failed to fetch PRD"), { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Prd>>> {
  const { id } = await params;

  try {
    const input: Omit<UpdatePrdInput, "id"> = await request.json();

    const prd = await database.prd.update({
      where: { id },
      data: input,
    });

    return NextResponse.json(success(prd));
  } catch (error) {
    console.error("Failed to update PRD:", error);
    return NextResponse.json(failure("Failed to update PRD"), { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  const { id } = await params;

  try {
    await database.prd.delete({
      where: { id },
    });

    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete PRD:", error);
    return NextResponse.json(failure("Failed to delete PRD"), { status: 500 });
  }
}
