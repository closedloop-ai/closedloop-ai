/**
 * Branches page API types (PLN-983 / Epic A).
 *
 * Canonical shared DTOs for the desktop-first Branches slice, consumed by BOTH
 * the desktop renderer local source AND the future authenticated REST source.
 * Reuse — never redefine — existing enums: `GitHubPRState` (./github),
 * `ChecksStatus`/`ReviewDecision` (./branch-checks — a leaf with no relative
 * imports, so importing it here does NOT pull `branch-view.ts` into the desktop
 * main `nodenext` program; see `./branch-checks` for the full rationale).
 *
 * NOTE ON NAMING: `packages/api/src/types/artifact.ts` already exports a
 * different `BranchDetail` (the branch-owned artifact detail consumed by
 * `isBranchArtifact`/`ArtifactWithDetail`). To avoid same-package ambiguity the
 * surface detail type here is named `BranchPageDetail`. Import branch.ts types
 * path-qualified (`@repo/api/src/types/branch`); do NOT add the detail type to a
 * barrel that also re-exports the artifact.ts `BranchDetail`.
 */

import type { BranchActivityEvidenceProjection } from "./branch-activity.ts";
import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
} from "./branch-associated-pull-request.js";
import type { ChecksStatus, ReviewDecision } from "./branch-checks.js";
import type {
  BranchCostFields,
  BranchSessionCostFields,
} from "./branch-cost.ts";
import type {
  BranchCollaborators,
  BranchOwnerIdentity,
} from "./branch-identity.ts";
import type {
  BranchDetailMetricBundle,
  BranchListMetricBundle,
  BranchMetricResult,
} from "./branch-metrics.js";
import type {
  BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "./branch-phase-attribution.js";
import type { CanonicalBranchProjectionV1 } from "./branch-projection.ts";
import { normalizeRepoFullName as normalizeRepositoryFullName } from "./branch-repository.ts";
import type { BranchSelectedPullRequestChecksResponse } from "./branch-selected-pull-request-checks.ts";

import type {
  BranchTraceResponse as CanonicalBranchTraceResponse,
  MergedTraceItem as CanonicalMergedTraceItem,
} from "./branch-trace.ts";
import type {
  BranchUsageActorBucket as CanonicalBranchUsageActorBucket,
  BranchUsageHourBucket as CanonicalBranchUsageHourBucket,
  BranchUsagePhaseStack as CanonicalBranchUsagePhaseStack,
  BranchUsageSummary as CanonicalBranchUsageSummary,
} from "./branch-usage.js";
import type { GitHubPRState } from "./github.js";
import type { GitHubActorType } from "./github-actor.ts";
import type { ReadSource } from "./read-source.js";
import type { TagSummary } from "./tag.js";

// --- Shared enums (const-object + value-type, mirroring the agent-session enums) ---

export const BranchStatus = {
  Open: "open",
  Review: "review",
  Merged: "merged",
  Draft: "draft",
  Blocked: "blocked",
  Closed: "closed",
} as const;
export type BranchStatus = (typeof BranchStatus)[keyof typeof BranchStatus];

/**
 * PR state re-exports the canonical GitHub enum — never redefine it. Draft-ness
 * is carried separately (PRs are OPEN with an `isDraft`-style marker upstream).
 */
export type BranchPrState = GitHubPRState; // OPEN | MERGED | CLOSED

export const BranchPhase = {
  Plan: "plan",
  Implement: "implement",
  Review: "review",
  Rework: "rework",
  Verify: "verify",
} as const;
export type BranchPhase = (typeof BranchPhase)[keyof typeof BranchPhase];

/**
 * Role a linked session plays for a branch detail view. Optional on session DTOs
 * so older cloud and desktop producers can omit it until they consume the shared
 * classifier.
 */
export const BranchSessionRole = {
  Build: "build",
  Review: "review",
  Related: "related",
} as const;
export type BranchSessionRole =
  (typeof BranchSessionRole)[keyof typeof BranchSessionRole];

/**
 * Durable branch participation contract. `Wrote` means the session/user produced
 * branch output; `Reviewed` means deliberate review feedback or review action on
 * the branch/PR. Optional on DTOs so older producers can omit it.
 */
export const BranchParticipationKind = {
  Wrote: "wrote",
  Reviewed: "reviewed",
} as const;
export type BranchParticipationKind =
  (typeof BranchParticipationKind)[keyof typeof BranchParticipationKind];

/**
 * Same-session lifecycle phase for branch attribution. Distinct from the legacy
 * `BranchPhase` analytics buckets and from `BranchSessionRole`, which remains a
 * whole-session membership/context classifier.
 */
export const BranchLifecyclePhase = {
  Build: "build",
  Review: "review",
  Rework: "rework",
  Unknown: "unknown",
} as const;
export type BranchLifecyclePhase =
  (typeof BranchLifecyclePhase)[keyof typeof BranchLifecyclePhase];

/**
 * Deterministic boundary markers that split a linked branch session into
 * ordered lifecycle phase segments. Future producers may add these without
 * requiring older readers to populate or consume `BranchSession.phaseSegments`.
 */
export const BranchLifecycleBoundaryKind = {
  SessionStart: "session_start",
  BranchWrite: "branch_write",
  PrRaised: "pr_raised",
  ReviewFeedback: "review_feedback",
  ReadOnlyReference: "read_only_reference",
  UnknownEvidence: "unknown_evidence",
  SessionEnd: "session_end",
} as const;
export type BranchLifecycleBoundaryKind =
  (typeof BranchLifecycleBoundaryKind)[keyof typeof BranchLifecycleBoundaryKind];

export const BranchBillingMode = {
  Subscription: "subscription",
  Api: "api",
} as const;
export type BranchBillingMode =
  (typeof BranchBillingMode)[keyof typeof BranchBillingMode];

/**
 * Viewer scope for every branch read response. The local desktop source is
 * always `Self`; the future authenticated REST source may report `Organization`.
 * A const-object (not a bare string union) so producers reference a named member
 * and the transport value cannot silently drift.
 */
export const BranchViewerScope = {
  Organization: "organization",
  Self: "self",
} as const;
export type BranchViewerScope =
  (typeof BranchViewerScope)[keyof typeof BranchViewerScope];

/**
 * Availability state of an analytics KPI: `Available` = computed locally,
 * `Gated` = needs GitHub enrichment (connect-GitHub affordance), `Unavailable` =
 * no data. Const-object for the same drift-safety reason as `BranchViewerScope`.
 */
export const BranchKpiState = {
  Available: "available",
  Gated: "gated",
  Unavailable: "unavailable",
} as const;
export type BranchKpiState =
  (typeof BranchKpiState)[keyof typeof BranchKpiState];

/**
 * Consumer-visible data state for cloud Branches rows. Optional on DTOs so
 * older local/desktop producers remain wire-compatible.
 */
export const BranchDataState = {
  Ready: "ready",
  AwaitingSync: "awaiting_sync",
  NotPresent: "not_present",
  NoSessions: "no_sessions",
} as const;
export type BranchDataState =
  (typeof BranchDataState)[keyof typeof BranchDataState];

/**
 * Whether a producer actually loaded the generic Artifact-tag relation for a
 * Branch. Optional on Branch DTOs so older producers can omit the capability;
 * `Available` with `tags: []` is distinct from `Unavailable` with no `tags`.
 */
export const BranchTagAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type BranchTagAvailability =
  (typeof BranchTagAvailability)[keyof typeof BranchTagAvailability];

/**
 * Association-level tag capabilities for the authenticated Branch read.
 * Applying includes batch apply; removal is separate because API keys enforce
 * `write` and `delete` scopes independently.
 */
export type BranchTagPermissions = {
  canApply: boolean;
  canRemove: boolean;
};

export const BranchRefreshStatus = {
  Refreshed: "refreshed",
  Stale: "stale",
  NotApplicable: "not_applicable",
  Retryable: "retryable",
  Failed: "failed",
} as const;
export type BranchRefreshStatus =
  (typeof BranchRefreshStatus)[keyof typeof BranchRefreshStatus];

export const BranchRefreshReason = {
  AlreadyRefreshing: "already_refreshing",
  BudgetExhausted: "budget_exhausted",
  GitHubIdentityExpired: "github_identity_expired",
  GitHubIdentityInsufficientScope: "github_identity_insufficient_scope",
  GitHubIdentityRequired: "github_identity_required",
  GuardedWriteFailed: "guarded_write_failed",
  InvalidBranchId: "invalid_branch_id",
  NoCurrentPullRequest: "no_current_pull_request",
  NotFound: "not_found",
  ProviderRateLimited: "provider_rate_limited",
  ProviderUnavailable: "provider_unavailable",
} as const;
export type BranchRefreshReason =
  (typeof BranchRefreshReason)[keyof typeof BranchRefreshReason];

/**
 * Outcome of a desktop cloud-hydration pass over a set of branch rows.
 *
 * `NotConnected` and `CredentialMissing` are DIFFERENT claims and must not be
 * conflated (PLN-1535 M3.2 — the plan's "UX honesty fix"):
 *
 * - `NotConnected` — no row in the corpus carries a repo identity, so there is
 *   nothing GitHub could enrich. This is the same condition
 *   `resolveBranchListBanner` reads off `repoFullName`, and connecting GitHub
 *   IS the remedy.
 * - `CredentialMissing` — rows DO carry repo identity, but this Desktop holds
 *   no cloud credential (no signed-in session and no stored API key), so the
 *   projection can't be read at all. Connecting GitHub cannot fix it; signing
 *   in to Desktop can. Rendering this as `NotConnected` sent a signed-out user
 *   to a GitHub-connect CTA that could never resolve their problem.
 */
export const BranchCloudHydrationStatus = {
  NotConnected: "not_connected",
  CredentialMissing: "credential_missing",
  Fresh: "fresh",
  Stale: "stale",
  Failed: "failed",
} as const;
export type BranchCloudHydrationStatus =
  (typeof BranchCloudHydrationStatus)[keyof typeof BranchCloudHydrationStatus];

export const BranchCommentsState = {
  UnsyncedUnknown: "unsynced_unknown",
  Populated: "populated",
  SyncedEmpty: "synced_empty",
  ProviderError: "provider_error",
  StaleMixed: "stale_mixed",
  OverLimitTruncated: "over_limit_truncated",
  ForbiddenMismatch: "forbidden_mismatch",
} as const;
export type BranchCommentsState =
  (typeof BranchCommentsState)[keyof typeof BranchCommentsState];

export const BranchCommentsFailureReason = {
  RateLimit: "rate_limit",
  SecondaryLimit: "secondary_limit",
  Timeout: "timeout",
  Auth: "auth",
  NotFound: "not_found",
  ForbiddenMismatch: "forbidden_mismatch",
  ProviderUnavailable: "provider_unavailable",
  ProviderError: "provider_error",
} as const;
export type BranchCommentsFailureReason =
  (typeof BranchCommentsFailureReason)[keyof typeof BranchCommentsFailureReason];

export const BranchCommentsBudget = {
  MaxComments: 100,
  PageSize: 50,
  MaxBodyBytes: 16 * 1024,
  MaxResponseBytes: 512 * 1024,
} as const;

export const BranchPrCommentKind = {
  Issue: "issue",
  Review: "review",
  ReviewReply: "review_reply",
} as const;
export type BranchPrCommentKind =
  (typeof BranchPrCommentKind)[keyof typeof BranchPrCommentKind];

export type BranchPrCommentAuthor = {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  /** Optional authoritative GitHub actor type; absent on legacy evidence. */
  actorType?: GitHubActorType;
};

export type BranchPrCommentBudget = {
  maxComments: number;
  pageSize: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  providerTruncated: boolean;
  responseTruncated: boolean;
  omittedComments: number;
  bodyTruncatedCount: number;
};

export type BranchPrComment = {
  id: string;
  providerNodeId: string | null;
  providerCommentId: string | null;
  kind: BranchPrCommentKind;
  threadId: string | null;
  inReplyToId: string | null;
  path: string | null;
  line: number | null;
  resolved: boolean | null;
  author: BranchPrCommentAuthor;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  providerUrl: string | null;
  stale: boolean;
  bodyTruncated: boolean;
};

export type BranchPrCommentsResponse = {
  branchId: string;
  /** Repository identity of the resolved PR; absent on legacy producers. */
  repositoryFullName?: string;
  state: BranchCommentsState;
  failureReason?: BranchCommentsFailureReason;
  comments: BranchPrComment[];
  budget: BranchPrCommentBudget;
  providerProofedAt: string | null;
  stale: boolean;
  mixedProjection: boolean;
  prNumber: number | null;
  prUrl: string | null;
};

/** Trim a PR comment body to the shared comments byte budget. */
export function trimBranchPrCommentBody(body: string): {
  body: string;
  truncated: boolean;
} {
  if (byteLength(body) <= BranchCommentsBudget.MaxBodyBytes) {
    return { body, truncated: false };
  }
  let next = body;
  while (
    next.length > 0 &&
    byteLength(next) > BranchCommentsBudget.MaxBodyBytes
  ) {
    next = next.slice(0, -1);
  }
  return { body: next, truncated: true };
}

/** Enforce the shared serialized response budget for PR comments responses. */
export function fitBranchPrCommentsResponseBudget(
  response: BranchPrCommentsResponse
): BranchPrCommentsResponse {
  const next = { ...response, comments: [...response.comments] };
  while (
    next.comments.length > 0 &&
    byteLength(JSON.stringify(next)) > BranchCommentsBudget.MaxResponseBytes
  ) {
    next.comments.pop();
    next.budget.responseTruncated = true;
    next.budget.omittedComments += 1;
  }
  if (next.budget.responseTruncated) {
    next.state = BranchCommentsState.OverLimitTruncated;
  }
  return next;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// --- Branch-id encode/decode (single owner: A1; B1 produces, D1 parses, C2/C3 route) ---

const BRANCH_ID_DELIMITER = "::";
/**
 * Sentinel substituted for a null `repoFullName`. Real repo identities are in
 * "owner/name" form (always slash-bearing), so the slash-free sentinel never
 * collides with a captured repo and round-trips back to null on decode.
 */
/** Repo segment used in encoded branch ids when no repository identity exists. */
export const LOCAL_REPO_SENTINEL = "local";

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Never throw on a malformed id — degrade to the raw segment.
    return value;
  }
}

