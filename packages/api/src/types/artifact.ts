// Artifact types for API contract.
// Mirrors the Prisma schema's class-table-inheritance shape: one parent
// record (Artifact) plus one of four type-specific detail objects, each
// identified by `Artifact.type`.

import { normalizeDocumentType } from "@closedloop-ai/loops-api/document";
import type { ArtifactStatusEditSurface } from "./artifact-status-contract.js";
import type { SessionLinkAttributionEvidence } from "./attribution-evidence.ts";
import type { BranchProductEligibility } from "./branch-product-eligibility.ts";
import type { ChecksStatus, ReviewDecision } from "./branch-view";
import type { JsonObject, Priority } from "./common";
import type { ArtifactRepositorySnapshot } from "./document";
import type { DocumentStatusMutationCapability } from "./document-status-mutation.ts";
import type { GitHubPRState } from "./github";
import type { SessionStatus } from "./session-status.ts";
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
  /**
   * ISS-8175: a PR's base as the DESKTOP read it from `gh` when it opened that
   * PR. Not `PullRequestBase`, which means "GitHub's answer at read time" — this
   * one is read once on the machine and can be stale by the time it syncs.
   */
  DesktopPullRequestBase: "desktop_pull_request_base",
  McpInput: "mcp_input",
  MigrationPrBase: "migration_pr_base",
  RepositoryDefault: "repository_default",
} as const;
export type BranchBaseBranchSource =
  (typeof BranchBaseBranchSource)[keyof typeof BranchBaseBranchSource];

/**
 * ISS-8175: which base-branch sources a CLIENT may assert on a branch write.
 * `DesktopPullRequestBase` is deliberately excluded — it outranks `McpInput`
 * precisely BECAUSE it is gh's own answer rather than an agent's claim, so an
 * agent able to name it would buy that higher rank for free. Only the desktop
 * sync lane, which reads the value from gh, originates it.
 *
 * An exhaustive `Record`, not a side list: every client-facing `z.enum` over
 * `BranchBaseBranchSource` derives its accepted set from here, so a new member
 * fails `tsc` until someone classifies it instead of silently widening them.
 */
const clientAssertableBaseBranchSource: Record<
  BranchBaseBranchSource,
  boolean
> = {
  [BranchBaseBranchSource.PullRequestBase]: true,
  [BranchBaseBranchSource.HarnessInput]: true,
  [BranchBaseBranchSource.DesktopPullRequestBase]: false,
  [BranchBaseBranchSource.McpInput]: true,
  [BranchBaseBranchSource.MigrationPrBase]: true,
  [BranchBaseBranchSource.RepositoryDefault]: true,
};

/** True when a client request may name this base-branch source. */
export function isClientAssertableBaseBranchSource(
  source: BranchBaseBranchSource
): boolean {
  return clientAssertableBaseBranchSource[source];
}

/** The refusal a client sees when it names a source only a producer may set. */
export const CLIENT_ASSERTABLE_BASE_BRANCH_SOURCE_ERROR =
  "baseBranchSource is not client-assertable" as const;

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
  /** Server-computed status-write contract for document artifacts. Omitted for unsupported artifact types and older API deploys. */
  statusMutation?: DocumentStatusMutationCapability;
  priority: Priority | null;
  assigneeId: string | null;
  assignee: BasicUser | null;
  dueDate: Date | null;
  externalUrl: string | null;
  sortOrder: number | null;
  createdAt: Date;
  createdById: string | null;
  updatedAt: Date;
  /**
   * ISS-8694: for a SESSION artifact, the DISPLAY status the row renders —
   * `projectDisplayedSessionStatus` computed server-side, so the Sessions list,
   * Projects, and My Tasks cannot each derive a different word for one row.
   *
   * **INERT since ISS-10364** (operator ruling, 2026-09-23/24): the two
   * DISPLAY-ONLY words this field existed to carry, `stale` and `unknown`, are
   * retired, so `projectDisplayedSessionStatus` never produces a value this
   * field could safely hold any more (a lifecycle word here would tell the
   * Status band and `isRowItemCompleted` — which still read the stored
   * `status` — a different story about the same row) and the server never sets
   * it. A client that sees it absent falls back to `status`, exactly as it did
   * before this field existed. ISS-11131 removes the field outright; typed
   * `SessionStatus` rather than deleted here so the (currently unreachable)
   * assignment still type-checks until that lands.
   */
  displayedSessionStatus?: SessionStatus;
  /** Additive Product-navigation decision; absent/unknown fails closed. */
  productEligibility?: BranchProductEligibility;
  /** True only when the API verified a provider PR compatibility fallback. */
  hasCompatibilityProviderFallback?: boolean;
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

/**
 * Minimal endpoint shape returned by /artifact-links/resolved.
 *
 * ISS-7732: `assignee` is deliberately carried (previously `Omit`ted) — the
 * projection joins the user, so consumers render the real assignee instead of
 * treating an un-hydrated field as a definite "unassigned". It stays OPTIONAL
 * because it is additive on the wire: an API build from before ISS-7732 omits
 * the key entirely during deploy skew, so consumers must normalize a missing
 * value rather than pass `undefined` into a `BasicUser | null` slot (see
 * `endpointToDocument`).
 */
export type ArtifactLinkEndpoint = Omit<Artifact, "assignee"> & {
  assignee?: BasicUser | null;
  branch?: {
    branchName: string;
    currentPullRequest: PullRequestDetail | null;
  } | null;
};

