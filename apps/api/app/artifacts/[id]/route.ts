import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import { artifactIncludeWithContext } from "@/app/artifacts/artifact-utils";
import {
  deleteResponse,
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateArtifactSchema } from "../schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  _request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream>>> {
  try {
    const { id } = await params;

    const artifact = await database.artifact.findUnique({
      where: { id },
      include: artifactIncludeWithContext,
    });

    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    return successResponse(artifact as ArtifactWithWorkstream);
  } catch (error) {
    return errorResponse("Failed to fetch artifact", error);
  }
}

export async function PUT(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id } = await params;

    const existing = await database.artifact.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateArtifactSchema
    );
    if (parseError) {
      return parseError;
    }

    const artifact = await database.artifact.update({
      where: { id },
      data: body,
    });

    return successResponse(artifact as Artifact);
  } catch (error) {
    return errorResponse("Failed to update artifact", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;

    const existing = await database.artifact.findUnique({
      where: { id },
    });

    if (!existing) {
      return notFoundResponse("Artifact");
    }

    await database.artifact.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete artifact", error);
  }
}
