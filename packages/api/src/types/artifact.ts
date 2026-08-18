// Artifact types for API contract.
// Mirrors the Prisma schema's class-table-inheritance shape: one parent
// record (Artifact) plus one of four type-specific detail objects, each
// identified by `Artifact.type`.

import { normalizeDocumentType } from "@closedloop-ai/loops-api/document";
import type { ChecksStatus, ReviewDecision } from "./branch-view";
import type { JsonObject, Priority } from "./common";
import type { ArtifactRepositorySnapshot } from "./document";
import type { GitHubPRState } from "./github";
import type { BasicUser } from "./user";

export const ArtifactType = {
  Document: "DOCUMENT",
  Branch: "BRANCH",
  Deployment: "DEPLOYMENT",
  Session: "SESSION",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export const BranchBaseBranchSource = {
  PullRequestBase: "pull_request_base",
  HarnessInput: "harness_input",
  McpInput: "mcp_input",
  MigrationPrBase: "migration_pr_base",
  RepositoryDefault: "repository_default",
} as const;
export type BranchBaseBranchSource =
  (typeof BranchBaseBranchSource)[keyof typeof BranchBaseBranchSource];

export const BranchHeadShaSource = {
  PushWebhook: "push_webhook",
  PullRequestWebhook: "pull_request_webhook",
  HarnessInput: "harness_input",
  McpInput: "mcp_input",
  ExplicitSync: "explicit_sync",
  MigrationPrHead: "migration_pr_head",
} as const;
export type BranchHeadShaSource =
  (typeof BranchHeadShaSource)[keyof typeof BranchHeadShaSource];

/**
 * Explicit set-once push evidence for a branch (PRD-510 FR2 / PLN-1099 Phase 2).
 * `firstPushedAt` is stamped by the earliest verified push; `pushSource` records
 * which producer supplied it. Deliberately NEVER derived from the volatile
 * `BranchHeadShaSource` (the `stale_push` trap) or from row existence — a synced
 * row means "observed", not "pushed" (PRD-510 D3). Drives the FR12 display
 * predicate. `session` = a C1-verified in-session push (desktop sync); `webhook`
 * = a GitHub push / pull_request event.
 */
export const BranchPushSource = {
  Session: "session",
  Webhook: "webhook",
} as const;
export type BranchPushSource =
  (typeof BranchPushSource)[keyof typeof BranchPushSource];

export const BranchFileCacheStatus = {
  Absent: "absent",
  Scheduled: "scheduled",
  Fresh: "fresh",
  Stale: "stale",
  Failed: "failed",
} as const;
export type BranchFileCacheStatus =
  (typeof BranchFileCacheStatus)[keyof typeof BranchFileCacheStatus];

export const BranchSyncStatus = {
  Idle: "idle",
  Syncing: "syncing",
  Fresh: "fresh",
  Stale: "stale",
  Failed: "failed",
} as const;
export type BranchSyncStatus =
  (typeof BranchSyncStatus)[keyof typeof BranchSyncStatus];

/** Maximum branch-name length accepted by branch materialization API inputs. */
export const BRANCH_NAME_MAX_LENGTH = 256;

export const ArtifactSubtype = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Template: "TEMPLATE",
  Feature: "FEATURE",
  Doc: "DOC",
} as const;
export type ArtifactSubtype =
  (typeof ArtifactSubtype)[keyof typeof ArtifactSubtype];

/**
 * Canonical `ISSUE` input alias for the persisted `FEATURE` subtype (FEA-3956,
 * PRD-560 Phase 3). Mirrors the parallel `DocumentTypeAlias.Issue` boundary
 * vocabulary (ISS-4397): the product renamed Features → Issues in the UI,
 * routes, and slugs (FEA-3954/FEA-3955/FEA-4137), but the underlying storage
 * subtype stays `FEATURE` (non-destructive, per PRD-560 decision 2). This alias
 * is the input value the DB/wire boundary ACCEPTS from callers — a skewed
 * newer desktop/MCP/external client may send the canonical `ISSUE`; it
 * normalizes to the persisted `FEATURE` via {@link normalizeArtifactSubtype}
 * before it reaches Prisma or any exhaustive `Record<ArtifactSubtype, …>` map.
 *
 * `ISSUE` is deliberately NOT a member of {@link ArtifactSubtype}: it never
 * persists, so existing FEATURE-typed rows, the `IssueStatus` vocabulary, slug
 * prefixes, and every `subtype === FEATURE` predicate keep working unchanged.
 * Additive and skew-safe: old clients that only know `FEATURE` are unaffected,
 * and new clients may send `ISSUE`.
 */