/** A hydrated artifact link with source + target endpoints resolved. */
export type ArtifactLinkWithEndpoints = ArtifactLink & {
  source: ArtifactLinkEndpoint;
  target: ArtifactLinkEndpoint;
  /**
   * ISS-12552: on a SESSION-source row, what the session's
   * operation evidence says it did to the target. Absent when there is none.
   */
  sessionEvidence?: SessionLinkAttributionEvidence;
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
  /**
   * `null` files the artifact (and, with `includeDownstream`, its downstream
   * set) into no project. The key stays required, so an omitted key is never
   * read as a clear (ISS-12858).
   */
  targetProjectId: string | null;
  includeDownstream: boolean;
  /**
   * ISS-10995 (Cosimo Corrigan, 2026-10-12: "I think we want a stale-write
   * guard"): the project the caller believed `artifactId` held when the user
   * acted. `null` is a real assertion — the artifact was filed into none —
   * and OMITTING the key is unguarded last-write-wins, which is what the bulk
   * Move dialog and the documents batch path still send. The server compares it
   * against the LOCKED row, so a Details Project row writing from a stale read
   * is refused rather than silently winning.
   */
  expectedProjectId?: string | null;
  /** Optional originating UI surface; omitted by older and API-key clients. */
  surface?: ArtifactStatusEditSurface;
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

/**
 * One bounded page of `/artifact-links/resolved`, returned when a caller opts in
 * with `paginated=true` (ISS-10102).
 *
 * WHY AN OPT-IN ENVELOPE. The default response is a bare
 * {@link ArtifactLinkWithEndpoints}[] and every shipped consumer — the three
 * document relationship surfaces through `useResolvedArtifactLinks`, the MCP
 * `list-artifact-links` tool, and any already-installed Desktop build or
 * external REST client — `.map`s it directly. Wrapping it unconditionally is a
 * breaking change across a deploy boundary; an envelope a caller has to ask for
 * is additive. A caller that never asks gets the same array it always got, now
 * bounded to the first page rather than the whole graph.
 *
 * `nextCursor` is ABSENT, never `null`, on the last page: an absent optional is
 * what the repo's cross-repo contract rule requires, and `"page.nextCursor !==
 * undefined"` is then the single fact a pager loops on.
 */
export type ArtifactLinkPage = {
  items: ArtifactLinkWithEndpoints[];
  /** Pass back verbatim as `cursor` to read the next page. Opaque. */
  nextCursor?: string;
  /** Echo as `snapshotId` with the numeric cursor; older APIs ignore it. */
  snapshotId?: string;
};

/**
 * Continuation metadata for `GET /artifact-links/resolved`, carried as RESPONSE
 * HEADERS on the BARE-ARRAY arm (ISS-10102, following the ISS-6941 precedent on
 * `GET /documents`).
 *
 * WHY HEADERS WHEN {@link ArtifactLinkPage} ALREADY EXISTS. The envelope answers
 * this in the body, but only for a caller who knows to ask. This route is
 * wrapped in `withAnyAuth`, which accepts `sk_live_*` API keys as well as Clerk
 * sessions, so an EXTERNAL client can call it directly — and that client is
 * exactly the one least likely to send `paginated=true`. Without these it would
 * receive the first {@link ARTIFACT_LINK_PAGE_SIZE} links and have no way to
 * tell a complete lineage from a capped one: an array has nowhere to carry a
 * sibling field, and wrapping it unconditionally is the breaking change the
 * envelope exists to avoid. A header is the one addition an existing client
 * cannot notice — an old caller ignores it, a new one reads it, and the parsed
 * body is byte-for-byte what it was.
 *
 * This is what keeps the operator ruling true for EVERY caller and not just the
 * opted-in ones: pagination was chosen over a depth cap because it bounds the
 * response without removing a capability, and completeness removed silently is
 * a capability removed.
 *
 * Lowercase names because that is how a `fetch` `Headers` lookup normalizes
 * them; the constant is what both the route and the CORS expose-list read, so
 * neither can invent a casing.
 */
export const ARTIFACT_LINK_CONTINUATION_HEADERS = {
  /**
   * `"true"` / `"false"` — whether links exist beyond the page just served.
   * ALWAYS present on the bare-array arm, including when it is `"false"`.
   *
   * Emitted even in the negative deliberately. Its absence is what an older api
   * build, or a proxy that strips unknown headers, also looks like, so a client
   * that saw only the positive case could not tell "this response is complete"
   * from "this server never tells me". A positive statement of completeness is
   * the whole reason an external caller can trust the bare array again.
   */
  HasMore: "x-artifact-link-has-more",
  /**
   * The cursor that reads the next page, to be passed back verbatim as
   * `cursor`. Present ONLY when {@link ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore}
   * is `"true"` — absent, never an empty string, on the last page, matching the
   * omit-don't-null discipline {@link ArtifactLinkPage.nextCursor} follows in
   * the body.
   */
  NextCursor: "x-artifact-link-next-cursor",
  SnapshotId: "x-artifact-link-snapshot-id",
} as const;

/**
 * Render the continuation headers for a page. `nextCursor` absent means the
 * traversal is exhausted, so `HasMore` is `"false"` and no cursor header is set.
 */
export function buildArtifactLinkContinuationHeaders(
  nextCursor?: string,
  snapshotId?: string
): Record<string, string> {
  if (nextCursor === undefined) {
    return { [ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore]: "false" };
  }
  return {
    [ARTIFACT_LINK_CONTINUATION_HEADERS.HasMore]: "true",
    [ARTIFACT_LINK_CONTINUATION_HEADERS.NextCursor]: nextCursor,
    ...(snapshotId
      ? { [ARTIFACT_LINK_CONTINUATION_HEADERS.SnapshotId]: snapshotId }
      : {}),
  };
}