/**
 * Encode a stable, URL-safe branch identity. Each component is
 * `encodeURIComponent`-escaped before joining so a slash in `repoFullName` and
 * the `::` delimiter both round-trip. Format:
 * `${encodeURIComponent(repoFullName ?? "local")}::${encodeURIComponent(branchName)}`.
 */
export function encodeBranchId(parts: {
  repoFullName: string | null;
  branchName: string;
}): string {
  const repo = encodeURIComponent(parts.repoFullName ?? LOCAL_REPO_SENTINEL);
  const branch = encodeURIComponent(parts.branchName);
  return `${repo}${BRANCH_ID_DELIMITER}${branch}`;
}

/** Inverse of `encodeBranchId`. The `"local"` repo sentinel decodes back to null. */
export function decodeBranchId(id: string): {
  repoFullName: string | null;
  branchName: string;
} {
  const delimiterIndex = id.indexOf(BRANCH_ID_DELIMITER);
  if (delimiterIndex === -1) {
    // Malformed/legacy id with no delimiter — treat the whole value as a
    // repo-less branch name rather than throwing.
    return { repoFullName: null, branchName: safeDecodeComponent(id) };
  }
  const repoPart = safeDecodeComponent(id.slice(0, delimiterIndex));
  const branchPart = safeDecodeComponent(
    id.slice(delimiterIndex + BRANCH_ID_DELIMITER.length)
  );
  return {
    repoFullName: repoPart === LOCAL_REPO_SENTINEL ? null : repoPart,
    branchName: branchPart,
  };
}

