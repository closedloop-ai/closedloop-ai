import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactRepositorySnapshot,
  type Document,
  type DocumentStatus,
  type DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import type {
  LoopCommand,
  LoopStatus,
  SourceContextType,
} from "@repo/api/src/types/loop";
import type { BasicUser } from "@repo/api/src/types/user";
import type {
  Prisma,
  Artifact as PrismaArtifact,
  DocumentDetail as PrismaDocumentDetail,
  Priority as PrismaPriority,
} from "@repo/database";
import { nanoid } from "nanoid";
import { TAG_RELATION_INCLUDE } from "@/app/tags/service";
import { basicUserSelect } from "@/lib/db-utils";
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
    type: artifact.subtype!,
    title: artifact.name,
    slug: artifact.slug!,
    fileName: detail?.fileName ?? null,
    status: artifact.status as DocumentStatus,
    priority: artifact.priority ?? Priority.Medium,
    latestVersion: detail?.latestVersion ?? 1,
    createdById: artifact.createdById ?? "",
    createdBy: artifact.createdBy ?? null,
    assigneeId: artifact.assigneeId,
    assignee: artifact.assignee,
    approverId: detail?.approverId ?? null,
    approver: detail?.approver ?? null,
    tokenUsage: null,
    repositorySnapshot,
    templateForType: detail?.templateForType ?? null,
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
  projectId?: string;
  type?: DocumentType;
  title?: string;
  slug?: string;
  status?: string;
  // Artifact columns — nullable in schema.
  priority?: PrismaPriority | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
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

// Project summary used inside `DocumentWithRegenerationContext`. Mirrors the
// Prisma `Project` shape with `settings` kept as the raw JSON value
// (consumers coerce via `getProjectSettings`).
export type RegenerationProject = {
  id: string;
  organizationId: string;
  name: string;
  settings: unknown;
};

/**
 * Document wire shape augmented with the project + source PRD context needed
 * for plan/loop context resolution. Returned by
 * `documentGenerationService.findWithRegenerationContext` and consumed by the
 * various generation/execution flows that branch off it.
 *
 * The source PRD is discovered by walking the artifact_links PRODUCES chain
 * upward from this document, replacing the legacy workstream join.
 */
export type DocumentWithRegenerationContext = Document & {
  project: RegenerationProject | null;
  sourcePrd: SourceContext | null;
};

/**
 * Source artifact context used when resolving regeneration inputs.
 */
export type SourceContext = {
  id: string;
  type: SourceContextType;
  title: string;
  content: string | null;
  repositorySnapshot: ArtifactRepositorySnapshot;
};

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

// Result types shared across regenerate / execute / request-changes flows.
export type StartPlanLoopFromLocalResult =
  | { outcome: "needs-selection"; documents: { id: string; title: string }[] }
  | {
      outcome: "invalid-document";
      existingDocuments: { id: string; title: string }[];
    }
  | {
      outcome: "already-running";
      loopId: string;
      documentId: string;
      documentSlug: string;
      localRepoPath: string;
    }
  | {
      outcome: "already-active-conflict";
      activeLoop: { id: string; command: LoopCommand; status: LoopStatus };
    }
  | { outcome: "error"; reason: "missing-local-path" }
  | {
      outcome: "ready-to-launch";
      documentId: string;
      documentSlug: string;
      document: DocumentWithRegenerationContext;
    };
