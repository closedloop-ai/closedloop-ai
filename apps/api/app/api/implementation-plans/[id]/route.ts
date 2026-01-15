import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type {
  ImplementationPlan,
  ImplementationPlanWithPrd,
  UpdateImplementationPlanInput,
} from "@repo/api/src/types/implementation-plan";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<ImplementationPlanWithPrd>>> {
  const { id } = await params;

  try {
    const plan = await database.implementationPlan.findUnique({
      where: { id },
      include: {
        sourcePrd: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    if (!plan) {
      return NextResponse.json(failure("Implementation plan not found"), {
        status: 404,
      });
    }

    return NextResponse.json(success(plan));
  } catch (error) {
    console.error("Failed to fetch implementation plan:", error);
    return NextResponse.json(failure("Failed to fetch implementation plan"), {
      status: 500,
    });
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<ImplementationPlan>>> {
  const { id } = await params;

  try {
    const input: Omit<UpdateImplementationPlanInput, "id"> =
      await request.json();

    const plan = await database.implementationPlan.update({
      where: { id },
      data: input,
    });

    return NextResponse.json(success(plan));
  } catch (error) {
    console.error("Failed to update implementation plan:", error);
    return NextResponse.json(failure("Failed to update implementation plan"), {
      status: 500,
    });
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  const { id } = await params;

  try {
    await database.implementationPlan.delete({
      where: { id },
    });

    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete implementation plan:", error);
    return NextResponse.json(failure("Failed to delete implementation plan"), {
      status: 500,
    });
  }
}
