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

// --- Branch-id encode/decode (single owner: A1; B1 produces, D1 parses, C2/C3 route) ---

const BRANCH_ID_DELIMITER = "::";
/**
 * Sentinel substituted for a null `repoFullName`. Real repo identities are in
 * "owner/name" form (always slash-bearing), so the slash-free sentinel never
 * collides with a captured repo and round-trips back to null on decode.
 */
const LOCAL_REPO_SENTINEL = "local";

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
  owner?: string; // branch owner (actor) filter
  status?: string; // BranchStatus value
  search?: string; // free-text over branchName / repo / prTitle
  // Cloud-only dimensions — IGNORED by the local source, honored by REST.
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
  /** Fetched LIVE, NEVER persisted; NULL on list (and on detail in v1). */
  filesChanged: number | null;
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
};

export type BranchListResponse = {
  items: BranchRow[];
  total: number;
  /** Local source always "self". */
  viewerScope: BranchViewerScope;
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
  /** Cross-session interleaved trace incl. sessionstart + idle. */
  mergedTrace: MergedTraceItem[];
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
   * median (additions+deletions) of MERGED, single-PR branches (LOCAL). A
   * branch with no LOC enrichment counts as 0 lines (`(additions ?? 0) +
   * (deletions ?? 0)`) and is INCLUDED, mirroring the delivery dashboard's
   * `?? 0` inclusion so the two surfaces report the same metric (FEA-2159).
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