/** Compatibility entry point for the canonical repository normalizer. */
export function normalizeRepoFullName(fullName: string): string {
  return normalizeRepositoryFullName(fullName);
}

// --- PROVENANCE (FEA-3285 — name-derived branch origin classification) ---

/**
 * Branch provenance (FEA-3285): where a branch came from, derived purely from
 * its name. The Branches list mixes real human work with cruft — agents that
 * push their own worktree branch (`worktree-agent-*`, `.claude/worktrees/*`) and
 * bots (`dependabot/*`, `renovate/*`) mint rows indistinguishable from human
 * branches. This is the ONE canonical classifier: the shared read boundary of
 * BOTH surfaces (web HTTP source and desktop local source) calls
 * {@link classifyBranchProvenance} on the branch name, so a branch buckets
 * identically everywhere — the cross-surface-consistency contract STEP 1
 * (FEA-3284 session quality) set the precedent for.
 *
 * Deliberately name-derived (not a stored column): the signal lives entirely in
 * the branch name, so deriving at read time is loss-free, needs no schema
 * migration/backfill, and cannot drift between the two producers. `human` is the
 * default — anything that doesn't match a known agent/bot pattern is treated as
 * real human work. The classification is informational only: it drives the
 * provenance chip badges on the Branches list; it never filters or hides a row.
 */
export const BranchProvenance = {
  Human: "human",
  /** Agent-minted worktree branch (`worktree-agent-*`, `.claude/worktrees/*`). */
  Agent: "agent",
  /** Automated dependency/bot branch (`dependabot/*`, `renovate/*`). */
  Bot: "bot",
} as const;
export type BranchProvenance =
  (typeof BranchProvenance)[keyof typeof BranchProvenance];

/**
 * Agent-worktree branch-name patterns. Matches the desktop worktree convention
 * (`worktree-agent-<hex>`) and any branch pushed from a `.claude/worktrees/*`
 * path. Anchored/segment-aware so a human branch that merely contains the word
 * "agent" (e.g. `feat/agent-pipeline-graph`) is NOT misclassified — only the
 * dedicated worktree prefixes count.
 */
/**
 * A path/branch segment under a `.claude/worktrees/` tree marks an agent run.
 * Shared SSOT keyed off by both {@link AGENT_BRANCH_PATTERNS} (branch names) and
 * {@link classifySessionProvenance} (session worktree paths) so the two never
 * drift.
 */
const CLAUDE_WORKTREE_PATH_PATTERN = /(^|\/)\.claude\/worktrees\//i;

const AGENT_BRANCH_PATTERNS: readonly RegExp[] = [
  /^worktree-agent-/i,
  CLAUDE_WORKTREE_PATH_PATTERN,
];

/**
 * Bot branch-name patterns. The two ubiquitous automated-dependency bots publish
 * under a stable `bot-name/…` prefix, so a prefix match is exact and collision-
 * free (a human branch is never named `dependabot/…`).
 */
const BOT_BRANCH_PATTERNS: readonly RegExp[] = [
  /^dependabot\//i,
  /^renovate\//i,
];

/**
 * Classify a branch's provenance from its name (FEA-3285 SSOT). Bot patterns are
 * checked before agent patterns (they are disjoint today, but the order fixes a
 * deterministic precedence). Unmatched → `human` — the safe default that keeps a
 * real branch visible. Null/empty names (pre-capture rows) are `human`.
 */
export function classifyBranchProvenance(
  branchName: string | null | undefined
): BranchProvenance {
  if (!branchName) {
    return BranchProvenance.Human;
  }
  if (BOT_BRANCH_PATTERNS.some((pattern) => pattern.test(branchName))) {
    return BranchProvenance.Bot;
  }
  if (AGENT_BRANCH_PATTERNS.some((pattern) => pattern.test(branchName))) {
    return BranchProvenance.Agent;
  }
  return BranchProvenance.Human;
}

// --- SESSION PROVENANCE (FEA-3575 — surface bot/agent sessions) ---

/**
 * Session provenance (FEA-3575): whether a session was driven by a human, an
 * agent worktree, or an automated bot. Reuses the SAME {@link BranchProvenance}
 * vocabulary as the branch classifier so the two surfaces label origin
 * identically — a bot that raises a `dependabot/*` branch and the session that
 * ran it read as the same "bot" everywhere a user inspects related activity.
 *
 * The motivating gap (FEA-3575): bot-raised branches show up with no obvious
 * session, and even when a session IS linked it is indistinguishable from human
 * work. Deriving provenance at the read boundary — from signals the session row
 * already carries (its branch name, worktree path, and CI harness) — surfaces
 * bot/agent sessions without a schema migration, exactly as the branch
 * classifier does for branches.
 */
export type SessionProvenance = BranchProvenance;

/**
 * The CI harness marks an automated (bot) run. The desktop tags CI/automation
 * sessions with `harness === "ci"`, the same signal the branch merged-trace uses
 * to flag a CI actor lane, so a session produced by automation classifies as a
 * bot even when it ran on a human-looking branch name.
 */
const CI_HARNESS = "ci";

/**
 * Classify a session's provenance (FEA-3575 SSOT). Precedence mirrors the branch
 * classifier — an explicit bot signal wins, then agent, else human:
 *   1. `bot`   — CI harness, or a bot branch name (`dependabot/*`, `renovate/*`).
 *   2. `agent` — an agent-worktree branch name, or a `.claude/worktrees/*` path.
 *   3. `human` — the safe default; nothing bot/agent matched.
 *
 * Pure over the loss-free signals a session row already carries, so both the
 * Sessions list and the branch-detail sessions view classify identically. All
 * inputs are optional/nullable (pre-capture rows) and default to `human`.
 */
export function classifySessionProvenance(input: {
  branchName?: string | null;
  worktreePath?: string | null;
  harness?: string | null;
}): SessionProvenance {
  const { branchName, worktreePath, harness } = input;
  // Bot wins: an automated harness OR a bot-named branch.
  if (harness?.trim().toLowerCase() === CI_HARNESS) {
    return BranchProvenance.Bot;
  }
  const byBranch = classifyBranchProvenance(branchName);
  if (byBranch === BranchProvenance.Bot) {
    return BranchProvenance.Bot;
  }
  // Agent: a worktree-named branch, or a `.claude/worktrees/*` working path.
  if (byBranch === BranchProvenance.Agent) {
    return BranchProvenance.Agent;
  }
  if (worktreePath && CLAUDE_WORKTREE_PATH_PATTERN.test(worktreePath)) {
    return BranchProvenance.Agent;
  }
  return BranchProvenance.Human;
}

// --- QUERY FILTERS (shared by the list/usage/analytics reads) ---

/** Validate and normalize an unknown value to the shared branch participation kind. */
export function normalizeBranchParticipationKind(
  value: unknown
): BranchParticipationKind | undefined {
  if (
    value === BranchParticipationKind.Wrote ||
    value === BranchParticipationKind.Reviewed
  ) {
    return value;
  }
  return undefined;
}

export const BRANCH_CONTRIBUTOR_USER_ID_PARAM = "contributorUserId";

/**
 * Legacy linked-session presence literals retained for old URLs and clients.
 * Canonical Branch candidate reads accept `Has` and `None` but intentionally
 * ignore both values; keeping this shared const preserves strict validation so
 * unknown values still fail rather than becoming accidental filters.
 */