export const ArtifactSubtypeAlias = {
  Issue: "ISSUE",
} as const;
export type ArtifactSubtypeAlias =
  (typeof ArtifactSubtypeAlias)[keyof typeof ArtifactSubtypeAlias];

/**
 * The accepted *input* artifact-subtype vocabulary at the DB/wire boundary:
 * every persisted {@link ArtifactSubtype} plus the `ISSUE` alias (FEA-3956).
 * Boundary consumers validate against this superset; the value is normalized to
 * a persisted {@link ArtifactSubtype} with {@link normalizeArtifactSubtype}
 * before use.
 */
export const ArtifactSubtypeInput = {
  ...ArtifactSubtype,
  ...ArtifactSubtypeAlias,
} as const;
export type ArtifactSubtypeInput =
  (typeof ArtifactSubtypeInput)[keyof typeof ArtifactSubtypeInput];

/**
 * Parent-row fields common to every artifact type. Per-type detail objects
 * extend this base in the discriminated union below.
 */
export type Artifact = {
  id: string;
  organizationId: string;
  projectId: string | null;
  type: ArtifactType;
  subtype: ArtifactSubtype | null;
  name: string;
  slug: string | null;
  status: string;
  priority: Priority | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  dueDate: Date | null;
  externalUrl: string | null;
  sortOrder: number | null;
  createdAt: Date;
  createdById: string | null;
  updatedAt: Date;
};

export type DocumentDetail = {
  fileName: string | null;
  approverId: string | null;
  approver: BasicUser | null;
  templateForType: ArtifactSubtype | null;
  latestVersion: number;
  repositorySnapshot: ArtifactRepositorySnapshot;
};

export type PullRequestDetail = {
  id?: string | null;
  branchArtifactId?: string | null;
  // Nullable for desktop-produced PRs in non-App repos (FEA-2732 / PRD-510 D2):
  // no installation-repo id and no GitHub node id until App adoption / `gh`
  // enrichment supplies them. `repositoryFullName` is the producer-independent
  // repo identity carried for these repo-less rows.
  repositoryId: string | null;
  repositoryFullName?: string | null;
  githubId: string | null;
  number: number;
  title?: string | null;
  htmlUrl?: string | null;
  body: string | null;
  prState: GitHubPRState;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  isDraft: boolean;
  checksStatus: ChecksStatus | null;
  reviewDecision: ReviewDecision | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
  isCurrent?: boolean;
};

/**
 * Branch-owned artifact detail. Pull request data is optional nested state on
 * the branch, so branch-only materialization can be represented without a PR.
 */
export type BranchDetail = {
  repositoryId: string;
  branchName: string;
  baseBranch: string | null;
  baseBranchSource: BranchBaseBranchSource | null;
  headSha: string | null;
  headShaSource: BranchHeadShaSource | null;
  headShaObservedAt: Date | null;
  lastPushBeforeSha: string | null;
  currentPullRequestDetailId: string | null;
  deletedAt: Date | null;
  checksStatus: string | null;
  fileCacheStatus: BranchFileCacheStatus;
  fileCacheHeadSha: string | null;
  fileCacheFileCount: number;
  fileCachePatchBytes: number;
  fileCacheUpdatedAt: Date | null;
  syncStatus: BranchSyncStatus;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorMessage: string | null;
  currentPullRequest: PullRequestDetail | null;
};

export type DeploymentDetail = {
  environment: string | null;
  ref: string | null;
  sha: string | null;
  githubStatusUrl: string | null;
  githubDeploymentUrl: string | null;
  transient: boolean | null;
  production: boolean | null;
  branchArtifactId: string | null;
};

/**
 * Detail for SESSION-typed artifacts (captured agent/session runs synced from
 * the desktop). The owner, raw harness status, name, and project live on the
 * parent `Artifact` row; this carries the session-specific context. The rich
 * metrics/event/agent payloads are served by the `/agent-sessions` routes
 * (see `agent-session.ts`), not the generic artifact endpoints.
 */
export type SessionDetail = {
  externalSessionId: string;
  harness: string;
  model: string | null;
  computeTargetId: string;
  repositoryFullName: string | null;
  sessionStartedAt: Date;
  sessionUpdatedAt: Date;
  sessionEndedAt: Date | null;
};

