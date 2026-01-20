import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  buildArtifactScopeCondition,
  generateDocumentSlug,
  prepareArtifactVersion,
} from "@/lib/artifact-utils";
import {
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createArtifactSchema } from "../../../artifacts/schemas";

// TODO: Add org access verification once auth middleware provides organizationId
export async function GET(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Artifact[]>>> {
  try {
    const { id: workstreamId } = await params;

    // Verify workstream exists
    const workstream = await database.workstream.findUnique({
      where: { id: workstreamId },
    });

    if (!workstream) {
      return notFoundResponse("Workstream");
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
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const { id: workstreamId } = await params;

    // Verify workstream exists
    const workstream = await database.workstream.findUnique({
      where: { id: workstreamId },
    });

    if (!workstream) {
      return notFoundResponse("Workstream");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createArtifactSchema
    );
    if (parseError) {
      return parseError;
    }

    // Use transaction to ensure atomic isLatest update and version increment
    const artifact = await database.$transaction(async (tx) => {
      // Auto-generate documentSlug if not provided (required for versioning)
      const documentSlug =
        body.documentSlug ?? generateDocumentSlug(body.fileName, body.title);

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId,
        type: body.type,
        documentSlug,
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
          documentSlug,
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
