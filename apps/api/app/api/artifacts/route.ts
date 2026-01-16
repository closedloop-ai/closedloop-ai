import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const latestOnly = searchParams.get("latestOnly") !== "false";
    const workstreamId = searchParams.get("workstreamId");
    const projectId = searchParams.get("projectId");

    const artifacts = await database.artifact.findMany({
      where: {
        ...(type ? { type: type as ArtifactType } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
      },
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
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(success(artifacts as ArtifactWithWorkstream[]));
  } catch (error) {
    console.error("Failed to fetch artifacts:", error);
    return NextResponse.json(failure("Failed to fetch artifacts"), {
      status: 500,
    });
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const body = (await request.json()) as CreateArtifactInput;

    // If there's a workstreamId, mark existing artifacts of same type as not latest
    if (body.workstreamId) {
      await database.artifact.updateMany({
        where: {
          workstreamId: body.workstreamId,
          type: body.type,
          isLatest: true,
        },
        data: { isLatest: false },
      });
    }

    // Get latest version number
    const latestArtifact = await database.artifact.findFirst({
      where: {
        ...(body.workstreamId ? { workstreamId: body.workstreamId } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        type: body.type,
      },
      orderBy: { version: "desc" },
    });

    const artifact = await database.artifact.create({
      data: {
        workstreamId: body.workstreamId,
        projectId: body.projectId,
        type: body.type,
        title: body.title,
        fileName: body.fileName,
        approver: body.approver,
        status: body.status ?? "DRAFT",
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
    return NextResponse.json(failure("Failed to create artifact"), {
      status: 500,
    });
  }
}
