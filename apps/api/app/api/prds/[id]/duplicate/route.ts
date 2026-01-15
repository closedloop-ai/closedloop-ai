import { type ApiResult, failure, success } from "@repo/api/src/types/common";
import type { Prd } from "@repo/api/src/types/prd";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Prd>>> {
  const { id } = await params;

  try {
    const original = await database.prd.findUnique({
      where: { id },
    });

    if (!original) {
      return NextResponse.json(failure("PRD not found"), { status: 404 });
    }

    const prd = await database.prd.create({
      data: {
        title: `${original.title} (Copy)`,
        fileName: `${original.fileName.replace(".md", "")}-copy.md`,
        approver: original.approver,
        status: "Draft",
        tags: original.tags,
        template: original.template,
        content: original.content,
      },
    });

    return NextResponse.json(success(prd), { status: 201 });
  } catch (error) {
    console.error("Failed to duplicate PRD:", error);
    return NextResponse.json(failure("Failed to duplicate PRD"), {
      status: 500,
    });
  }
}
