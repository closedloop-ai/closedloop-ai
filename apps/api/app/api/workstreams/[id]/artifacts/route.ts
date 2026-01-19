import { createArtifactSchema } from "@repo/api/src/schemas/organization";
import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  isErrorResponse,
  parseBody,
  type RouteParams,
  successResponse,
} from "@/lib/route-utils";

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

    return successResponse(artifacts as Artifact[]);
  } catch (error) {
    return errorResponse("Failed to fetch artifacts", error);
  }
}

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id: workstreamId } = await params;
    const body = await parseBody(request, createArtifactSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Use transaction to ensure atomic isLatest update and version increment
    const artifact = await database.$transaction(async (tx) => {
      // Mark any existing artifacts of the same type as not latest
      await tx.artifact.updateMany({
        where: {
          workstreamId,
          type: body.type,
          isLatest: true,
        },
        data: { isLatest: false },
      });

      // Get the latest version number for this artifact type in this workstream
      const latestArtifact = await tx.artifact.findFirst({
        where: {
          workstreamId,
          type: body.type,
        },
        orderBy: { version: "desc" },
      });

      return tx.artifact.create({
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
    });

    return successResponse(artifact as Artifact);
  } catch (error) {
    return errorResponse("Failed to create artifact", error);
  }
}
