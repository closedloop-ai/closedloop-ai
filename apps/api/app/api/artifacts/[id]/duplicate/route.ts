import type { Artifact } from "@repo/api/src/types/artifact";
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
  notFoundResponse,
  type RouteParams,
  successResponse,
  unauthorizedResponse,
  verifyArtifactAccess,
} from "@/lib/route-utils";

export async function POST(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { id } = await params;

    // Verify access to the original artifact
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

    // Find the original artifact
    const original = await database.artifact.findUnique({
      where: { id },
    });

    if (!original) {
      return notFoundResponse("Artifact");
    }

    // Create a duplicate with a new title, marking previous versions as not latest
    const duplicate = await database.$transaction(async (tx) => {
      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId: original.workstreamId,
        projectId: original.projectId,
        type: original.type,
        documentSlug: original.documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      // Create the new duplicate (preserving documentSlug to stay in same group)
      return tx.artifact.create({
        data: {
          workstreamId: original.workstreamId,
          projectId: original.projectId,
          type: original.type,
          title: `${original.title} (Copy)`,
          fileName: original.fileName
            ? original.fileName.replace(".md", "-copy.md")
            : null,
          approver: original.approver,
          status: "DRAFT",
          content: original.content,
          externalUrl: original.externalUrl,
          generatedBy: original.generatedBy,
          documentSlug: original.documentSlug,
          version: nextVersion,
          isLatest: true,
        },
      });
    });

    return successResponse(duplicate as Artifact);
  } catch (error) {
    return errorResponse("Failed to duplicate artifact", error);
  }
}
