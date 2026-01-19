import { createArtifactSchema } from "@repo/api/src/schemas/organization";
import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { database } from "@repo/database";
import { NextResponse } from "next/server";
import {
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
} from "@/lib/artifact-utils";
import {
  errorResponse,
  forbiddenResponse,
  getAuthContext,
  isErrorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
  verifyProjectAccess,
  verifyWorkstreamAccess,
} from "@/lib/route-utils";

export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream[]>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const latestOnly = searchParams.get("latestOnly") !== "false";
    const workstreamId = searchParams.get("workstreamId");
    const projectId = searchParams.get("projectId");

    // Verify access to filtered workstream or project if specified
    if (workstreamId) {
      const { hasAccess } = await verifyWorkstreamAccess(
        workstreamId,
        authContext.organizationId
      );
      if (!hasAccess) {
        return forbiddenResponse();
      }
    }

    if (projectId) {
      const { hasAccess } = await verifyProjectAccess(
        projectId,
        authContext.organizationId
      );
      if (!hasAccess) {
        return forbiddenResponse();
      }
    }

    // Fetch artifacts filtered to user's organization via project relationship
    const artifacts = await database.artifact.findMany({
      where: {
        ...(type ? { type: type as ArtifactType } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
        // Filter by organization - artifacts belong to org via project
        project: {
          organizationId: authContext.organizationId,
        },
      },
      include: artifactIncludeWithContext,
      orderBy: { createdAt: "desc" },
    });

    return successResponse(artifacts as ArtifactWithWorkstream[]);
  } catch (error) {
    return errorResponse("Failed to fetch artifacts", error);
  }
}

export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) {
      return unauthorizedResponse();
    }

    const body = await parseBody(request, createArtifactSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Verify access to workstream or project if specified
    if (body.workstreamId) {
      const { hasAccess } = await verifyWorkstreamAccess(
        body.workstreamId,
        authContext.organizationId
      );
      if (!hasAccess) {
        return NextResponse.json(
          failure("Workstream not found or access denied"),
          { status: 403 }
        );
      }
    }

    if (body.projectId) {
      const { hasAccess } = await verifyProjectAccess(
        body.projectId,
        authContext.organizationId
      );
      if (!hasAccess) {
        return NextResponse.json(
          failure("Project not found or access denied"),
          { status: 403 }
        );
      }
    }

    // Use transaction to ensure atomic operations
    const artifact = await database.$transaction(async (tx) => {
      // Auto-create default project in user's org if no projectId or workstreamId provided
      const projectId =
        body.projectId ||
        (body.workstreamId
          ? undefined
          : await getOrCreateDefaultProject(tx, authContext.organizationId));

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId: body.workstreamId,
        projectId,
        type: body.type,
        documentSlug: body.documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          workstreamId: body.workstreamId,
          projectId,
          type: body.type,
          title: body.title,
          fileName: body.fileName,
          approver: body.approver,
          status: body.status ?? "DRAFT",
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
