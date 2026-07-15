import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  FeatureStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import type {
  DetailedArtifact,
  DetailedTreeChild,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { z } from "zod";

/**
 * The slice of `DocumentWithProject` the documents table actually renders
 * (FEA-1763). `DocumentWithProject` is assignable to this by construction
 * (it's a `Pick`), and enriched tree artifacts adapt to it via
 * `documentRowFromArtifact` — the table never sees document-only fields it
 * doesn't use (latestVersion, repositorySnapshot, approver, …).
 */
export type DocumentRowData = Pick<
  DocumentWithProject,
  | "id"
  | "slug"
  | "title"
  | "type"
  | "status"
  | "priority"
  | "assigneeId"
  | "assignee"
  | "createdAt"
  | "updatedAt"
  | "projectId"
  | "sortOrder"
  | "generationStatus"
  | "tags"
  | "project"
>;

const SUBTYPE_TO_DOCUMENT_TYPE: Record<ArtifactSubtype, DocumentType> = {
  [ArtifactSubtype.Prd]: DocumentType.Prd,
  [ArtifactSubtype.ImplementationPlan]: DocumentType.ImplementationPlan,
  [ArtifactSubtype.Feature]: DocumentType.Feature,
  [ArtifactSubtype.Template]: DocumentType.Template,
};

const documentStatusSchema = z.enum(DocumentStatus);
const featureStatusSchema = z.enum(FeatureStatus);

/**
 * Parse a free-form `status` string against the vocabulary for its subtype
 * (PRD-495). Features use FeatureStatus (fallback BACKLOG); every other
 * Document subtype uses DocumentStatus (fallback DRAFT). The fallback is the
 * defensive guard for an out-of-contract string in the unconstrained column.
 */
function parseStatusForSubtype(
  subtype: ArtifactSubtype,
  rawStatus: string
): ArtifactStatus {
  if (subtype === ArtifactSubtype.Feature) {
    const parsed = featureStatusSchema.safeParse(rawStatus);
    return parsed.success ? parsed.data : FeatureStatus.Backlog;
  }
  const parsed = documentStatusSchema.safeParse(rawStatus);
  return parsed.success ? parsed.data : DocumentStatus.Draft;
}

/**
 * Adapt a DOCUMENT artifact from the detailed project tree into the table's
 * row-data shape. Returns null for non-document artifacts (they render
 * through their own row kinds, not as document rows). `project` carries the
 * page's project context — artifacts only have a projectId.
 */
export function documentRowFromArtifact(
  artifact: DetailedArtifact | DetailedTreeChild,
  project: DocumentRowData["project"]
): DocumentRowData | null {
  if (artifact.type !== ArtifactType.Document || !artifact.subtype) {
    return null;
  }
  return {
    id: artifact.id,
    // Documents always carry a slug; the artifact column is nullable only
    // for other artifact types.
    slug: artifact.slug ?? "",
    title: artifact.name,
    type: SUBTYPE_TO_DOCUMENT_TYPE[artifact.subtype],
    status: parseStatusForSubtype(artifact.subtype, artifact.status),
    // Documents are always created with a priority; Medium mirrors that
    // creation default for any legacy null.
    priority: artifact.priority ?? Priority.Medium,
    assigneeId: artifact.assigneeId,
    assignee: artifact.assignee,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    projectId: artifact.projectId,
    sortOrder: artifact.sortOrder,
    ...(artifact.generationStatus && {
      generationStatus: artifact.generationStatus,
    }),
    ...(artifact.tags && { tags: artifact.tags }),
    project,
  };
}

/**
 * Flatten the detailed project tree into the table's document row list —
 * every DOCUMENT artifact exactly once (roots and descendants), newest
 * first, matching the ordering of the former `/documents?projectId=` fetch.
 */
export function collectDocumentRowsFromTree(
  tree: ProjectTreeDetailsResponse | undefined,
  project: DocumentRowData["project"]
): DocumentRowData[] {
  if (!tree) {
    return [];
  }
  const seen = new Set<string>();
  const rows: DocumentRowData[] = [];
  for (const node of tree.nodes) {
    for (const artifact of [node.root, ...node.children]) {
      if (seen.has(artifact.id)) {
        continue;
      }
      seen.add(artifact.id);
      const row = documentRowFromArtifact(artifact, project);
      if (row) {
        rows.push(row);
      }
    }
  }
  rows.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return rows;
}

/**
 * Whether any document artifact in the tree has an active generation run —
 * drives the project page's polling interval.
 */
export function treeHasActiveGeneration(
  tree: ProjectTreeDetailsResponse | undefined
): boolean {
  if (!tree) {
    return false;
  }
  return tree.nodes.some((node) =>
    [node.root, ...node.children].some(
      (artifact) =>
        artifact.generationStatus &&
        isActiveGenerationStatus(artifact.generationStatus.status)
    )
  );
}