/**
 * Discriminated union of every artifact-shaped record returned by the API.
 * Callers narrow on `type` to access the correct detail fields.
 */
export type DocumentArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Document;
  subtype: ArtifactSubtype | null;
  document: DocumentDetail;
};

export type BranchArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Branch;
  subtype: null;
  branch: BranchDetail;
};

export type DeploymentArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Deployment;
  subtype: null;
  deployment: DeploymentDetail;
};

export type SessionArtifact = Omit<Artifact, "type" | "subtype"> & {
  type: typeof ArtifactType.Session;
  subtype: null;
  session: SessionDetail;
};

export type ArtifactWithDetail =
  | DocumentArtifact
  | BranchArtifact
  | DeploymentArtifact
  | SessionArtifact;

export function isDocumentArtifact(
  artifact: ArtifactWithDetail
): artifact is DocumentArtifact {
  return artifact.type === ArtifactType.Document;
}

export function isBranchArtifact(
  artifact: ArtifactWithDetail
): artifact is BranchArtifact {
  return artifact.type === ArtifactType.Branch;
}

export function isDeploymentArtifact(
  artifact: ArtifactWithDetail
): artifact is DeploymentArtifact {
  return artifact.type === ArtifactType.Deployment;
}

// ---------------------------------------------------------------------------
// ArtifactLink — replaces the legacy EntityLink polymorphic relationship
// ---------------------------------------------------------------------------

export const LinkType = {
  Produces: "PRODUCES",
  Blocks: "BLOCKS",
  RelatesTo: "RELATES_TO",
} as const;
export type LinkType = (typeof LinkType)[keyof typeof LinkType];

export const LinkDirection = {
  Source: "source",
  Target: "target",
  Both: "both",
} as const;
export type LinkDirection = (typeof LinkDirection)[keyof typeof LinkDirection];

export const LinkQueryMode = {
  Direct: "direct",
  Tree: "tree",
} as const;
export type LinkQueryMode = (typeof LinkQueryMode)[keyof typeof LinkQueryMode];

export type ArtifactLink = {
  id: string;
  organizationId: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  metadata: JsonObject | null;
  createdAt: Date;
};

export type CreateArtifactLinkInput = {
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  metadata?: JsonObject | null;
};

/** Minimal endpoint shape returned by /artifact-links/resolved. */
export type ArtifactLinkEndpoint = Omit<Artifact, "assignee"> & {
  branch?: {
    branchName: string;
    currentPullRequest: PullRequestDetail | null;
  } | null;
};

/** A hydrated artifact link with source + target endpoints resolved. */
export type ArtifactLinkWithEndpoints = ArtifactLink & {
  source: ArtifactLinkEndpoint;
  target: ArtifactLinkEndpoint;
};

/**
 * Selected direct-parent projection over ArtifactLink lineage.
 * This is a convenience view of one incoming link per target artifact; callers
 * that need complete lineage should use the artifact-link direct/tree APIs.
 */
export type ArtifactParentProjection = {
  targetId: string;
  linkId: string | null;
  linkType: LinkType | null;
  linkCreatedAt: Date | null;
  parentArtifact: ArtifactLinkEndpoint | null;
};

export type BatchMoveArtifactsInput = {
  artifactId: string;
  targetProjectId: string;
  includeDownstream: boolean;
};

export type BatchMoveArtifactsResult = {
  movedArtifacts: { id: string; type: ArtifactType }[];
};

/**
 * Normalizes an accepted input artifact subtype to its persisted
 * {@link ArtifactSubtype}. `ISSUE` → `FEATURE`; every other value is returned
 * unchanged. Call this at the DB/wire boundary before persisting or querying so
 * the canonical `ISSUE` never leaks into the database or into a
 * `Record<ArtifactSubtype, …>` map (FEA-3956). Unknown values are outside the
 * type and are rejected by the caller's own validation before this point.
 *
 * Delegates to the {@link normalizeDocumentType} SSOT (`@closedloop-ai/loops-api`): the
 * persisted `ArtifactSubtype` vocabulary and its `ISSUE` input alias are the
 * same value set as `DocumentType`/`DocumentTypeAlias`, so the `ISSUE → FEATURE`
 * mapping is owned in exactly one place instead of a second exhaustive record
 * that could drift.
 */
export function normalizeArtifactSubtype(
  subtype: ArtifactSubtypeInput
): ArtifactSubtype {
  return normalizeDocumentType(subtype);
}
