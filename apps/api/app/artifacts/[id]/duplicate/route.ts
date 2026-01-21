import type { Artifact } from "@repo/api/src/types/artifact";
import { database } from "@repo/database";
import {
  buildArtifactScopeCondition,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const POST = withAuth<Artifact, "/artifacts/[id]/duplicate">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const original = await database.artifact.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
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
);
