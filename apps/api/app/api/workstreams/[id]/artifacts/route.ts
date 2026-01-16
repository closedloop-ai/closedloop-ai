import type {
  Artifact,
  ArtifactType,
  CreateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact[]>>> {
  try {
    const { id: workstreamId } = await params;
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const latestOnly = searchParams.get("latestOnly") === "true";

    const artifacts = await database.artifact.findMany({
      where: {
        workstreamId,
        ...(type ? { type: type as ArtifactType } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(success(artifacts as Artifact[]));
  } catch (error) {
    console.error("Failed to fetch artifacts:", error);
    return NextResponse.json(failure("Failed to fetch artifacts"));
  }
}

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id: workstreamId } = await params;
    const body = (await request.json()) as Omit<
      CreateArtifactInput,
      "workstreamId"
    >;

    // Mark any existing artifacts of the same type as not latest
    await database.artifact.updateMany({
      where: {
        workstreamId,
        type: body.type,
        isLatest: true,
      },
      data: { isLatest: false },
    });

    // Get the latest version number for this artifact type
    const latestArtifact = await database.artifact.findFirst({
      where: {
        workstreamId,
        type: body.type,
      },
      orderBy: { version: "desc" },
    });

    const artifact = await database.artifact.create({
      data: {
        workstreamId,
        type: body.type,
        title: body.title,
        content: body.content,
        externalUrl: body.externalUrl,
        generatedBy: body.generatedBy,
        version: (latestArtifact?.version ?? 0) + 1,
        isLatest: true,
      },
    });

    return NextResponse.json(success(artifact as Artifact));
  } catch (error) {
    console.error("Failed to create artifact:", error);
    return NextResponse.json(failure("Failed to create artifact"));
  }
}