export const BranchSessionPresence = {
  Has: "has",
  None: "none",
} as const;
export type BranchSessionPresence =
  (typeof BranchSessionPresence)[keyof typeof BranchSessionPresence];

// FEA-4003 — param names for the new filters. These deliberately match the
// `BranchQueryFilters` field names so the client's `buildSearchParams(filters)`
// serialization round-trips straight into the REST query and the list-URL facet
// codec without an intermediate rename.
/** URL/query param name for the LOC-change lower bound. */
export const BRANCH_LOC_MIN_PARAM = "locMin";
/** URL/query param name for the LOC-change upper bound. */
export const BRANCH_LOC_MAX_PARAM = "locMax";
/**
 * Legacy URL/query param retained for additive client compatibility.
 * @deprecated Producers may continue sending this parameter, but branch reads
 * ignore it so canonical persisted-session membership is never filtered away.
 */
export const BRANCH_SESSION_PRESENCE_PARAM = "sessionPresence";

/**
 * Query filters shared by every branch read. Canonical home (AGENTS.md: shared
 * API types live here, never duplicated): the `@repo/app` data-source port and
 * the desktop IPC contract both import this one type so a new field cannot drift
 * between them.
 */
export type BranchQueryFilters = {
  startDate?: string; // ISO; trailing-window lower bound for usage/analytics
  endDate?: string; // ISO
  repo?: string; // repoFullName "owner/name" OR short name; serving matches both
  owner?: string; // branch owner (actor) filter; not all producers/routes support it
  status?: string; // BranchStatus value
  search?: string; // free-text over branchName / repo / prTitle
  // FEA-3826 — deprecated compatibility input. Producers may still send it,
  // but canonical branch reads ignore it so membership is never filtered away.
  sessionPresence?: BranchSessionPresence;
  // FEA-4003 — LOC-change size range over `additions + deletions`. Inclusive
  // bounds; the cloud predicate EXCLUDES rows whose LOC is unavailable (both
  // line counts NULL) when either bound is set, mirroring the date-window
  // null-exclusion convention. Clamp: locMin ≥ 0, locMin ≤ locMax.
  locMin?: number;
  locMax?: number;
  // Cloud-only dimensions — ignored by the local source; REST routes reject
  // unsupported dimensions until their downstream predicates are implemented.
  userId?: string;
  teamId?: string;
  contributorUserId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

// --- LIST ---

export type BranchRow = BranchCostFields & {
  /** `encodeBranchId(repoFullName, branchName)` OR a BRANCH artifact id. */
  id: string;
  /** Canonical cloud Branch Artifact UUID; omitted by local/legacy producers. */
  artifactId?: string;
  /** Owning project when the branch is attached to one; optional for older producers. */
  projectId?: string | null;
  /** Existing generic Artifact tags; `[]` means the relation loaded empty. */
  tags?: TagSummary[];
  /** Distinguishes a loaded tag relation from unavailable/unknown tag data. */
  tagAvailability?: BranchTagAvailability;
  /** Auth-derived generic tag association capabilities; omitted when unknown. */
  tagPermissions?: BranchTagPermissions;
  branchName: string;
  /** NULL -> "missing"; enrichment `base_ref` unpopulated today. */
  baseBranch: string | null;
  /** NULL until repo-identity capture (FEA-1899). */
  repoFullName: string | null;
  /** Actor; NULL when not captured -> "unattributed". */
  owner: string | null;
  /** Canonical earliest-push Owner evidence; omitted by legacy producers. */
  ownerIdentity?: BranchOwnerIdentity;
  /** Canonical persisted commenter union; omitted by legacy producers. */
  collaborators?: BranchCollaborators;
  status: BranchStatus;
  prNumber: number | null;
  prTitle: string | null;
  /** NULL when no PR / enrichment `pr_state` unpopulated. */
  prState: BranchPrState | null;
  prUrl: string | null;
  /**
   * FEA-4333 — the connected PR's MERGE EVIDENCE: the GitHub `merged_at` ISO
   * timestamp, or null when the PR is not (yet) merged. Paired with `prState` so
   * the client-side filtered analytics (`deriveFilteredBranchAnalytics`) can
   * classify a stale-open-but-merged PR (`prState` still OPEN + `mergedAt` set) as
   * merged via `countPrLifecycle`, matching the two server producers instead of
   * re-introducing the double-classification from the raw `prState` alone.
   *
   * Optional and additive: omitted by producers that predate FEA-4333, and by the
   * desktop producer whose `prState` is ALREADY merge-aware (`derivePrState`
   * resolves `merged_at` into the state before the row is built), so the desktop
   * wire row carries `mergedAt: null` and the classifier reads the resolved
   * `prState`. Absent → `countPrLifecycle` falls back to `prState` alone, the
   * pre-FEA-4333 behavior.
   */
  mergedAt?: string | null;
  /** TRUE when >1 PR linked — warning + EXCLUDED from rate/size KPIs. */
  multiPrWarning: boolean;
  checksStatus: ChecksStatus | null;
  checksPassed: number | null;
  checksTotal: number | null;
  reviewDecision: ReviewDecision | null;
  /** NO v1 producer — always null/gated. */
  ahead: number | null;
  /** NO v1 producer — always null/gated. */
  behind: number | null;
  /**
   * DISPLAYED changed-LOC additions. FEA-4268: the list and the detail now show
   * the SAME reconciled value — the branch's own file-cache totals when enriched,
   * else the connected PR's diff stats backfill (`resolveDetailLoc`). NULL =
   * unavailable (NOT 0). This is a DISPLAY field: client-side analytics that must
   * stay on the file-cache basis (Median PR size, LOC-per-$) read the additive
   * `analyticsAdditions`/`analyticsDeletions` below instead, so a PR-backfilled
   * row is not misclassified as file-cache-enriched.
   */
  additions: number | null;
  /** DISPLAYED changed-LOC deletions (see `additions`); NULL = unavailable. */
  deletions: number | null;
  /** Persisted branch/PR artifact LOC when enriched; NULL when unavailable. */
  filesChanged: number | null;
  /**
   * FEA-4268 — the FILE-CACHE-only changed-LOC additions, the basis client-side
   * analytics use (Median PR size, Value-per-$ enrichment) so they match the
   * server's `analyticsPullRequestSize` and the desktop producer, which both stay
   * strictly on the file-cache SSOT and never fold in the connected-PR backfill
   * that the DISPLAYED `additions` may carry.
   *
   * Optional and additive: added alongside — not in place of — the displayed
   * `additions`. Omitted by producers that predate FEA-4268; consumers fall back
   * to `additions`/`deletions` when it is absent (those pre-FEA-4268 rows carried
   * the file-cache value there anyway, so the fallback preserves the old basis).
   * `null` = file-cache un-enriched (excluded from the analytics median).
   */
  analyticsAdditions?: number | null;
  /** FILE-CACHE-only changed-LOC deletions (see `analyticsAdditions`). */
  analyticsDeletions?: number | null;
  /** Optional desktop cloud overlay status; omitted by older/local-only producers. */
  cloudHydrationStatus?: BranchCloudHydrationStatus;
  cloudHydrationFailure?: string;
  /**
   * ISO timestamp of the branch's most recent GENUINE activity (PLN-1034): a
   * pushed commit, PR open/merge/close, PR review submission, or attributable
   * monitored-session event. Current producers derive it from canonical
   * provenance-bearing evidence, never a row-write/sync time. The default
   * Branches sort; an empty string remains the compatibility sentinel when the
   * canonical result is unavailable.
   */
  lastActivityAt: string;
  /**
   * Additive canonical Last-active result for this Branch. Producers derive it
   * only from trustworthy activity evidence and preserve Partial/Unavailable
   * instead of presenting a legacy fallback timestamp as complete. Older
   * producers omit it; consumers must keep accepting the legacy row shape.
   */
  canonicalLastActiveAt?: BranchMetricResult<string>;
  /**
   * Additive provenance-bearing latest activity evidence. Older producers omit
   * it; current cloud readers report honest Partial/Unavailable coverage rather
   * than synthesizing an atom from the legacy aggregate timestamp.
   */
  canonicalActivityEvidence?: BranchActivityEvidenceProjection;
  /** Sessions via session_artifact_links (targetKind=branch). */
  sessionIds: readonly string[];
  /** Cloud/API state derivation; omitted by older local producers. */
  dataState?: BranchDataState;
  /** Additive canonical projection; absent on legacy and local producers. */
  canonicalProjection?: CanonicalBranchProjectionV1;
};

export type BranchListResponse = {
  items: BranchRow[];
  total: number;
  /** Local source always "self". */
  viewerScope: BranchViewerScope;
  hasMore?: boolean;
  /**
   * FEA-3120: which store produced these rows — `local` (desktop SQLite via IPC),
   * `cloud` (synced cloud state via `apps/api`), or `fallback` (degraded/empty
   * best-effort, e.g. a failed cloud read that resolved to an empty list).
   * Populated at the read boundary in each data source, not by the DB query.
   * Optional so older/wire producers stay compatible; consumers treat an absent
   * value as "unknown source" and render nothing rather than guess.
   */
  readSource?: ReadSource;
  /**
   * FEA-3695 — the AUTHORITATIVE per-session captured cost (USD), each session
   * counted ONCE. Keyed by the non-nullable session artifact id
   * (`BranchRow.sessionIds[n]`), so a session linked to N branches has ONE entry,
   * not N. This is the same deduped basis the server's total-spend KPI and the
   * usage summary use (`distinctSessionCosts`) — NOT the per-branch
   * raw compatibility `estimatedCostUsd`, which copies a shared session's full
   * cost onto every branch it touched rather than using the canonical share.
   *
   * The client uses this to recompute filtered branch spend and KLOC-per-dollar
   * WITHOUT double-counting: it sums each visible session's authoritative cost
   * exactly once, instead of inferring per-session shares from over-counting
   * branch totals. An un-priced session is recorded as `0` (priced-zero), so
   * whether the filtered card renders a value or "—" follows the `> 0` gate.
   * Covers every session referenced by `items`; scoped to the returned page.
   *
   * Optional so older/wire producers stay compatible: when absent, the client
   * falls back to the legacy branch-total inference. Both surfaces (cloud + local)
   * populate it (cross-surface parity).
   */
  sessionCostUsd?: Readonly<Record<string, number>>;
  /**
   * ISS-4632 — the LIFETIME per-session captured cost (USD), each session counted
   * ONCE, keyed by the non-nullable session artifact id — the SAME shape as
   * `sessionCostUsd` but WITHOUT the active date window applied.
   *
   * `sessionCostUsd` above is windowed (FEA-4270): under a date window it carries
   * only the in-window per-event spend, which is correct for the filtered AI-spend
   * KPI. But the Value-per-$ ratio divides a branch's LIFETIME churn (its
   * current-head file-cache diff, which has no per-date event stream to window
   * against) by spend — so its denominator must be lifetime too, or the ratio
   * inflates as the window narrows (the numerator keeps a branch's whole lifetime
   * churn once any activity is in-window, while windowed spend shrinks). The
   * client reads THIS map (not the windowed one) for the Value-per-$ denominator,
   * removing the window-sensitivity of the SPEND axis, while still reading
   * `sessionCostUsd` for filtered spend.
   *
   * The SPEND axis is only half of it: the even-split DIVISOR has to be
   * window-independent too, which is what `sessionBranchCount` below carries
   * (ISS-4689).
   *
   * Optional/additive so version-skewed clients degrade gracefully: an older
   * server omits it, and the client then falls back to `sessionCostUsd` (the
   * pre-fix windowed behavior) for the ratio. Both surfaces populate it. Equal to
   * `sessionCostUsd` when no window is active (the all-time page).
   */
  lifetimeSessionCostUsd?: Readonly<Record<string, number>>;
  /**
   * ISS-4689 — how many corpus-member branches each session touched GLOBALLY,
   * keyed by the non-nullable session artifact id. This is the same unfiltered
   * `getSessionBranchCounts` divisor the row's `attributedCostUsd` and the
   * branch-detail header already use, published so the client's re-derived
   * Value-per-$ card can even-split by it.
   *
   * Why the client needs it: the Value-per-$ denominator apportions each session's
   * cost evenly across the branches it touched, and the client could only count
   * the branches present in the set it was handed — the date-windowed, faceted,
   * paginated one. So a $100 session on two enriched branches of different ages
   * divided by 2 all-time but by 1 at 7d, while the numerator simultaneously lost
   * the out-of-window branch's churn: the ratio moved with the window even after
   * ISS-4632 made both axes lifetime. Dividing by the GLOBAL count instead leaves
   * each in-window branch carrying its own 1/N share of that session's spend
   * against its own churn, so the ratio holds across windows.
   *
   * Covers every session in `lifetimeSessionCostUsd` (the superset map the
   * denominator reads), scoped to the returned page. Optional/additive: an older
   * server omits it and the client falls back to its in-set count — the pre-fix
   * behavior — rather than mis-dividing. Both surfaces (cloud + local) populate it.
   */
  sessionBranchCount?: Readonly<Record<string, number>>;
};

// --- DETAIL ---

/**
 * FEA-2276: one priced activity span of a branch session — the classifier's
 * `session_activity_segments` tiling (FEA-2269) with the turn spend that falls in
 * its half-open `[startMs, endMs)` window attributed to it. Produced ONCE by the
 * shared, Node-safe `@repo/lib/branches/activity-attribution` kernel so the cloud
 * read (`branch-read-service`) and the desktop-local projection
 * (`shared-branches-api`) cannot compute divergent per-activity spend — the
 * web+desktop authenticated-parity requirement. `phase` is the verbatim classifier
 * label (a bounded free string, taxonomy-agnostic on the wire — never a closed
 * union — exactly like `SyncedActivitySegmentRow.phase`). `costUsd` is `null`
 * (never 0) when no covered turn prices, mirroring the null-not-0 discipline of
 * the branch cost derivations.
 */
export type BranchActivitySegment = {
  /**
   * Verbatim classifier phase label (e.g. `implement`/`review`/`other`/`idle`).
   *
   * CLASSIFIER-VERSIONED (FEA-2269): the phase taxonomy + boundaries are a function
   * of `ACTIVITY_CLASSIFIER_VERSION`. A branch's sessions can come from different
   * contributors' desktops, so during a staggered version rollout (e.g. FEA-3778's
   * v4→v5 re-derivation) one branch's cost bar may blend tilings from two versions
   * — dollars never double-count (each turn attributes to exactly one span) but the
   * per-PHASE split can shift across the cutover. No version is surfaced on this DTO
   * yet; this is the first surface turning per-phase classification into user-facing
   * dollars, so treat the split as versioned when reasoning about cross-cutover drift.
   */
  phase: string;
  /** epoch-ms inclusive lower bound. */
  startMs: number;
  /** epoch-ms exclusive upper bound — half-open `[startMs, endMs)`. */
  endMs: number;
  /** Priced spend attributed to this span; `null` when nothing prices (never 0). */
  costUsd: number | null;
  /** Input tokens of the turns attributed to this span. */
  inputTokens: number;
  /** Output tokens of the turns attributed to this span. */
  outputTokens: number;
  cacheReadTokens?: number; // Turns attributed to this span.
  cacheWriteTokens?: number; // Turns attributed to this span.
  /** Stable persisted spend-event identities covered by this span. */
  sourceEventIds?: readonly string[];
  /** Event-time cost evidence retained for canonical metric windows. */
  costEvents?: readonly BranchActivityCostEvent[];
  /** Classifier attribution confidence in [0, 1]. */
  confidence: number;
};

/** One persisted priced event assigned to an activity span. */
export type BranchActivityCostEvent = {
  sourceEventId: string;
  occurredAtMs: number;
  costUsd: number;
};

export type BranchSession = BranchSessionCostFields & {
  sessionId: string;
  slug: string | null;
  name: string | null;
  /** Stable surface-neutral route reference; omitted by legacy producers. */
  navigableRef?: string;
  /** Harness-local identity retained only as optional secondary provenance. */
  externalSessionId?: string;
  harness: string;
  /** Additive classifier output for build/review/related branch membership. */
  role?: BranchSessionRole;
  /**
   * Additive persisted branch participation. Omitted by legacy producers and
   * rows where participation is unknown; consumers must not infer this from
   * `role`, which remains a broader membership/context classifier.
   */
  participation?: BranchParticipationKind;
  /**
   * Additive same-session lifecycle segments. Omitted by legacy producers and
   * normalized to an empty list by helper consumers; never infer these phases
   * from `role`, which is only a membership/context classifier.
   */
  phaseSegments?: readonly BranchLifecyclePhaseSegment[];
  startedAt: string;
  endedAt: string | null;
  /** session_artifact_links.is_primary */
  isPrimary: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * FEA-2276: the session's priced activity-segment tiling, when available.
   * Optional + additive — absent (NOT `[]`) for sessions with no classified
   * segments (older desktop builds, pre-backfill history, or the non-hydrated
   * link-row spine), whose whole priced spend lands in the branch rollup's
   * `unattributed` residual rather than a fabricated taxonomy bucket. `[]` means a
   * session that WAS hydrated but genuinely tiled to nothing renderable. Both feed
   * `unattributed` at rollup; the distinction is preserved so a producer never
   * fabricates an empty tiling for a session it simply did not load.
   */
  activitySegments?: BranchActivitySegment[];
  /** Stable human owner identity for deterministic cross-session actor color ties. */
  ownerUserId?: string | null;
  /**
   * FEA-3576 — the resolved display name of the HUMAN stakeholder/user who owns
   * (paid for) this session, so the branch-detail PR activity timeline can
   * segment each hour by user spend rather than by the session/model actor.
   * Cloud resolves this from the session's `SessionDetail.userId` (batched,
   * org-scoped User lookup — the same owner attribution the branch-list `owner`
   * column and byActor rollup use); desktop is single-player, so it is the local
   * desktop user label. NULL when no owner is resolvable (folds into the shared
   * "unattributed" bucket). Nullable so an un-hydrated/ownerless session is
   * honest rather than fabricating a user.
   */
  ownerUserName: string | null;
};

export type BranchReviewedParticipant = {
  login: string;
  avatarUrl: string | null;
  participation: typeof BranchParticipationKind.Reviewed;
  state: Exclude<ReviewDecision, typeof ReviewDecision.Dismissed>;
  submittedAt: string;
  providerReviewId: string;
  providerUrl: string | null;
  prNumber: number;
};

export type BranchLifecycleBoundary = {
  kind: BranchLifecycleBoundaryKind;
  observedAt?: string;
  evidenceId?: string;
};

export type BranchLifecyclePhaseSegment = {
  /** Canonical array order within one session, starting at 0. */
  sequence: number;
  phase: BranchLifecyclePhase;
  startedAt?: string;
  endedAt?: string;
  startBoundary: BranchLifecycleBoundary;
  endBoundary?: BranchLifecycleBoundary;
  evidenceIds?: readonly string[];
};

export type BranchLifecyclePhaseCostRollup = {
  /** New producers emit only the three consumer-visible lifecycle phases. */
  phase: BranchVisibleLifecyclePhase;
  /** Concrete phase allocation; header cost remains nullable when unpriced. */
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Distinct sessions contributing to this phase. A session can count in multiple phases. */
  sessionCount: number;
};

/**
 * A Closedloop artifact (PRD / plan / feature, e.g. "FEA-1952") that the branch
 * IMPLEMENTS — the "linked artifacts" of the detail page. v1 derives these from
 * the slug embedded in the BRANCH NAME (the only reliable branch→artifact
 * signal); session-transcript mentions are deliberately NOT used as links (they
 * are incidental prose/URL/tool references, not "this branch delivered this").
 * Cloud projections can additionally include exact, permission-filtered
 * Document PRODUCES Branch lineage with stable artifact identity and routing.
 */
export type BranchLinkedArtifact = {
  /** Canonical Closedloop slug, e.g. "FEA-1952" / "PLN-988". */
  slug: string;
  /** Stable Artifact identity when inclusion came from persisted lineage. */
  artifactId?: string;
  /** Product-visible label; omitted by branch-name-only producers. */
  label?: string;
  /** Canonical in-product navigation reference. */
  href?: string;
  /** Exact evidence that admitted this artifact to the delivered collection. */
  evidence?: {
    kind: BranchLinkedArtifactEvidenceKind;
    linkId?: string;
  };
};

/** Exact persisted evidence kinds that can admit a delivered artifact. */
export const BranchLinkedArtifactEvidenceKind = {
  BranchNameSlug: "branch_name_slug",
  DocumentProducesBranch: "document_produces_branch",
} as const;
export type BranchLinkedArtifactEvidenceKind =
  (typeof BranchLinkedArtifactEvidenceKind)[keyof typeof BranchLinkedArtifactEvidenceKind];

/** Cloud collection status; omission remains compatible with older producers. */
export const BranchLinkedArtifactCollectionState = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchLinkedArtifactCollectionState =
  (typeof BranchLinkedArtifactCollectionState)[keyof typeof BranchLinkedArtifactCollectionState];

export const BranchLinkedArtifactCollectionProvenance = {
  BranchNameOnly: "branch_name_only",
  CloudPersisted: "cloud_persisted",
} as const;
export type BranchLinkedArtifactCollectionProvenance =
  (typeof BranchLinkedArtifactCollectionProvenance)[keyof typeof BranchLinkedArtifactCollectionProvenance];

/**
 * Persisted selected-PR detail projected independently from Branch-owned state.
 * The additive object lets new clients verify explicit selection while older
 * producers may omit it and older consumers continue using compatibility fields.
 */
export type BranchSelectedPullRequestDetail = BranchAssociatedPullRequest & {
  body: string | null;
  headRefOid: string | null;
  mergeCommitSha: string | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
};

/**
 * One real git commit on the branch (PRD-486). On the desktop these are captured
 * event-time — recorded when the `git commit` runs in a session, NOT reconstructed
 * from `git log` — so each carries its real commit instant and subject. Drives the
 * activity rail's per-commit green dots, positioned by `committedAt`.
 */
export type BranchCommit = {
  /** Commit SHA (7–40 hex). */
  sha: string;
  /** ISO commit time — the real commit instant, not the desktop scan time. */
  committedAt: string;
  /** Commit subject line; empty string when not captured. */
  message: string;
};

/**
 * One idle gap (≥ the merged-trace idle threshold) between two consecutive
 * captured activity instants on the branch — the hatched gaps of the lead-time
 * waterfall.
 */
export type BranchIdleSpan = {
  startT: string;
  endT: string;
  gapMs: number;
};

/**
 * Lightweight work/idle activity summary for the lead-time waterfall (PLN-1148
 * Phase 2). Derived server-side from the captured event instants — which survive
 * the light (`omitEventData`) hydration — so the DEFAULT branch-detail view can
 * chart work-vs-idle WITHOUT loading the full `mergedTrace` (the events-heavy
 * trace is fetched lazily only when the Sessions & timeline tab opens). The
 * waterfall builds its track from `firstActivityT` → `max(lastActivityT,
 * mergedAt)` with `idleSpans` hatched.
 */
export type BranchLeadTimeActivity = {
  firstActivityT: string | null;
  lastActivityT: string | null;
  idleSpans: readonly BranchIdleSpan[];
};

/**
 * Surface detail type. Renamed from the contract's `BranchDetail` to avoid the
 * `artifact.ts:134` collision (a different, unrelated branch-artifact type).
 */
export type BranchPageDetail = BranchRow & {
  /**
   * Additive all-known persisted PR collection and deterministic default.
   * Older cloud/Desktop producers omit this; omission is unknown legacy
   * evidence and must not be interpreted as a complete empty collection.
   */
  associatedPullRequests?: BranchAssociatedPullRequestCollection;
  /**
   * Explicitly resolved persisted PR. `null` means the producer resolved no
   * selection; omission identifies an older producer without this capability.
   */
  selectedPullRequest?: BranchSelectedPullRequestDetail | null;
  /**
   * Additive selected-PR immutable checks evidence for Branch detail consumers.
   * Older producers omit it; omission must not be interpreted as known-empty.
   */
  selectedPullRequestChecks?: BranchSelectedPullRequestChecksResponse;
  /** READ-ONLY PR description (clamp/expand). Draft-PR CTA DEFERRED. */
  prBody: string | null;
  prBodyHtmlUrl: string | null;
  /** Selected persisted PR head; selector-dependent compatibility field. */
  headSha: string | null;
  /** Branch ref head, kept separate from historical selected-PR revision. */
  branchHeadSha?: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /**
   * GitHub PR createdAt — the rail's distinct "PR opened" dot (PRD-486 / FEA-3552).
   * Populated on BOTH surfaces: desktop from `gh` enrichment, cloud from the
   * persisted `PullRequestDetail.githubCreatedAt`. Null only until a producer has
   * stamped the createdAt on the row; never fabricated from another timestamp.
   */
  openedAt: string | null;
  /** Real commits on the branch, oldest-first — the rail's per-commit dots (PRD-486). */
  commits: BranchCommit[];
  sessions: BranchSession[];
  /**
   * Additive GitHub PR reviewers who participated by reviewing the current PR.
   * These rows are derived from provider review records, not from
   * session→branch write attribution, so consumers must not count them as wrote
   * participation, owners, tokens, spend, or lifecycle cost.
   */
  reviewedParticipants?: readonly BranchReviewedParticipant[];
  /** True when the API response capped the inline reviewed participant list. */
  reviewedParticipantsTruncated?: boolean;
  /** Additive visible-phase rollup; omission means the producer lacks evidence. */
  lifecyclePhaseStacks?: readonly BranchLifecyclePhaseCostRollup[];
  phaseAttribution?: BranchPhaseAttributionResult; // Canonical priced segments and provenance.
  /** Additive ISS-4469 lifetime formulas and selected-cycle outcomes. */
  canonicalMetrics?: BranchDetailMetricBundle;
  /**
   * Cross-session interleaved trace incl. sessionstart + idle. PLN-1148 Phase 2:
   * the detail endpoint no longer ships this (always `[]`); it is fetched lazily
   * via the dedicated trace endpoint when the Sessions & timeline tab opens, and
   * the tab merges it back in. The lightweight `leadTime` summary below covers the
   * default view's only trace need (the lead-time waterfall).
   */
  mergedTrace: MergedTraceItem[];
  /** Work/idle activity summary for the lead-time waterfall (no trace needed). */
  leadTime: BranchLeadTimeActivity;
  /** Legacy display numbers; repository-qualified history lives in `associatedPullRequests`. */
  linkedPrNumbers: readonly number[];
  /** Closedloop artifacts admitted by exact branch-name or persisted-link evidence. */
  linkedArtifacts: readonly BranchLinkedArtifact[];
  /** Additive provenance for the permission-filtered delivered collection. */
  linkedArtifactsCollection?: {
    state: BranchLinkedArtifactCollectionState;
    provenance: BranchLinkedArtifactCollectionProvenance;
  };
};

// --- USAGE compatibility aliases ---

/** @deprecated Import from `@repo/api/src/types/branch-usage`. */
export type BranchUsageActorBucket = CanonicalBranchUsageActorBucket;
/** @deprecated Import from `@repo/api/src/types/branch-usage`. */
export type BranchUsageHourBucket = CanonicalBranchUsageHourBucket;
/** @deprecated Import from `@repo/api/src/types/branch-usage`. */
export type BranchUsagePhaseStack = CanonicalBranchUsagePhaseStack;
/** @deprecated Import from `@repo/api/src/types/branch-usage`. */
export type BranchUsageSummary = CanonicalBranchUsageSummary;

// --- ANALYTICS (medians, rates, gated markers, 30-day baselines) ---

/** Population measured by a legacy `BranchKpi` 30-day comparison (ISS-4686). */
export const BranchBaselineScope = {
  /** Aggregated across the whole viewer-scoped branch corpus, not one branch. */
  Corpus: "corpus",
  /** Measured over the SUBJECT branch's own trailing 30-day window. */
  Branch: "branch",
} as const;
export type BranchBaselineScope =
  (typeof BranchBaselineScope)[keyof typeof BranchBaselineScope];

/**
 * WHAT a branch metric measures — the second half of comparability (ISS-4686).
 * Two figures over the same population still cannot be compared when they
 * measure different spans: `leadTimeForChangeMs` is first-commit → merge, while
 * the lead-time headline card shows first-session → merge.
 */
export const BranchMetricBasis = {
  /** Total churn (added + removed lines) ÷ estimated cost. */
  ChurnPerDollar: "churn_per_dollar",
  /** DORA lead time for change: first commit → merge. */
  FirstCommitToMerge: "first_commit_to_merge",
  /** Wall clock from the first contributing session → merge. */
  FirstSessionToMerge: "first_session_to_merge",
  /** Summed estimated AI cost, in USD. */
  EstimatedSpendUsd: "estimated_spend_usd",
  /** Count of branches whose status is neither merged nor closed. */
  ActiveBranchCount: "active_branch_count",
  /** Merged ÷ decided (merged + closed) PRs, as a percentage. */
  MergeRateOfDecided: "merge_rate_of_decided",
  /** Median additions + deletions across merged PRs. */
  MedianMergedPrChurn: "median_merged_pr_churn",
} as const;
export type BranchMetricBasis =
  (typeof BranchMetricBasis)[keyof typeof BranchMetricBasis];

type BranchKpiMeasurement = {
  /** null when unavailable/degraded. */
  value: number | null;
  /** available=local; gated=needs connect-GitHub; unavailable=no data. */
  state: BranchKpiState;
};

/** No 30-day comparison — the state every producer emits today. */
type BranchKpiWithoutBaseline = {
  baseline30d: null;
  deltaPct: null;
  /** Nothing to scope, so the field stays OFF the wire (old clients unaffected). */
  comparisonScope?: undefined;
};

/**
 * A REAL 30-day trailing baseline plus the population it may be compared within.
 *
 * `comparisonScope` is REQUIRED on this arm, and it describes the KPI as a WHOLE
 * — `value` AND `baseline30d` — not just the baseline. `deltaPct` is a statement
 * about THIS KPI's `value`, so scoping only the baseline would still let a
 * corpus-valued KPI be marked branch-scoped and pass a consumer's check while
 * the percentage kept describing the org. Requiring it here means the unscoped
 * state that made ISS-4686 possible does not typecheck rather than merely
 * not-occur.
 */
type BranchKpiWithBaseline = {
  baseline30d: number;
  /** (value - baseline30d) / baseline30d * 100; null when `value` is null. */
  deltaPct: number | null;
  comparisonScope: BranchBaselineScope;
};

export type BranchKpi = BranchKpiMeasurement &
  (BranchKpiWithoutBaseline | BranchKpiWithBaseline);

/** Canonical no-comparison value retained for legacy KPI compatibility. */
export const NO_BRANCH_KPI_BASELINE = {
  baseline30d: null,
  deltaPct: null,
} as const;

export type BranchAnalytics = {
  viewerScope: BranchViewerScope;
  /** Additive ISS-4469 dictionary-backed result for the exact query cohort. */
  canonicalMetrics?: BranchListMetricBundle;
  /**
   * median `additions + deletions` over MERGED, single-PR branches whose LOC is
   * KNOWN. "Known" here means the branch's file-change rows fold to a non-null
   * line total via `sumFileChanges` (BOTH dimensions present) — i.e. at least one
   * enriched file row exists. A branch whose line total is null (un-enriched, OR
   * a branch that enriched with ZERO file-change rows — `sumFileChanges([])` →
   * `{additions: null}`) is EXCLUDED from the median population; it is NOT folded
   * in as 0. Multi-PR branches (`multiPrWarning`) are also excluded (ambiguous
   * lifecycle). Unavailable (null, NOT 0) when the median population is empty —
   * no merged single-PR branch has a non-null LOC total (FEA-2159).
   *
   * PARITY CAVEAT (verified 2026-07-28, FEA-4271): this basis matches the desktop
   * producer (`branch-analytics-projection.ts`) and the client filtered
   * projection (`filtered-branch-analytics.ts`) — all three key "known" off
   * `sumFileChanges`/`isLocEnrichedRow`, so all three DROP a merged branch with
   * zero file-change rows. It does NOT fully match the delivery dashboard
   * (`getDelivery` in `apps/api/app/insights/service.ts`): getDelivery keys
   * enrichment off `BranchDetail.fileCacheStatus === Fresh` and folds a Fresh
   * zero-row branch in as a KNOWN 0 (`?? 0`), so a genuine 0-LOC merged branch
   * COUNTS toward getDelivery's median but is EXCLUDED here. Reconciling the two
   * (teaching this producer to read `fileCacheStatus` so an enriched-but-empty
   * branch is a known 0) is a follow-up, not done here.
   */
  medianPrSize: BranchKpi;
  /**
   * merged / DECIDED — the share of branches with a terminal-outcome (latest PR
   * state MERGED or CLOSED) that merged, as a percentage. AVAILABLE whenever the
   * decided cohort is nonempty; UNAVAILABLE (null) when no branch has a decided
   * PR. It is never GATED — no producer returns a Gated state for this KPI.
   * Still-open PRs are NOT in the denominator: counting them would conflate "not
   * merged yet" with "won't merge" and understate the rate. This is the
   * decided-cohort rate shared with the desktop producer (FEA-2942/FEA-2943), NOT
   * merged / opened.
   *
   * `multiPrWarning` branches are EXCLUDED from BOTH the numerator and the
   * denominator on the desktop producer and the client filtered projection.
   * That field is a legacy live-overlay ambiguity gate, not associated-history
   * multiplicity; cloud keeps it structurally false. New consumers must use the
   * repository-qualified `associatedPullRequests` collection instead.
   */
  mergeRate: BranchKpi;
  /** first-commit -> merge (GATED). */
  medianTimeToMergeMs: BranchKpi;
  /** GATED; retires the hardcoded "86" placeholder. */
  activePrCount: BranchKpi;
  /** GATED. */
  mergedCount: BranchKpi;
  /** first-commit -> deploy/merge (DORA); GATED. */
  leadTimeForChangeMs: BranchKpi;
  /** total churn (added + removed lines) / cost (LOCAL when cost + LOC present). */
  locPerDollar: BranchKpi;
  /**
   * Total estimated AI cost across the corpus (LOCAL — summed from local
   * token_usage pricing, no GitHub). Unavailable (NOT 0) when no priced cost.
   */
  totalSpendUsd: BranchKpi;
  /**
   * Count of branches still in progress — status not merged/closed (LOCAL,
   * from branch status, no GitHub PR state). Unavailable on an empty corpus.
   */
  activeBranchCount: BranchKpi;
  buildVsReworkSplit: {
    buildPct: number | null;
    reworkPct: number | null;
    state: BranchKpiState;
  };
};

/**
 * What each listed `BranchAnalytics` KPI's `value`/`baseline30d` MEASURE, keyed
 * by field name so the basis sits beside the field docs above and cannot drift
 * into a card's local comment (ISS-4686).
 *
 * SCOPE OF THE PROMISE: this covers exactly the KPIs listed below, and BOTH
 * Branches consumers of a `BranchKpi` baseline route through it via
 * `resolveBranchBaselineComparison` — the branch-DETAIL headline cards
 * (`branch-headline-cards.tsx`, per-branch figures, `valueScope: Branch`) and the
 * Branches LIST summary cards (`branches-summary-cards.tsx`, corpus figures,
 * `valueScope: Corpus`). Neither reads `deltaPct` off the wire, so the two
 * surfaces cannot print incompatible things about the same KPI on the same visit
 * — the list can't show a "+12% better" chip drawn from a BRANCH-scoped baseline
 * while the detail card shows "No comparison" for the same metric (#4242 review).
 *
 * The list card's `valueBasis` IS its `baselineBasis`, because that card renders
 * `kpi.value` itself rather than deriving a figure — the gate that does the work
 * there is `comparisonScope`. The detail cards derive their own numbers, so for
 * them both halves are live.
 */
export const BRANCH_KPI_METRIC_BASIS = {
  locPerDollar: BranchMetricBasis.ChurnPerDollar,
  leadTimeForChangeMs: BranchMetricBasis.FirstCommitToMerge,
  totalSpendUsd: BranchMetricBasis.EstimatedSpendUsd,
  activeBranchCount: BranchMetricBasis.ActiveBranchCount,
  mergeRate: BranchMetricBasis.MergeRateOfDecided,
  medianPrSize: BranchMetricBasis.MedianMergedPrChurn,
} as const satisfies Partial<Record<keyof BranchAnalytics, BranchMetricBasis>>;

/**
 * Combined list + analytics read (FEA-3056 follow-up). The Branches screen
 * mounts both together on every load; a `BranchesDataSource.pageData` call lets
 * an implementation serve them from one shared read instead of the two
 * independently re-scanning the same underlying rows.
 */
/**
 * FEA-4177 — independent failure domains. The `analytics` half is best-effort: a
 * data source that reads the two halves independently (the HTTP source's two
 * concurrent requests) must NOT let an analytics-read failure reject the whole
 * page-data read and blank the branches table. On an analytics failure it
 * resolves the list with `analytics` omitted and `analyticsError: true` so the
 * summary cards degrade to their own error state while the table still renders (a
 * list failure still rejects, since the table cannot render without it). The
 * desktop source shares ONE scan for both halves (FEA-3056), so it either
 * populates both or fails both together and leaves `analyticsError` absent.
 */
export type BranchesPageData = {
  list: BranchListResponse;
  analytics?: BranchAnalytics;
  analyticsError?: boolean;
};

export type BranchRefreshResponse = {
  branch: BranchPageDetail | null;
  status: BranchRefreshStatus;
  reason?: BranchRefreshReason;
  retryAfterSeconds?: number;
};

/** @deprecated Import `MergedTraceItem` from `branch-trace.ts` instead. */
export type MergedTraceItem = CanonicalMergedTraceItem;

/** @deprecated Import `BranchTraceResponse` from `branch-trace.ts` instead. */
export type BranchTraceResponse = {
  branchId: CanonicalBranchTraceResponse["branchId"];
  viewerScope: CanonicalBranchTraceResponse["viewerScope"];
  items: CanonicalBranchTraceResponse["items"];
  hasMore: CanonicalBranchTraceResponse["hasMore"];
  traceState?: CanonicalBranchTraceResponse["traceState"];
};
