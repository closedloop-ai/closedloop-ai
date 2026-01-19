import { createArtifactSchema } from "@repo/api/src/schemas/organization";
import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  buildArtifactScopeCondition,
  prepareArtifactVersion,
} from "@/lib/artifact-utils";
import {
  errorResponse,
  forbiddenResponse,
  getAuthContext,
  isErrorResponse,
  notFoundResponse,
  parseBody,
  type RouteParams,
  successResponse,
  unauthorizedResponse,
  verifyWorkstreamAccess,
} from "@/lib/route-utils";

export async function GET(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact[]>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id: workstreamId } = await params;

    const { exists, hasAccess } = await verifyWorkstreamAccess(
      workstreamId,
      authContext.organizationId
    );

    if (!exists) {
      return notFoundResponse("Workstream");
    }

    if (!hasAccess) {
      return forbiddenResponse();
    }

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
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id: workstreamId } = await params;

    const { exists, hasAccess } = await verifyWorkstreamAccess(
      workstreamId,
      authContext.organizationId
    );

    if (!exists) {
      return notFoundResponse("Workstream");
    }

    if (!hasAccess) {
      return forbiddenResponse();
    }

    const body = await parseBody(request, createArtifactSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Use transaction to ensure atomic isLatest update and version increment
    const artifact = await database.$transaction(async (tx) => {
      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId,
        type: body.type,
        documentSlug: body.documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          workstreamId,
          type: body.type,
          title: body.title,
          content: body.content,
          externalUrl: body.externalUrl,
          generatedBy: body.generatedBy,
          documentSlug: body.documentSlug,
          version: nextVersion,
          isLatest: true,
        },
      });
    });

    return successResponse(artifact as Artifact);
  } catch (error) {
    return errorResponse("Failed to create artifact", error);
  }
}
