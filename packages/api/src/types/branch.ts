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

import type { ToolItem } from "./agent-session.js";
import type { ChecksStatus, ReviewDecision } from "./branch-checks.js";
import type { GitHubPRState } from "./github.js";
import type { ReadSource } from "./read-source.js";

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

export const BranchCloudHydrationStatus = {
  NotConnected: "not_connected",
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

const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Canonical normalizer for a repository full name (PRD-510 D2). The single owner
 * used by every branch/commit producer so the identity key
 * `(organizationId, repositoryFullName, branchName)` is byte-identical across the
 * desktop-sync and GitHub-webhook lanes regardless of GitHub App installation.
 *
 * Operates on an already-extracted `owner/name` string — it does NOT parse a
 * remote URL (the desktop's URL→owner/name extraction is a separate concern).
 * Normalization: trim surrounding whitespace, strip a trailing `.git`, strip
 * leading/trailing slashes, and lowercase (GitHub owners/repos are
 * case-insensitive). Idempotent — normalizing an already-normalized name is a
 * no-op, so it is safe to apply defensively at every write and read site.
 */
export function normalizeRepoFullName(fullName: string): string {
  let next = fullName
    .trim()
    .replace(LEADING_SLASHES_RE, "")
    .replace(TRAILING_SLASHES_RE, "");
  if (next.toLowerCase().endsWith(".git")) {
    next = next.slice(0, -".git".length);
  }
  return next.replace(TRAILING_SLASHES_RE, "").toLowerCase();
}

// --- QUERY FILTERS (shared by the list/usage/analytics reads) ---

/**
 * Query filters shared by every branch read. Canonical home (CLAUDE.md: shared
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
  // Cloud-only dimensions — ignored by the local source; REST routes reject
  // unsupported dimensions until their downstream predicates are implemented.
  userId?: string;
  teamId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

// --- LIST ---

export type BranchRow = {
  /** `encodeBranchId(repoFullName, branchName)` OR a BRANCH artifact id. */
  id: string;
  branchName: string;
  /** NULL -> "missing"; enrichment `base_ref` unpopulated today. */
  baseBranch: string | null;
  /** NULL until repo-identity capture (FEA-1899). */
  repoFullName: string | null;
  /** Actor; NULL when not captured -> "unattributed". */
  owner: string | null;
  status: BranchStatus;
  prNumber: number | null;
  prTitle: string | null;
  /** NULL when no PR / enrichment `pr_state` unpopulated. */
  prState: BranchPrState | null;
  prUrl: string | null;
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
  /** enrichment `lines_added`; NULL = unavailable (NOT 0). */
  additions: number | null;
  /** enrichment `lines_removed`; NULL = unavailable. */
  deletions: number | null;
  /** Persisted branch/PR artifact LOC when enriched; NULL when unavailable. */
  filesChanged: number | null;
  /** Optional desktop cloud overlay status; omitted by older/local-only producers. */
  cloudHydrationStatus?: BranchCloudHydrationStatus;
  cloudHydrationFailure?: string;
  /** Derived; NULL when no token_usage rows. */
  estimatedCostUsd: number | null;
  /**
   * ISO timestamp of the branch's most recent GENUINE activity (PLN-1034): a
   * pushed commit, PR open/merge/close, or PR review submission — sourced from
   * `branch_detail.last_activity_at`. NOT a row-write/sync time. The default
   * Branches sort.
   */
  lastActivityAt: string;
  /** Sessions via session_artifact_links (targetKind=branch). */
  sessionIds: readonly string[];
  /** Cloud/API state derivation; omitted by older local producers. */
  dataState?: BranchDataState;
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
};

// --- DETAIL ---

export type BranchSession = {
  sessionId: string;
  slug: string | null;
  name: string | null;
  harness: string;
  startedAt: string;
  endedAt: string | null;
  /** session_artifact_links.is_primary */
  isPrimary: boolean;
  estimatedCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Standalone discriminated union — authoritative for the branch merged-trace
 * renderer (openQuestion #3). Deliberately NOT coupled to the Sessions
 * `TurnItem` union. `sessionstart.actor` carries the richer fields D1/E4 consume
 * (harness/isResumed/machine/isNew/ci) so they read existing flags rather than
 * re-deriving them from idle->active transitions.
 */
export type MergedTraceItem =
  | {
      type: "sessionstart";
      sessionId: string;
      t: string;
      actor: {
        name: string | null;
        harness: string | null;
        isResumed?: boolean;
        machine?: string | null;
        isNew?: boolean;
        ci?: boolean;
      };
    }
  | { type: "idle"; sessionId: string; t: string; gapMs: number }
  | {
      type: "prompt" | "say";
      sessionId: string;
      t: string;
      tMs: number;
      cumCostUsd: number | null;
      actorName: string | null;
      text: string;
    }
  | {
      type: "tools";
      sessionId: string;
      t: string;
      tMs: number;
      endMs: number;
      summary: string;
      hasFail: boolean;
      failN: number;
      /**
       * Per-tool rows backing the expand/collapse card. Optional so legacy
       * producers (and fixtures) that only carry the summary still type-check;
       * the desktop builder populates it so the branch trace's tool cards expand
       * with the same detail as the session-detail trace.
       */
      items?: readonly ToolItem[];
    }
  | {
      type: "subagent";
      sessionId: string;
      t: string;
      tMs: number;
      sub: string;
      model: string | null;
      costUsd: number | null;
    }
  | {
      type: "event";
      sessionId: string;
      t: string;
      dot: "g" | "b" | "r";
      text: string;
      tag?: string;
    }
  | { type: "end"; sessionId: string; text: string };

/**
 * A Closedloop artifact (PRD / plan / feature, e.g. "FEA-1952") that the branch
 * IMPLEMENTS — the "linked artifacts" of the detail page. v1 derives these from
 * the slug embedded in the BRANCH NAME (the only reliable branch→artifact
 * signal); session-transcript mentions are deliberately NOT used as links (they
 * are incidental prose/URL/tool references, not "this branch delivered this").
 * Only the `slug` is carried (no title/url has a local producer).
 */
export type BranchLinkedArtifact = {
  /** Canonical Closedloop slug, e.g. "FEA-1952" / "PLN-988". */
  slug: string;
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
  /** READ-ONLY PR description (clamp/expand). Draft-PR CTA DEFERRED. */
  prBody: string | null;
  prBodyHtmlUrl: string | null;
  headSha: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /** GitHub PR createdAt — the rail's PR-opened dot (PRD-486); null until enriched. */
  openedAt: string | null;
  /** Real commits on the branch, oldest-first — the rail's per-commit dots (PRD-486). */
  commits: BranchCommit[];
  sessions: BranchSession[];
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
  /** length>1 sets multiPrWarning and gates KPIs. */
  linkedPrNumbers: readonly number[];
  /** Closedloop artifacts derived from the branch-name slug (slug only). */
  linkedArtifacts: readonly BranchLinkedArtifact[];
};

// --- USAGE (per-hour-per-actor buckets + phase stacks) ---

export type BranchUsageActorBucket = {
  /** NULL = "unattributed". */
  owner: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

export type BranchUsageHourBucket = {
  /** ISO truncated to the hour (UTC default; tz-option upstream). */
  hourStart: string;
  byActor: BranchUsageActorBucket[];
};

export type BranchUsagePhaseStack = {
  phase: BranchPhase;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
};

export type BranchUsageSummary = {
  viewerScope: BranchViewerScope;
  totalBranches: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedCost: number;
  /** BranchBillingMode.Subscription split (v1-degraded best-effort). */
  subscriptionEstimatedCost: number;
  /** BranchBillingMode.Api split (v1-degraded best-effort). */
  apiEstimatedCost: number;
  /** per-hour-per-actor (FEA-1834 O(grouped)). */
  hourBuckets: BranchUsageHourBucket[];
  /** phase-stacked cost/tokens (v1-degraded best-effort). */
  phaseStacks: BranchUsagePhaseStack[];
  /** rolled-up per-actor totals. */
  byActor: BranchUsageActorBucket[];
};

// --- ANALYTICS (medians, rates, gated markers, 30-day baselines) ---

export type BranchKpi = {
  /** null when unavailable/degraded. */
  value: number | null;
  /** available=local; gated=needs connect-GitHub; unavailable=no data. */
  state: BranchKpiState;
  /** 30-day trailing baseline; null when window empty. */
  baseline30d: number | null;
  /** (value - baseline30d) / baseline30d * 100; null when either side null. */
  deltaPct: number | null;
};

export type BranchAnalytics = {
  viewerScope: BranchViewerScope;
  /**
   * median `(additions ?? 0) + (deletions ?? 0)` over ALL MERGED, single-PR
   * branches (LOCAL). A missing line total folds in as 0 rather than excluding
   * the branch, matching the delivery dashboard (`getDelivery`); multi-PR
   * branches are excluded (ambiguous lifecycle). Unavailable only when no merged
   * single-PR branch exists (FEA-2159).
   */
  medianPrSize: BranchKpi;
  /** merged / opened over window (GATED until PR enrichment). */
  mergeRate: BranchKpi;
  /** first-commit -> merge (GATED). */
  medianTimeToMergeMs: BranchKpi;
  /** GATED; retires the hardcoded "86" placeholder. */
  activePrCount: BranchKpi;
  /** GATED. */
  mergedCount: BranchKpi;
  /** first-commit -> deploy/merge (DORA); GATED. */
  leadTimeForChangeMs: BranchKpi;
  /** net LOC / total cost (LOCAL when cost + LOC present). */
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

export type BranchTraceResponse = {
  branchId: string;
  viewerScope: BranchViewerScope;
  items: MergedTraceItem[];
  hasMore: boolean;
};

export type BranchRefreshResponse = {
  branch: BranchPageDetail | null;
  status: BranchRefreshStatus;
  reason?: BranchRefreshReason;
  retryAfterSeconds?: number;
};
