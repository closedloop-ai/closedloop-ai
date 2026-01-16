import type {
  Artifact,
  ArtifactWithWorkstream,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream>>> {
  try {
    const { id } = await params;
    const artifact = await database.artifact.findUnique({
      where: { id },
      include: {
        workstream: {
          select: {
            id: true,
            title: true,
            state: true,
            project: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!artifact) {
      return NextResponse.json(failure("Artifact not found"), { status: 404 });
    }

    return NextResponse.json(success(artifact as ArtifactWithWorkstream));
  } catch (error) {
    console.error("Failed to fetch artifact:", error);
    return NextResponse.json(failure("Failed to fetch artifact"));
  }
}

export async function PUT(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id } = await params;
    const body = (await request.json()) as Omit<UpdateArtifactInput, "id">;

    const artifact = await database.artifact.update({
      where: { id },
      data: body,
    });

    return NextResponse.json(success(artifact as Artifact));
  } catch (error) {
    console.error("Failed to update artifact:", error);
    return NextResponse.json(failure("Failed to update artifact"));
  }
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.artifact.delete({ where: { id } });
    return NextResponse.json(success({ deleted: true }));
  } catch (error) {
    console.error("Failed to delete artifact:", error);
    return NextResponse.json(failure("Failed to delete artifact"));
  }
}
