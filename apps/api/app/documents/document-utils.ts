import {
  ArtifactType,
  normalizeArtifactSubtype,
} from "@repo/api/src/types/artifact";
import {
  type ArtifactRepositorySnapshot,
  type Document,
  type DocumentStatus,
  type DocumentType,
  type DocumentWithProject,
  SnapshotSource,
  type SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type {
  Prisma,
  Artifact as PrismaArtifact,
  DocumentDetail as PrismaDocumentDetail,
  Priority as PrismaPriority,
} from "@repo/database";
import { nanoid } from "nanoid";
import {
  mapTagRelations,
  TAG_RELATION_INCLUDE,
} from "@/app/tags/tag-projection-select";
import { basicUserSelect } from "@/lib/db-utils";
import { buildDocumentStatusMutation } from "./document-status-mutation-capability";
import { parseStoredSnapshot } from "./repository-snapshot-helpers";

const EMPTY_REPOSITORY_SNAPSHOT: ArtifactRepositorySnapshot = {
  repositories: [],
  source: SnapshotSource.None,
};

export function generateSlug(): string {
  return nanoid(14);
}

/**
 * Shape returned by findUnique/findMany on `artifact` with
 * `include: documentIncludeWithUser` (assignee + document → approver).
 */
export type ArtifactWithDocumentDetail = PrismaArtifact & {
  assignee: BasicUser | null;
  createdBy: BasicUser | null;
  document: (PrismaDocumentDetail & { approver: BasicUser | null }) | null;
};

/**
 * Convert an Artifact row (with DocumentDetail included) into the legacy
 * `Document` API shape. Callers that used to read from the `Document` Prisma
 * model now get the same wire shape via this adapter.
 */
export function toDocument(artifact: ArtifactWithDocumentDetail): Document {
  const detail = artifact.document;
  const repositorySnapshot =
    parseStoredSnapshot(detail?.repositorySnapshot) ??
    EMPTY_REPOSITORY_SNAPSHOT;
  return {
    id: artifact.id,
    organizationId: artifact.organizationId,
    projectId: artifact.projectId,
    // FEA-3956: normalize the persisted subtype to the canonical DocumentType.
    // Rows never store the canonical `ISSUE` (map-in-code, PRD-560 dec. 2), but
    // the generated Prisma enum now includes it; mapping keeps a skewed value
    // resolving to `FEATURE` instead of leaking `ISSUE` into the wire contract.
    type: normalizeArtifactSubtype(artifact.subtype!),
    title: artifact.name,
    slug: artifact.slug!,
    fileName: detail?.fileName ?? null,
    status: artifact.status as DocumentStatus,
    // ISS-9665: the stored value, unfolded. A null here is "no priority", which
    // `/search`, `/artifact-links/resolved` and the project tree already report
    // as null — folding it to MEDIUM made one artifact serialize two priorities.
    priority: artifact.priority,
    latestVersion: detail?.latestVersion ?? 1,
    createdById: artifact.createdById ?? "",
    createdBy: artifact.createdBy ?? null,
    assigneeId: artifact.assigneeId,
    assignee: artifact.assignee,
    dueDate: artifact.dueDate,
    approverId: detail?.approverId ?? null,
    approver: detail?.approver ?? null,
    repositorySnapshot,
    templateForType: detail?.templateForType
      ? normalizeArtifactSubtype(detail.templateForType)
      : null,
    sortOrder: artifact.sortOrder,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

/**
 * Input shape accepted by `splitDocumentPayload`. Fields are optional to
 * support both the create and update paths; callers compose the required
 * fields (organizationId, createdById, etc.) on top of the returned
 * artifact payload.
 */
export type DocumentPayloadInput = {
  // Artifact columns — NOT NULL in schema; disallow null here so the
  // returned Prisma update input stays valid.
  type?: DocumentType;
  title?: string;
  slug?: string;
  status?: string;
  // Artifact columns — nullable in schema.
  projectId?: string | null;
  priority?: PrismaPriority | null;
  assigneeId?: string | null;
  dueDate?: Date | null;
  sortOrder?: number | null;
  sourceLinkedPlanPolicy?: SourceLinkedPlanPolicy;
  // DocumentDetail columns.
  fileName?: string | null;
  approverId?: string | null;
  templateForType?: DocumentType | null;
  latestVersion?: number;
  // DocumentDetail.repositorySnapshot — NOT NULL in schema. Set only on
  // create paths by trusted internal callers (PLN-602). Update paths leave
  // it undefined so Prisma doesn't touch the column.
  repositorySnapshot?: ArtifactRepositorySnapshot;
};

/**
 * Output shape: split into the Artifact row fields and the DocumentDetail
 * row fields, each typed as Prisma's unchecked update input. This preserves
 * the shared helper's create/update flexibility while eliminating the
 * `Record<string, unknown>` escape hatch at call sites — the Prisma client
 * will now refuse unknown keys at compile time.
 */
export type SplitDocumentPayload = {
  artifact: Prisma.ArtifactUncheckedUpdateInput;
  detail: Prisma.DocumentDetailUncheckedUpdateInput;
};

/**
 * Splits a CreateDocumentInput-style payload into the Artifact columns and
 * DocumentDetail columns, for writes that used to target the Document model.
 */
export function splitDocumentPayload(
  data: DocumentPayloadInput
): SplitDocumentPayload {
  const {
    title,
    type,
    fileName,
    approverId,
    templateForType,
    latestVersion,
    repositorySnapshot,
    sourceLinkedPlanPolicy: _sourceLinkedPlanPolicy,
    ...artifactRest
  } = data;
  const artifact: Prisma.ArtifactUncheckedUpdateInput = { ...artifactRest };
  if (title !== undefined) {
    artifact.name = title;
  }
  if (type !== undefined) {
    artifact.subtype = type;
    artifact.type = ArtifactType.Document;
  }
  const detail: Prisma.DocumentDetailUncheckedUpdateInput = {};
  if (fileName !== undefined) {
    detail.fileName = fileName;
  }
  if (approverId !== undefined) {
    detail.approverId = approverId;
  }
  if (templateForType !== undefined) {
    detail.templateForType = templateForType;
  }
  if (latestVersion !== undefined) {
    detail.latestVersion = latestVersion;
  }
  if (repositorySnapshot !== undefined) {
    detail.repositorySnapshot = repositorySnapshot;
  }
  return { artifact, detail };
}

/**
 * Artifact include that loads DocumentDetail + approver + assignee. Use for
 * document-typed artifact queries that need the full legacy Document shape.
 */
export const documentIncludeWithUser = {
  assignee: basicUserSelect,
  createdBy: basicUserSelect,
  document: {
    include: {
      approver: basicUserSelect,
    },
  },
} as const;

export const documentIncludeWithContext = {
  project: {
    select: {
      id: true,
      organizationId: true,
      name: true,
      teams: {
        select: {
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        take: 1,
      },
    },
  },
  tagArtifacts: {
    include: TAG_RELATION_INCLUDE,
  },
  ...documentIncludeWithUser,
} as const;

/**
 * Raw Prisma artifact shape returned by queries that use
 * `documentIncludeWithContext`. Must stay in sync with that include shape.
 */
export type RawDocumentWithContext = PrismaArtifact & {
  assignee: BasicUser | null;
  createdBy: BasicUser | null;
  document:
    | (PrismaDocumentDetail & {
        approver: BasicUser | null;
        versions?: { content: string | null }[];
      })
    | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
  tagArtifacts?: Array<{ tag: { id: string; name: string; color: string } }>;
};

/**
 * Transform Artifact + detail into the DocumentWithProject wire shape.
 *
 * Lives here with `toDocument` and the include shape it consumes rather than in
 * `document-service.ts`, so the list-read path can build a document row without
 * importing the CRUD service (ISS-7211).
 */
export function toDocumentWithProject(
  artifact: RawDocumentWithContext
): DocumentWithProject {
  const base = toDocument(artifact);

  return {
    ...base,
    statusMutation: buildDocumentStatusMutation(base.type),
    project: artifact.project
      ? {
          id: artifact.project.id,
          name: artifact.project.name,
          teams: artifact.project.teams.map(
            (pt: { team: { id: string; name: string } }) => pt.team
          ),
        }
      : null,
    tags: mapTagRelations(artifact.tagArtifacts ?? []),
  };
}
