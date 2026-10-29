import {
  type ArtifactLinkEndpoint,
  ArtifactSubtype,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import {
  type ArtifactStatus,
  type Document,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  IssueStatus,
  SnapshotSource,
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
  | "statusMutation"
  | "tags"
  | "project"
> & {
  /** Raw wire evidence retained for the universal-status fold. */
  rawStatus?: string | null;
};

/** Linked-artifact row shape retaining producer evidence beside its safe fold. */
export type ArtifactRowDocument = Document & {
  rawStatus?: string | null;
  statusMutation?: DocumentWithProject["statusMutation"];
};

const SUBTYPE_TO_DOCUMENT_TYPE: Record<ArtifactSubtype, DocumentType> = {
  [ArtifactSubtype.Prd]: DocumentType.Prd,
  [ArtifactSubtype.ImplementationPlan]: DocumentType.ImplementationPlan,
  [ArtifactSubtype.Feature]: DocumentType.Feature,
  [ArtifactSubtype.Template]: DocumentType.Template,
  [ArtifactSubtype.Doc]: DocumentType.Doc,
};

/** Canonical persisted-artifact subtype to document-domain type mapping. */
export function documentTypeFromSubtype(
  subtype: ArtifactSubtype
): DocumentType {
  return SUBTYPE_TO_DOCUMENT_TYPE[subtype];
}

const documentStatusSchema = z.enum(DocumentStatus);
const issueStatusSchema = z.enum(IssueStatus);

/**
 * Parse a free-form `status` string against the vocabulary for its subtype
 * (PRD-495). Issues (subtype = FEATURE) use IssueStatus (fallback BACKLOG);
 * every other Document subtype uses DocumentStatus (fallback DRAFT). The
 * fallback is the defensive guard for an out-of-contract string in the
 * unconstrained column.
 */
function parseStatusForSubtype(
  subtype: ArtifactSubtype,
  rawStatus: string
): ArtifactStatus {
  if (subtype === ArtifactSubtype.Feature) {
    const parsed = issueStatusSchema.safeParse(rawStatus);
    return parsed.success ? parsed.data : IssueStatus.Backlog;
  }
  const parsed = documentStatusSchema.safeParse(rawStatus);
  return parsed.success ? parsed.data : DocumentStatus.Draft;
}

/**
 * Adapt an `ArtifactLinkEndpoint` (the minimal artifact projection returned by
 * `/artifact-links/resolved`) to the legacy `Document` shape that `ArtifactRow`
 * still expects. The endpoint carries a hydrated `assignee` (ISS-7732) but
 * still omits fields `ArtifactRow` doesn't use for navigation (approver,
 * repository snapshot, …), so this lossy adapter fills those with empty
 * defaults. `assignee` is optional on the wire — an API build from before
 * ISS-7732 omits the key — so a MISSING one is normalized to `null` here, at
 * the adapter, rather than widening `Document.assignee` to accept `undefined`.
 * `subtype`/`status` are mapped through
 * the same SSOT (`documentTypeFromSubtype`, `parseStatusForSubtype`) used for
 * tree artifacts. A null subtype defaults to Feature to satisfy the shape.
 */
export function endpointToDocument(
  endpoint: ArtifactLinkEndpoint
): ArtifactRowDocument {
  const subtype = endpoint.subtype ?? ArtifactSubtype.Feature;
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    projectId: endpoint.projectId,
    type: documentTypeFromSubtype(subtype),
    title: endpoint.name,
    slug: endpoint.slug ?? "",
    fileName: null,
    rawStatus: endpoint.status,
    status: parseStatusForSubtype(subtype, endpoint.status),
    ...(endpoint.statusMutation && { statusMutation: endpoint.statusMutation }),
    // ISS-9665: the endpoint already reports `null` for an artifact with no
    // priority; folding it to Medium here re-created the same lie `toDocument`
    // was telling on the other side of the wire.
    priority: endpoint.priority,
    latestVersion: 1,
    createdById: endpoint.createdById ?? "",
    assigneeId: endpoint.assigneeId,
    assignee: endpoint.assignee ?? null,
    approverId: null,
    approver: null,
    // The endpoint projection from artifact-link lineage doesn't carry the
    // repository snapshot — surface an empty `source: 'none'`
    // snapshot so the navigation-only adapter still satisfies the type.
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: endpoint.sortOrder,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
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
    type: documentTypeFromSubtype(artifact.subtype),
    status: parseStatusForSubtype(artifact.subtype, artifact.status),
    rawStatus: artifact.status,
    // ISS-9665: NOT folded to Medium. The premise this fallback rested on —
    // "documents are always created with a priority" — was never true: the
    // create validator makes `priority` optional and the column has no default,
    // so an omitted priority persists as NULL.
    priority: artifact.priority,
    assigneeId: artifact.assigneeId,
    assignee: artifact.assignee,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    projectId: artifact.projectId,
    sortOrder: artifact.sortOrder,
    ...(artifact.statusMutation && { statusMutation: artifact.statusMutation }),
    ...(artifact.tags && { tags: artifact.tags }),
    project,
  };
}

/** Preserves explicit null evidence while keeping legacy omitted-field fallback. */
export function documentRowStatusEvidence(
  row: Pick<DocumentRowData, "rawStatus" | "status">
): string | null {
  return row.rawStatus === undefined ? row.status : row.rawStatus;
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
