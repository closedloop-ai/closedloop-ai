import { updateArtifactSchema } from "@repo/api/src/schemas/organization";
import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import { artifactIncludeWithContext } from "@/lib/artifact-utils";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  getAuthContext,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  type RouteParams,
  successResponse,
  unauthorizedResponse,
  verifyArtifactAccess,
} from "@/lib/route-utils";

export async function GET(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id } = await params;
    const { exists, hasAccess } = await verifyArtifactAccess(
      id,
      authContext.organizationId
    );

    if (!exists) {
      return notFoundResponse("Artifact");
    }

    if (!hasAccess) {
      return forbiddenResponse();
    }

    // Fetch with the full include structure for response
    const artifact = await database.artifact.findUnique({
      where: { id },
      include: artifactIncludeWithContext,
    });

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
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id } = await params;
    const { exists, hasAccess } = await verifyArtifactAccess(
      id,
      authContext.organizationId
    );

    if (!exists) {
      return notFoundResponse("Artifact");
    }

    if (!hasAccess) {
      return forbiddenResponse();
    }

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
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id } = await params;
    const { exists, hasAccess } = await verifyArtifactAccess(
      id,
      authContext.organizationId
    );

    if (!exists) {
      return notFoundResponse("Artifact");
    }

    if (!hasAccess) {
      return forbiddenResponse();
    }

    await database.artifact.delete({ where: { id } });
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete artifact", error);
  }
}
