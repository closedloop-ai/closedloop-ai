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
  isErrorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

// TODO: Add org filtering once auth middleware provides organizationId
export async function GET(
  request: Request
): Promise<NextResponse<ApiResult<ArtifactWithWorkstream[]>>> {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const latestOnly = searchParams.get("latestOnly") !== "false";
    const workstreamId = searchParams.get("workstreamId");
    const projectId = searchParams.get("projectId");

    // Fetch artifacts (org filtering will be added via auth middleware)
    const artifacts = await database.artifact.findMany({
      where: {
        ...(type ? { type: type as ArtifactType } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      include: artifactIncludeWithContext,
      orderBy: { createdAt: "desc" },
    });

    return successResponse(artifacts as ArtifactWithWorkstream[]);
  } catch (error) {
    return errorResponse("Failed to fetch artifacts", error);
  }
}

// TODO: Add org verification once auth middleware provides organizationId
export async function POST(
  request: Request
): Promise<NextResponse<ApiResult<Artifact>>> {
  try {
    const body = await parseBody(request, createArtifactSchema);
    if (isErrorResponse(body)) {
      return body;
    }

    // Verify workstream exists if specified
    if (body.workstreamId) {
      const workstream = await database.workstream.findUnique({
        where: { id: body.workstreamId },
      });
      if (!workstream) {
        return NextResponse.json(failure("Workstream not found"), {
          status: 404,
        });
      }
    }

    // Verify project exists if specified
    if (body.projectId) {
      const project = await database.project.findUnique({
        where: { id: body.projectId },
      });
      if (!project) {
        return NextResponse.json(failure("Project not found"), { status: 404 });
      }
    }

    // Use transaction to ensure atomic operations
    const artifact = await database.$transaction(async (tx) => {
      // Get organizationId from workstream's project or from specified project
      let organizationId: string | undefined;

      if (body.workstreamId) {
        const workstream = await tx.workstream.findUnique({
          where: { id: body.workstreamId },
          include: { project: { select: { organizationId: true } } },
        });
        organizationId = workstream?.project.organizationId;
      } else if (body.projectId) {
        const project = await tx.project.findUnique({
          where: { id: body.projectId },
          select: { organizationId: true },
        });
        organizationId = project?.organizationId;
      }

      // Auto-create default project if no projectId or workstreamId provided
      // Note: This requires an organizationId which should come from auth middleware
      let projectId: string | undefined = body.projectId ?? undefined;
      if (!(projectId || body.workstreamId) && organizationId) {
        projectId = await getOrCreateDefaultProject(tx, organizationId);
      }

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
