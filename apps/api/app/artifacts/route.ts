import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { database } from "@repo/database";
import {
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
  generateDocumentSlug,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createArtifactSchema } from "./schemas";

export const GET = withAuth<ArtifactWithWorkstream[], "/artifacts">(
  async ({ user }, request) => {
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
          project: { organizationId: user.organizationId },
        },
        include: artifactIncludeWithContext,
        orderBy: { createdAt: "desc" },
      });

      return successResponse(artifacts as ArtifactWithWorkstream[]);
    } catch (error) {
      return errorResponse("Failed to fetch artifacts", error);
    }
  }
);

export const POST = withAuth<Artifact, "/artifacts">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactSchema
      );
      if (parseError) {
        return parseError;
      }

      // Verify project exists and belongs to user's organization if specified
      if (body.projectId) {
        const project = await database.project.findUnique({
          where: { id: body.projectId, organizationId: user.organizationId },
        });
        if (!project) {
          return notFoundResponse("Project");
        }
      }

      // Use transaction to ensure atomic operations
      const artifact = await database.$transaction(async (tx) => {
        // Auto-create default project if no projectId or workstreamId provided
        let projectId: string | undefined = body.projectId ?? undefined;
        if (!(projectId || body.workstreamId)) {
          projectId = await getOrCreateDefaultProject(tx, user.organizationId);
        }

        // Auto-generate documentSlug if not provided (required for versioning)
        const documentSlug =
          body.documentSlug ?? generateDocumentSlug(body.fileName, body.title);

        // Build scope and get next version (marks existing as not latest)
        const scopeCondition = buildArtifactScopeCondition({
          workstreamId: body.workstreamId,
          projectId,
          type: body.type,
          documentSlug,
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
);
