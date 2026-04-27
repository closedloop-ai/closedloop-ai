import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import type {
  Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import type {
  Prisma,
  Artifact as PrismaArtifact,
  DocumentDetail as PrismaDocumentDetail,
  Priority as PrismaPriority,
} from "@repo/database";
import { nanoid } from "nanoid";
import { basicUserSelect } from "@/lib/db-utils";

export function generateSlug(): string {
  return nanoid(14);
}

/**
 * Shape returned by findUnique/findMany on `artifact` with
 * `include: documentIncludeWithUser` (assignee + document → approver).
 */
export type ArtifactWithDocumentDetail = PrismaArtifact & {
  assignee: BasicUser | null;
  document: (PrismaDocumentDetail & { approver: BasicUser | null }) | null;
};

/**
 * Convert an Artifact row (with DocumentDetail included) into the legacy
 * `Document` API shape. Callers that used to read from the `Document` Prisma
 * model now get the same wire shape via this adapter.
 */
export function toDocument(artifact: ArtifactWithDocumentDetail): Document {
  const detail = artifact.document;
  return {
    id: artifact.id,
    organizationId: artifact.organizationId,
    workstreamId: artifact.workstreamId,
    projectId: artifact.projectId,
    type: artifact.subtype!,
    title: artifact.name,
    slug: artifact.slug!,
    fileName: detail?.fileName ?? null,
    status: artifact.status as DocumentStatus,
    priority: artifact.priority ?? Priority.Medium,
    latestVersion: detail?.latestVersion ?? 1,
    createdById: artifact.createdById ?? "",
    assigneeId: artifact.assigneeId,
    assignee: artifact.assignee,
    approverId: detail?.approverId ?? null,
    approver: detail?.approver ?? null,
    tokenUsage: null,
    targetRepo: detail?.targetRepo ?? null,
    targetBranch: detail?.targetBranch ?? null,
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
  workstreamId?: string | null;
  assigneeId?: string | null;
  sortOrder?: number | null;
  // DocumentDetail columns — all nullable in schema.
  fileName?: string | null;
  approverId?: string | null;
  templateForType?: DocumentType | null;
  latestVersion?: number;
  targetRepo?: string | null;
  targetBranch?: string | null;
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
    targetRepo,
    targetBranch,
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
  if (targetRepo !== undefined) {
    detail.targetRepo = targetRepo;
  }
  if (targetBranch !== undefined) {
    detail.targetBranch = targetBranch;
  }
  return { artifact, detail };
}

export class DocumentNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Document not found") {
    super(message);
    this.name = "DocumentNotFoundError";
  }
}

/**
 * Artifact include that loads DocumentDetail + approver + assignee. Use for
 * document-typed artifact queries that need the full legacy Document shape.
 */
export const documentIncludeWithUser = {
  assignee: basicUserSelect,
  document: {
    include: {
      approver: basicUserSelect,
    },
  },
} as const;

/**
 * PullRequestDetail select that maps to PullRequestInfo. Applied alongside the
 * parent artifact (which carries title, url via externalUrl).
 */
export const pullRequestDetailSelect = {
  number: true,
  headBranch: true,
  baseBranch: true,
  prState: true,
  checksStatus: true,
  reviewDecision: true,
} as const;

export const documentIncludeWithContext = {
  workstream: {
    select: {
      id: true,
      title: true,
      state: true,
    },
  },
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
  ...documentIncludeWithUser,
} as const;

/**
 * Extends documentIncludeWithContext with the latest document version content.
 * Use only for list queries that need a snippet (e.g. engineer ticket cards).
 */
export const documentIncludeWithSnippet = {
  workstream: documentIncludeWithContext.workstream,
  project: documentIncludeWithContext.project,
  assignee: basicUserSelect,
  document: {
    include: {
      approver: basicUserSelect,
      versions: {
        orderBy: { version: "desc" as const },
        take: 1,
        select: { content: true },
      },
    },
  },
} as const;

const VALID_COMMANDS = new Set(["plan", "execute", "chat"]);

export type TriggerData = {
  correlationId: string;
  documentId: string;
  command: "plan" | "execute" | "chat";
};

export function parseTriggerData(triggerData: unknown): TriggerData | null {
  if (
    typeof triggerData !== "object" ||
    triggerData === null ||
    Array.isArray(triggerData)
  ) {
    return null;
  }

  const data = triggerData as Record<string, unknown>;

  if (
    typeof data.correlationId !== "string" ||
    typeof data.documentId !== "string" ||
    typeof data.command !== "string"
  ) {
    return null;
  }

  if (
    data.correlationId.trim() === "" ||
    data.documentId.trim() === "" ||
    data.command.trim() === ""
  ) {
    return null;
  }

  if (!VALID_COMMANDS.has(data.command)) {
    return null;
  }

  return {
    correlationId: data.correlationId,
    documentId: data.documentId,
    command: data.command as TriggerData["command"],
  };
}
