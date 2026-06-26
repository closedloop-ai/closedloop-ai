import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { artifactLinksService } from "../artifact-links/service";
import {
  type DocumentWithRegenerationContext,
  documentIncludeWithUser,
  type SourceContext,
  toDocument,
} from "./document-utils";
import { documentVersionService } from "./document-version-service";

/**
 * Walk artifact_links PRODUCES edges upward from the artifact to find the
 * nearest source PRD (preferred) or Feature, returning its content.
 *
 * Lineage traversal handles direct (PRD→Plan), nested (PRD→Feature→Plan),
 * and deeper chains. Constraints:
 *  - bounded depth (`SOURCE_LINEAGE_MAX_DEPTH`) — keeps pathological graphs
 *    from fanning out
 *  - visited-id cycle guard — A→B→A terminates instead of looping
 *  - same-project enforcement — only walk through artifacts in the original
 *    document's project, blocking cross-project link contamination
 *  - PRD wins over Feature at the shallowest matching depth — a Plan
 *    whose Feature parent has a PRD grandparent returns the PRD, while a
 *    Plan whose only ancestor is a Feature returns the Feature.
 */
async function findSourcePrdContext(
  artifactId: string,
  organizationId: string,
  startProjectId?: string | null
): Promise<SourceContext | null> {
  const projectId =
    startProjectId ??
    (await withDb((db) =>
      db.artifact
        .findUnique({
          where: { id: artifactId, organizationId },
          select: { projectId: true },
        })
        .then((row) => row?.projectId ?? null)
    ));
  if (!projectId) {
    return null;
  }

  const visited = new Set<string>([artifactId]);
  let frontier = [artifactId];
  let fallback: SourceContext | null = null;

  // Cost model: 2 serial DB round-trips per depth level (PRODUCES link lookup
  // + parent artifact fetch). Bounded by SOURCE_LINEAGE_MAX_DEPTH; realistic
  // graphs terminate at depth 1–2 (Plan → Feature → PRD).
  for (let depth = 0; depth < SOURCE_LINEAGE_MAX_DEPTH; depth++) {
    const parentLinks = await Promise.all(
      frontier.map((id) =>
        artifactLinksService.findSourceLinks(
          organizationId,
          id,
          LinkType.Produces
        )
      )
    );
    const parentIds = parentLinks
      .flat()
      .map((link) => link.sourceId)
      .filter((id) => !visited.has(id));
    if (parentIds.length === 0) {
      return fallback;
    }
    for (const id of parentIds) {
      visited.add(id);
    }

    const parents = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: parentIds },
          organizationId,
          projectId,
          type: ArtifactType.DOCUMENT,
          subtype: { in: [DocumentType.Prd, DocumentType.Feature] },
        },
        include: documentIncludeWithUser,
      })
    );
    if (parents.length === 0) {
      // No documents at this depth — keep walking through non-document
      // intermediaries (e.g. branch artifacts) using their full PRODUCES
      // parent set.
      frontier = parentIds;
      continue;
    }

    const documents = parents.map(toDocument);
    const prd = documents.find((doc) => doc.type === DocumentType.Prd);
    if (prd) {
      return await buildSourceContext(prd);
    }
    if (!fallback) {
      fallback = await buildSourceContext(documents[0]);
    }
    // Only documents continue the walk — non-document parents at this depth
    // would just re-expand into the same artifacts we already considered.
    frontier = parents.map((p) => p.id);
  }

  return fallback;
}

async function buildSourceContext(
  document: ReturnType<typeof toDocument>
): Promise<SourceContext> {
  const latestVersion = await documentVersionService.getLatest(document.id);
  return {
    id: document.id,
    type: ArtifactType.DOCUMENT,
    title: document.title,
    content: latestVersion?.content ?? null,
    repositorySnapshot: document.repositorySnapshot,
  };
}

const SOURCE_LINEAGE_MAX_DEPTH = 8;

/**
 * Find a document with the project + source PRD context needed to regenerate
 * or generate. Returns null when the artifact isn't a DOCUMENT in the org.
 *
 * The source PRD is discovered by walking artifact_links PRODUCES edges
 * upward — there is no workstream coupling. The walk's content is fetched
 * lazily via `documentVersionService.getLatest`.
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
        project: true,
      },
    })
  );
  if (artifact?.type !== ArtifactType.DOCUMENT) {
    return null;
  }
  const base = toDocument(artifact);
  const sourcePrd = await findSourcePrdContext(
    artifact.id,
    organizationId,
    artifact.projectId
  );
  return {
    ...base,
    project: artifact.project
      ? {
          id: artifact.project.id,
          organizationId: artifact.project.organizationId,
          name: artifact.project.name,
          settings: artifact.project.settings,
        }
      : null,
    sourcePrd,
  };
}

export const documentGenerationService = {
  findSourcePrdContext,
  findWithRegenerationContext,
};
