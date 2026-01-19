import { updateArtifactSchema } from "@repo/api/src/schemas/organization";
import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  deleteResponse,
  errorResponse,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  type RouteParams,
  successResponse,
} from "@/lib/route-utils";

// TODO: Add orgId/projectId to queries for multi-tenant safety once auth context is available
// Pattern: include organizationId/projectId in WHERE clauses to ensure data isolation

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
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
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
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id } = await params;
    const body = await parseBody(request, updateArtifactSchema);
    if (isErrorResponse(body)) {
      return body;
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
  { params }: RouteParams
): Promise<NextResponse<ApiResult<{ deleted: true }>>> {
  try {
    const { id } = await params;
    await database.artifact.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete artifact", error);
  }
}
