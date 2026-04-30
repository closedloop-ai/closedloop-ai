import { DocumentType } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import {
  type DocumentWithRegenerationContext,
  documentIncludeWithUser,
  toDocument,
  workstreamToWithDocuments,
} from "./document-utils";

/**
 * Find a document with the workstream + PRD context needed to regenerate or
 * generate. Returns null when the artifact isn't a DOCUMENT in the org.
 */
async function findWithRegenerationContext(
  id: string,
  organizationId: string
): Promise<DocumentWithRegenerationContext | null> {
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { id, organizationId },
      include: {
        ...documentIncludeWithUser,
        workstream: {
          include: {
            project: true,
            artifacts: {
              where: {
                type: ArtifactType.DOCUMENT,
                subtype: DocumentType.Prd,
              },
              include: documentIncludeWithUser,
              take: 1,
            },
          },
        },
      },
    })
  );
  if (artifact?.type !== ArtifactType.DOCUMENT) {
    return null;
  }
  const base = toDocument(artifact);
  const workstream = workstreamToWithDocuments(artifact.workstream);
  return {
    ...base,
    workstream: workstream
      ? {
          id: workstream.id,
          organizationId: workstream.organizationId,
          projectId: workstream.projectId,
          title: workstream.title,
          description: workstream.description,
          state: workstream.state,
          createdAt: workstream.createdAt,
          updatedAt: workstream.updatedAt,
          project: workstream.project
            ? {
                id: workstream.project.id,
                organizationId: workstream.project.organizationId,
                name: workstream.project.name,
                settings: workstream.project.settings,
              }
            : null,
          documents: workstream.documents,
        }
      : null,
  };
}

/** Find any pending/queued/running workflow run for a workstream. */
function findPendingWorkflowRun(workstreamId: string, workflowName: string) {
  return withDb((db) =>
    db.gitHubActionRun.findFirst({
      where: {
        workstreamId,
        workflowName,
        status: { in: ["PENDING", "QUEUED", "RUNNING"] },
      },
    })
  );
}

export const documentGenerationService = {
  findWithRegenerationContext,
  findPendingWorkflowRun,
};
