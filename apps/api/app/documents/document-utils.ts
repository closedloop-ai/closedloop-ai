import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import type {
  Document,
  DocumentStatus,
  DocumentType,
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
  WorkstreamState,
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

// Workstream summary used by `DocumentWithRegenerationContext`.
export type WorkstreamSummary = {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  description: string | null;
  state: WorkstreamState;
  createdAt: Date;
  updatedAt: Date;
};

// Project summary used inside `DocumentWithRegenerationContext`. Mirrors the
// Prisma `Project` shape with `settings` kept as the raw JSON value
// (consumers coerce via `getProjectSettings`).
export type WorkstreamProject = {
  id: string;
  organizationId: string;
  name: string;
  settings: unknown;
};

/**
 * Document wire shape augmented with the workstream + PRD documents needed
 * for plan/loop context resolution. Returned by
 * `documentGenerationService.findWithRegenerationContext` and consumed by
 * `documentWorkstreamService.findOrCreateWorkstream` and the various generation/
 * execution flows that branch off it.
 */
export type DocumentWithRegenerationContext = Document & {
  workstream:
    | (WorkstreamSummary & {
        project: WorkstreamProject | null;
        documents: Document[];
      })
    | null;
};

/**
 * Source artifact context used when resolving regeneration inputs.
 */
export type SourceContext = {
  id: string;
  type: SourceContextType;
  title: string;
  content: string | null;
  targetRepo: string | null;
  targetBranch: string | null;
  workstreamId: string | null;
};

/**
 * Raw Prisma artifact shape returned by queries that use
 * `documentIncludeWithContext`. Must stay in sync with that include shape.
 */
export type RawDocumentWithContext = PrismaArtifact & {
  assignee: BasicUser | null;
  document:
    | (PrismaDocumentDetail & {
        approver: BasicUser | null;
        versions?: { content: string | null }[];
      })
    | null;
  workstream: { id: string; title: string; state: WorkstreamState } | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
};

/**
 * Flatten a workstream row with nested `artifacts` (PRD documents) into the
 * legacy `{ ...workstream, documents: Document[] }` shape used by callers.
 */
export function workstreamToWithDocuments<
  W extends {
    artifacts: ArtifactWithDocumentDetail[];
  },
>(
  workstream: W | null
):
  | (Omit<W, "artifacts"> & {
      documents: Document[];
      artifacts: W["artifacts"];
    })
  | null {
  if (!workstream) {
    return null;
  }
  return {
    ...workstream,
    documents: workstream.artifacts.map(toDocument),
  };
}

// Result types shared across regenerate / execute / request-changes flows.
export type RegenerateResult =
  | { success: true; document: Document }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type ExecuteResult =
  | { success: true; correlationId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type RequestChangesResult =
  | { success: true; message: string; documentId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

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

/**
 * Returns true when GitHub App env vars are configured. Used by generation,
 * regenerate, execute, and request-changes flows to decide whether to issue
 * the workflow_dispatch call or fall back to placeholder content.
 */
export function isGitHubConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_WEBHOOK_SECRET &&
      process.env.GITHUB_APP_DISPATCH_REPO
  );
}

/**
 * Placeholder content used when GitHub Actions integration is not configured.
 */
export function getPlaceholderContent(title: string, version: number): string {
  return `# ${title}

## Overview

This implementation plan outlines the technical approach for ${title}.

**Version:** v${version}
**Status:** Generating...

## Note

GitHub Actions integration is not configured. This is placeholder content.
Configure the following environment variables to enable plan generation:
- GITHUB_APP_ID
- GITHUB_APP_PRIVATE_KEY
- GITHUB_APP_WEBHOOK_SECRET
- GITHUB_APP_DISPATCH_REPO
- WEBAPP_ENV
`;
}
