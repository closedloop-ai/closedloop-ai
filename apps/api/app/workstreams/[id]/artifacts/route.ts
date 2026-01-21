import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { database } from "@repo/database";
import {
  buildArtifactScopeCondition,
  generateDocumentSlug,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createArtifactSchema } from "../../../artifacts/schemas";

export const GET = withAuth<Artifact[], "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id: workstreamId } = await params;

      const workstream = await database.workstream.findUnique({
        where: {
          id: workstreamId,
          project: { organizationId: user.organizationId },
        },
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
);

export const POST = withAuth<Artifact, "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id: workstreamId } = await params;

      const workstream = await database.workstream.findUnique({
        where: {
          id: workstreamId,
          project: { organizationId: user.organizationId },
        },
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
);
