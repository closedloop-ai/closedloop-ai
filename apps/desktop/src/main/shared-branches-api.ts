import { performance } from "node:perf_hooks";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import {
  type BranchAnalytics,
  type BranchCloudHydrationStatus,
  type BranchIdleSpan,
  type BranchLeadTimeActivity,
  type BranchLinkedArtifact,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchPrState,
  type BranchRow,
  type BranchSession,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  decodeBranchId,
  encodeBranchId,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  buildMergedTrace as buildSharedMergedTrace,
  MERGED_TRACE_IDLE_THRESHOLD_MS,
  type MergedTraceSessionInput,
} from "@repo/lib/branches/merged-trace";
import { normalizeBillingMode } from "../shared/billing-mode.js";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
  type SharedBranchesListRequest,
  type SharedBranchesQuery,
} from "../shared/shared-branches-contract.js";
import { estimateTokenCost } from "../shared/token-cost.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import type { SessionAttributionResolverCache } from "./agent-session-sync-service.js";
import {
  projectBranchAnalytics,
  sumLocEnrichedSpend,
} from "./branch-analytics-projection.js";
import {
  type BranchUsageRow,
  projectBranchUsage,
  sumStoredBranchCost,
} from "./branch-usage-projection.js";
import {
  type BranchCommitRow,
  type BranchLinkRow,
  type BranchPrRow,
  readBranchAnalyticsTokenRows,
  readBranchCommitRowsForSessions,
  readBranchTokenAggregateRows,
  readBranchTokenAggregateRowsForBranch,
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
  readLocalBranchPrRows,
  readLocalBranchPrRowsForBranch,
} from "./database/branch-reads.js";
import type { DbHostAgentDatabase } from "./database/sqlite.js";
import type {
  DesktopCloudGitHubHydration,
  DesktopCloudGitHubHydrationResult,
} from "./desktop-cloud-github-hydration.js";
import { gatewayLog } from "./gateway-logger.js";
import { writePersistentLog } from "./persistent-log.js";
import { reportTokenCostPricingMiss } from "./token-cost-pricing-miss.js";

function rethrowAsSourceError(label: string, error: unknown): never {
  writePersistentLog(
    "error",
    "branch-source-error",
    `${label}: ${String(error)}`
  );
  throw new Error(SHARED_BRANCHES_SOURCE_ERROR_CODE);
}

/**
 * Process-wide serialization gate for heavy branch reads (FEA-3056).
 *
 * The Branches screen fires the list + analytics handlers together on load as
 * SEPARATE IPC requests, so per-handler sequencing alone is not enough: each
 * handler enters its own `readSequentially` and starts its first heavy read
 * immediately, so the list's and the analytics' large result sets can still be
 * materialized in the db-host worker's V8 heap simultaneously and blow past its
 * `--max-old-space-size` ceiling (exit code 5 → restart loop →
 * `LOCAL_BRANCHES_SOURCE_ERROR`). This module-level promise chain makes every
 * heavy branch read run one at a time ACROSS all handlers and concurrent
 * requests, so at most ONE big result set is ever resident.
 *
 * A read that rejects must not wedge the queue, so the tail advances on settle
 * (resolve OR reject). This only orders WHEN reads run, never which rows or
 * their order — purely a peak-memory change, not a behavior change.
 */
let branchReadTail: Promise<unknown> = Promise.resolve();

function runExclusiveBranchRead<T>(thunk: () => Promise<T>): Promise<T> {
  const run = branchReadTail.then(thunk, thunk);
  branchReadTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Run heavy, row-materializing branch reads ONE AT A TIME — globally, via the
 * shared {@link runExclusiveBranchRead} gate — so concurrent branch handlers
 * (list + analytics on screen mount) never materialize their result sets in the
 * worker heap together. Output is identical to the previous `Promise.all` (same
 * reads, same rows, same tuple order); the tuple return preserves positional
 * destructuring at the call sites and the `Thunks`/`Awaited` generics keep each
 * element's type exact.
 */
export async function readSequentially<
  Thunks extends readonly [...(() => Promise<unknown>)[]],
>(
  thunks: [...Thunks]
): Promise<{ [K in keyof Thunks]: Awaited<ReturnType<Thunks[K]>> }> {
  const results: unknown[] = [];
  for (const thunk of thunks) {
    results.push(await runExclusiveBranchRead(thunk));
  }
  return results as { [K in keyof Thunks]: Awaited<ReturnType<Thunks[K]>> };
}

/**
 * The slice of the local SQLite database the Branches serving reads through.
 *
 * A2 (PLN-983) pins this seam so the IPC handlers can register against a stable
 * source threaded by the runtime (the same `withDb`/`agentDatabase` accessor the
 * shared-agent-sessions handlers use). B1 (FEA-1948) fills the list + usage
 * bodies: they read `session_artifact_links` (the branch-naming source — the
 * desktop schema has no `artifacts(kind=branch)` table) joined to
 * `pull_requests`/`token_usage` via `source.prisma`, project through the
 * main-local `./branch-usage-projection` (the surface-agnostic
 * `@repo/app/branches/lib/branch-derivations` is unreachable under the main
 * process's `nodenext` resolution; pricing is still delegated to genai-cost),
 * sanitize read errors at this boundary, and never re-register the IPC handlers
 * (A2 is the sole registrar).
 *
 * D1 (FEA-1950) fills the detail body. It adds an OPTIONAL `syncSource` — the
 * same agent-session loader the Sessions handlers use — so the detail can hydrate
 * each linked session's real per-session token splits/cost/name/harness and build
 * the cross-session merged trace from the verified turn-item projection. It is
 * optional + additive: the list/usage/analytics ops never touch it, and a source
 * without it (e.g. a unit test exercising only the Prisma branch reads) degrades
 * to the minimal session spine + empty trace rather than failing.
 */
export type BranchSyncSource = Pick<DbHostAgentDatabase, "prisma"> &
  Partial<Pick<DbHostAgentDatabase, "syncSource">>;

export type BranchCloudHydrationSource = Pick<
  DesktopCloudGitHubHydration,
  "hydrate"
>;

/**
 * Cloud-only filters have no meaning for the local (self-scoped) source — mirror
 * the agent-sessions fail-closed: a present cloud filter yields the empty
 * canonical response rather than silently ignoring the constraint.
 *
 * DEFERRAL (v1): the facet filters (owner / repo / status / search) are still
 * applied client-side over the full local corpus by the renderer
 * (`useBranchFilterState`); server-side facet filtering lands with the authed
 * REST source. The TIME WINDOW (`startDate` / `endDate`) IS now honored here for
 * usage + analytics (FEA-2155) so the summary cards reconcile with the
 * window-filtered table instead of rendering all-time KPIs beneath a 7-day
 * table; see `filterBranchItemsByWindow`. The LIST op still windows client-side
 * (`filterBranchRowsByWindow` in the renderer) — moving that server-side is a
 * later step.
 */
function hasUnsupportedCloudFilter(request: SharedBranchesQuery): boolean {
  return Boolean(request.userId || request.teamId || request.projectId);
}

/** Parse a window bound to epoch ms; absent / unparseable → null (not applied). */
function parseWindowBoundMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Window the projected branch rows to those last active within
 * [`startDate`, `endDate`]. Compares by true INSTANT via `Date.parse` —
 * mirroring the renderer's `filterBranchRowsByWindow` and the wire-side
 * `isoEpoch` sort — because `lastActivityAt` is the producer-owned wire value
 * and may be a mixed timestamp format (space- vs `T`-separated), where a
 * byte-wise compare would mis-drop a recent row (a space `0x20` sorts before
 * `T` `0x54`). A bound that is absent or unparseable is simply not applied; a
 * row whose own `lastActivityAt` is unparseable is KEPT rather than silently
 * dropped. With NEITHER bound set (the "All time" window) the rows pass through
 * unchanged, so the all-time usage/analytics output is byte-for-byte intact.
 */
function filterBranchItemsByWindow(
  items: BranchRow[],
  request: SharedBranchesQuery
): BranchRow[] {
  const startMs = parseWindowBoundMs(request.startDate);
  const endMs = parseWindowBoundMs(request.endDate);
  if (startMs == null && endMs == null) {
    return items;
  }
  return items.filter((item) => {
    const ms = Date.parse(item.lastActivityAt);
    if (Number.isNaN(ms)) {
      return true;
    }
    if (startMs != null && ms < startMs) {
      return false;
    }
    return endMs == null || ms <= endMs;
  });
}

/** Union of the session ids across a set of branch rows. */
function collectSessionIds(items: BranchRow[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const sessionId of item.sessionIds) {
      ids.add(sessionId);
    }
  }
  return ids;
}

/**
 * Narrow the projected list to a requested id set (the contract advertises
 * narrow id reads). Sanitizes to non-empty strings and dedupes; an absent or
 * all-garbage `ids` returns the full list unchanged.
 */
function selectRequestedBranches(
  items: BranchRow[],
  ids: readonly string[] | undefined
): BranchRow[] {
  if (!ids || ids.length === 0) {
    return items;
  }
  const wanted = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) {
      wanted.add(id);
    }
  }
  if (wanted.size === 0) {
    return items;
  }
  return items.filter((item) => wanted.has(item.id));
}

/**
 * Page the projected output. `offset`/`limit` are clamped to non-negative
 * integers (a missing limit returns the rest from `offset`). The reads are
 * already bounded grouped queries; paging the output caps the IPC payload so a
 * large local corpus can't ship the whole list at once.
 */
function pageBranches(
  items: BranchRow[],
  limit: number | undefined,
  offset: number | undefined
): BranchRow[] {
  const start = Math.max(0, Math.trunc(offset ?? 0));
  if (limit == null) {
    return items.slice(start);
  }
  return items.slice(start, start + Math.max(0, Math.trunc(limit)));
}

/**
 * Lifecycle of the single linked PR, mapped to the canonical wire
 * `BranchPrState` (OPEN | MERGED | CLOSED):
 * - `merged_at` is the authoritative merge signal; a literal `"merged"` state is
 *   a defensive fallback for enrichment that sets the state without a timestamp
 *   (so `state:"merged", merged_at:null` no longer misreads as OPEN).
 * - An explicit `"closed"`/`"open"` maps directly.
 * - A NULL/unpopulated state degrades to OPEN: the v1 local parser captures PR
 *   creation, not lifecycle, so a locally-observed PR with no state is open.
 * - A non-null but UNRECOGNIZED state is genuinely indeterminate — return `null`
 *   rather than fabricate a lifecycle (the branch still shows its PR number).
 *
 * Branches with no PR at all also map to `null` (a net-new local branch).
 */
function derivePrState(pr: BranchPrRow): BranchPrState | null {
  // Lowercase comparisons are against raw `pull_requests.state` values written
  // by the local importer; the RETURNS are the canonical wire enum.
  const state = pr.state?.toLowerCase() ?? null;
  if (pr.mergedAt != null || state === "merged") {
    return GitHubPRState.Merged;
  }
  if (state === "closed") {
    return GitHubPRState.Closed;
  }
  if (state === "open" || state === null) {
    return GitHubPRState.Open;
  }
  return null;
}

/** Branch status from PR lifecycle; a branch with no PR is a draft (net-new). */
function deriveStatus(prState: BranchPrState | null): BranchStatus {
  if (prState === GitHubPRState.Merged) {
    return BranchStatus.Merged;
  }
  if (prState === GitHubPRState.Closed) {
    return BranchStatus.Closed;
  }
  if (prState === GitHubPRState.Open) {
    return BranchStatus.Open;
  }
  return BranchStatus.Draft;
}

/**
 * Parse an ISO instant to epoch millis for ordering. Unparseable / empty values
 * sort oldest (0) so a branch with a bad timestamp never floats to the top.
 */
function isoEpoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The latest parseable ISO instant among the inputs, or null when none parse.
 * Used to derive a branch's "last active" from real lifecycle events (PRD-486)
 * — commit times + PR opened/merged/closed — independently of session activity.
 */
function maxIso(
  values: ReadonlyArray<string | null | undefined>
): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

type BranchAccumulator = {
  repoFullName: string | null;
  branchName: string;
  sessionIds: Set<string>;
  // The branch's most-recent linked-session activity time (excluding scan time —
  // FEA-2022). FALLBACK ONLY (PRD-486): the list now ages a branch by its real
  // lifecycle events (commits + PR opened/merged/closed, like the cloud); this
  // session-derived time is used only when a branch has no such signal yet, so
  // commit-less or pre-PRD-486 branches still sort sensibly instead of epoch 0.
  updatedAt: string;
  // FEA-1899 net branch LOC, copied off the branch artifact via the link read.
  // Identical across a branch's link rows, so it's captured once on first sight
  // (and adopted later only if an earlier row lacked it); null until enriched.
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
};

/**
 * Group the branch-link rows into per-branch accumulators keyed by the shared
 * `encodeBranchId` slug. Session ids union; `updatedAt` tracks the latest linked-
 * session activity (the desktop's interim branch "last active" — see the type);
 * the FEA-1899 net LOC is copied off the branch artifact once (identical across a
 * branch's links, adopted later only if an earlier row lacked it). Extracted from
 * `projectBranchListItems` to keep that projector under the complexity budget.
 */
function groupBranchAccumulators(
  linkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>
): Map<string, BranchAccumulator> {
  const branches = new Map<string, BranchAccumulator>();
  for (const link of linkRows) {
    const id = encodeBranchId({
      repoFullName: link.repoFullName,
      branchName: link.branchName,
    });
    const linkLoc = completeArtifactLoc(link);
    const existing = branches.get(id);
    if (!existing) {
      branches.set(id, {
        repoFullName: link.repoFullName,
        branchName: link.branchName,
        sessionIds: new Set([link.sessionId]),
        updatedAt: link.activityAt,
        linesAdded: linkLoc?.linesAdded ?? null,
        linesRemoved: linkLoc?.linesRemoved ?? null,
        filesChanged: linkLoc?.filesChanged ?? null,
      });
      continue;
    }
    existing.sessionIds.add(link.sessionId);
    // The branch's "updated" time is its most-recent session ACTIVITY, not the
    // link's scan time (FEA-2022). Compare by parsed epoch — session activity
    // timestamps come from transcript turns and may differ in format/offset, so
    // a lexicographic string max can pick the wrong instant.
    if (isoEpoch(link.activityAt) > isoEpoch(existing.updatedAt)) {
      existing.updatedAt = link.activityAt;
    }
    // LOC is an artifact-level triple; adopt it only when all fields are present
    // so partial enrichment cannot synthesize a mixed branch/PR size.
    if (!completeArtifactLoc(existing) && linkLoc) {
      existing.linesAdded = linkLoc.linesAdded;
      existing.linesRemoved = linkLoc.linesRemoved;
      existing.filesChanged = linkLoc.filesChanged;
    }
  }
  return branches;
}

/**
 * The branch's LOC for the size / value KPIs: its own FEA-1899 enrichment when
 * present, else its merged PR artifact's LOC (joined onto the PR rows by
 * `readLocalBranchPrRows`). Branch artifacts are frequently un-enriched while
 * the PR artifact carries LOC — the SAME enriched source the delivery dashboard
 * medians — so this fallback keeps Median PR size / Value-per-$ populated and
 * reconciled with the dashboard instead of reading null off the branch row
 * (FEA-2159). Extracted to keep `projectBranchListItems` under the complexity
 * budget.
 */
function resolveBranchLoc(
  branch: BranchAccumulator,
  prs: BranchPrRow[]
): {
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
} {
  const branchLoc = completeArtifactLoc(branch);
  const prLoc =
    prs.map((pr) => completeArtifactLoc(pr)).find((loc) => loc != null) ?? null;
  const loc = branchLoc ?? prLoc;

  return {
    additions: loc?.linesAdded ?? null,
    deletions: loc?.linesRemoved ?? null,
    filesChanged: loc?.filesChanged ?? null,
  };
}

function completeArtifactLoc(candidate: {
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
}): { linesAdded: number; linesRemoved: number; filesChanged: number } | null {
  if (
    candidate.linesAdded == null ||
    candidate.linesRemoved == null ||
    candidate.filesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: candidate.linesAdded,
    linesRemoved: candidate.linesRemoved,
    filesChanged: candidate.filesChanged,
  };
}

/**
 * Project the three grouped reads into canonical `BranchRow`s. Branch identity
 * is the shared `encodeBranchId` slug (also the grouping key), so the list keys,
 * `branchesKeys.detail`, and the Epic C detail route agree byte-for-byte.
 *
 * `additions` / `deletions` / `filesChanged` come from FEA-1899 branch
 * enrichment (the link read carries the branch artifact's net LOC) — `null`
 * until the branch is enriched, never 0. Owner and the remaining GitHub-only
 * columns (base ref, checks, review decision, ahead/behind) have NO local
 * producer in v1, so they still degrade to `null`.
 */
function projectBranchListItems(
  linkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>,
  prRows: BranchPrRow[],
  tokenRows: Awaited<ReturnType<typeof readBranchTokenAggregateRows>>,
  commitRows: BranchCommitRow[]
): BranchRow[] {
  const branches = groupBranchAccumulators(linkRows);

  // Latest captured commit time per branch — the primary "last active" signal
  // (PRD-486). Commit rows arrive oldest-first; track the max by parsed instant.
  const commitMaxByBranch = new Map<string, string>();
  for (const commit of commitRows) {
    const id = encodeBranchId({
      repoFullName: commit.repoFullName,
      branchName: commit.branchName,
    });
    const current = commitMaxByBranch.get(id);
    if (!current || isoEpoch(commit.committedAt) > isoEpoch(current)) {
      commitMaxByBranch.set(id, commit.committedAt);
    }
  }

  const prsByBranch = new Map<string, BranchPrRow[]>();
  for (const pr of prRows) {
    const id = encodeBranchId({
      repoFullName: pr.repoFullName,
      branchName: pr.branchName,
    });
    const list = prsByBranch.get(id) ?? [];
    list.push(pr);
    prsByBranch.set(id, list);
  }

  const tokensByBranch = new Map<string, BranchUsageRow[]>();
  for (const token of tokenRows) {
    const id = encodeBranchId({
      repoFullName: token.repoFullName,
      branchName: token.branchName,
    });
    const list = tokensByBranch.get(id) ?? [];
    list.push({
      owner: null,
      model: token.model,
      inputTokens: token.inputTokens,
      outputTokens: token.outputTokens,
      cacheReadTokens: token.cacheReadTokens,
      cacheWriteTokens: token.cacheWriteTokens,
      // List rows sum captured cost (not the billing split), so the mode is
      // irrelevant here → "unknown".
      billingMode: "unknown",
      // Even-split captured cost for this (branch, model) group — summed for the
      // per-branch cost so it matches the dashboard, not re-derived list price.
      storedCostUsd: token.costUsdEstimated,
    });
    tokensByBranch.set(id, list);
  }

  // Decorate-sort-undecorate: each row's activity epoch is parsed ONCE here while
  // building the list, then the sort compares the precomputed number. A
  // comparator that called `isoEpoch` on both operands would re-`Date.parse`
  // `lastActivityAt` ~2·N·log₂N times per fetch instead of N.
  const decorated: { row: BranchRow; sortEpoch: number }[] = [];
  for (const [id, branch] of branches) {
    // PR rows arrive newest-first (read ORDER BY observed_at DESC), so [0] is
    // the most-recently-observed PR for the branch.
    const prs = prsByBranch.get(id) ?? [];
    const latestPr = prs[0] ?? null;
    const distinctPrNumbers = new Set(
      prs
        .map((pr) => pr.prNumber)
        .filter((value): value is number => value != null)
    );
    const prState = latestPr ? derivePrState(latestPr) : null;
    const { additions, deletions, filesChanged } = resolveBranchLoc(
      branch,
      prs
    );

    // PRD-486: a branch's "last active" is its latest REAL lifecycle event — a
    // commit, or a PR opened/merged/closed — NOT session activity (which the
    // cloud already excludes per PLN-1034). Fall back to the session-derived time
    // only when a branch has no commit/PR signal yet, so commit-less branches
    // (and pre-PRD-486 imports) don't regress to epoch-0 or vanish from the sort.
    const eventActivity = maxIso([
      commitMaxByBranch.get(id),
      ...prs.flatMap((pr) => [pr.openedAt, pr.mergedAt, pr.closedAt]),
    ]);

    const lastActivityAt = eventActivity ?? branch.updatedAt;
    decorated.push({
      row: {
        id,
        branchName: branch.branchName,
        baseBranch: null,
        repoFullName: branch.repoFullName,
        owner: null,
        status: deriveStatus(prState),
        prNumber: latestPr?.prNumber ?? null,
        prTitle: latestPr?.title ?? null,
        prState,
        prUrl: latestPr?.prUrl ?? null,
        multiPrWarning: distinctPrNumbers.size > 1,
        checksStatus: null,
        checksPassed: null,
        checksTotal: null,
        reviewDecision: null,
        ahead: null,
        behind: null,
        additions,
        deletions,
        filesChanged,
        estimatedCostUsd: sumStoredBranchCost(tokensByBranch.get(id) ?? []),
        lastActivityAt,
        sessionIds: [...branch.sessionIds].sort(),
      },
      sortEpoch: isoEpoch(lastActivityAt),
    });
  }

  // Newest activity first. Sort by the parsed epoch (not raw string order) so
  // mixed timestamp formats still rank by true instant.
  decorated.sort((a, b) => b.sortEpoch - a.sortEpoch);
  return decorated.map((entry) => entry.row);
}

/**
 * Project local SQLite-backed branches into the canonical shared list response.
 * Three bounded grouped reads (links, PRs, token aggregate) — no per-branch
 * fan-out. A read failure rethrows a sanitized, code-only error so no raw SQL
 * crosses the IPC boundary (the renderer surfaces it as the list error state).
 */
export async function getSharedBranches(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesListRequest = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchListResponse> {
  if (!source) {
    return emptySharedBranchesListResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesListResponse();
  }
  try {
    // Independent grouped reads. Run SEQUENTIALLY (FEA-3056): the first joint use
    // is the projection below, but running these unbounded per-row reads
    // concurrently — doubled with the analytics handler the Branches screen fires
    // alongside this one — pins every large result set in the db-host worker heap
    // at once and OOMs it. Serializing keeps one big result set resident at a time.
    const [linkRows, prRows, tokenRows, commitRows] = await readSequentially([
      () => readLocalBranchLinkRows(source.prisma),
      () => readLocalBranchPrRows(source.prisma),
      () => readBranchTokenAggregateRows(source.prisma),
      () => readLocalBranchCommitRows(source.prisma),
    ]);
    const projected = projectBranchListItems(
      linkRows,
      prRows,
      tokenRows,
      commitRows
    );
    // Honor the requested id set, then page the output. `total` is the matched
    // count BEFORE paging (standard pagination semantics).
    const matched = selectRequestedBranches(projected, request.ids);
    const items = pageBranches(matched, request.limit, request.offset);
    return {
      items: await applyCloudHydration(items, cloudHydration, {
        forceRefresh: request.forceRefresh,
        scope: "list",
      }),
      total: matched.length,
      viewerScope: BranchViewerScope.Self,
    };
  } catch (error) {
    rethrowAsSourceError("getSharedBranches", error);
  }
}

/**
 * Price one loaded session's `tokenUsageByModel`. Prefers the STORED per-model
 * cost (`cost_usd_estimated`, surfaced as `usage.estimatedCostUsd`) — the same
 * value the Sessions surface sums (`shared-agent-sessions-api.ts`) — so a
 * session's cost matches across the Branch and Sessions views and authoritative
 * captured pricing is never silently re-derived. Falls back to the desktop
 * token-cost wrapper (genai-cost) only for models with no stored cost. Returns
 * `null` when NOTHING prices — so the per-session cost shows "—" rather than a
 * misleading 0.
 */
function priceSyncedSession(session: SyncedAgentSession): number | null {
  let total = 0;
  let anyPriced = false;
  for (const usage of session.tokenUsageByModel) {
    if (usage.estimatedCostUsd != null) {
      total += usage.estimatedCostUsd;
      anyPriced = true;
      continue;
    }
    const costInput = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      observedAt: session.startedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (estimate) {
      total += estimate.costUsd;
      anyPriced = true;
    } else {
      reportTokenCostPricingMiss(
        costInput,
        "synced_session",
        session.externalSessionId
      );
    }
  }
  return anyPriced ? total : null;
}

/** Sum a loaded session's per-model token usage into one `BranchSession` row. */
function toEnrichedBranchSession(
  session: SyncedAgentSession,
  isPrimary: boolean
): BranchSession {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const usage of session.tokenUsageByModel) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
  }
  return {
    sessionId: session.externalSessionId,
    slug: null,
    name: session.name ?? null,
    harness: session.harness ?? "",
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    isPrimary,
    estimatedCostUsd: priceSyncedSession(session),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * Project one loaded desktop session into the surface-agnostic
 * `MergedTraceSessionInput` the shared `buildMergedTrace` consumes: run the same
 * verified timeline + turn-item projectors the Sessions detail uses, then hand
 * off the identity + start + turn items. The map/merge/idle logic lives in
 * `@repo/lib/branches/merged-trace` so the desktop single-player trace and the
 * cloud org-aggregated branch trace stay a single source of truth.
 */
function toMergedTraceSessionInput(
  session: SyncedAgentSession
): MergedTraceSessionInput {
  const timeline = projectAgentSessionTimelineEvents(session.events, {
    metadata: session.metadata,
  });
  const turnItems = projectAgentSessionTurnItems({
    sessionId: session.externalSessionId,
    harness: session.harness ?? "unknown",
    primaryModel: session.model ?? null,
    humanActor: { name: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL, color: "#64748B" },
    agents: session.agents,
    events: session.events,
    timeline,
    tokenUsageByModel: session.tokenUsageByModel,
  });
  return {
    sessionId: session.externalSessionId,
    startedAt: session.startedAt,
    actorName: session.name ?? session.model ?? null,
    harness: session.harness ?? null,
    turnItems,
  };
}

/** Build the chronological cross-session `mergedTrace` for loaded sessions. */
function buildMergedTrace(sessions: SyncedAgentSession[]): MergedTraceItem[] {
  return buildSharedMergedTrace(sessions.map(toMergedTraceSessionInput));
}

/**
 * Lightweight work/idle activity summary for the lead-time waterfall (PLN-1148
 * Phase 2). Built from the captured event INSTANTS (`event.createdAt`) across the
 * branch's sessions — which survive the light (`omitEventData`) hydration, since
 * only the heavy event `data` blob is dropped — so the DEFAULT detail view can
 * chart work-vs-idle WITHOUT building the events-heavy `mergedTrace`. Idle spans
 * are the same `MERGED_TRACE_IDLE_THRESHOLD_MS` gaps the merged trace inserts; the
 * basis is every captured activity instant (a more faithful "active vs idle"
 * signal than the projected trace items, and one that needs no `data`).
 */
function buildBranchLeadTime(
  sessions: SyncedAgentSession[]
): BranchLeadTimeActivity {
  const instants: number[] = [];
  for (const session of sessions) {
    for (const event of session.events) {
      const ms = Date.parse(event.createdAt);
      if (!Number.isNaN(ms)) {
        instants.push(ms);
      }
    }
  }
  instants.sort((a, b) => a - b);
  const first = instants[0];
  const last = instants.at(-1);
  if (first === undefined || last === undefined) {
    return { firstActivityT: null, lastActivityT: null, idleSpans: [] };
  }
  const idleSpans: BranchIdleSpan[] = [];
  for (let i = 1; i < instants.length; i += 1) {
    const gapMs = instants[i] - instants[i - 1];
    if (gapMs >= MERGED_TRACE_IDLE_THRESHOLD_MS) {
      idleSpans.push({
        startT: new Date(instants[i - 1]).toISOString(),
        endT: new Date(instants[i]).toISOString(),
        gapMs,
      });
    }
  }
  return {
    firstActivityT: new Date(first).toISOString(),
    lastActivityT: new Date(last).toISOString(),
    idleSpans,
  };
}

/**
 * Closedloop slug embedded in a branch name, case-insensitive (branch names are
 * lowercase like "fea-1952-..."); the captured slug is uppercased to the
 * canonical form.
 */
const BRANCH_NAME_SLUG_RE = /\b(PRD|FEA|PLN|PRO|WRK|SES)-(\d{1,5})\b/gi;

/**
 * Derive the branch's linked artifacts from its NAME — the only reliable
 * branch→artifact signal. e.g. "fea-1952-branches-epic-f" → [{ slug: "FEA-1952" }].
 *
 * Deliberately NOT derived from `SyncedAgentSession.artifactRefs`: those are
 * incidental transcript references (a slug mentioned in prose, a Closedloop URL
 * pasted, an MCP tool call) captured by the artifact-ref extractor — aggregating
 * them across all of a branch's sessions yields a long, noisy list of artifacts
 * the branch never delivered. Deduped, order-preserving.
 */
function deriveLinkedArtifactsFromBranchName(
  branchName: string
): BranchLinkedArtifact[] {
  const seen = new Set<string>();
  const artifacts: BranchLinkedArtifact[] = [];
  for (const match of branchName.matchAll(BRANCH_NAME_SLUG_RE)) {
    const slug = `${match[1].toUpperCase()}-${match[2]}`;
    if (!seen.has(slug)) {
      seen.add(slug);
      artifacts.push({ slug });
    }
  }
  return artifacts;
}

/**
 * Build the canonical detail body for one already-projected branch row.
 *
 * The branch identity, status, PR fields, cost, and `sessionIds` come straight
 * from the shared list projection (`row`), so the detail and the list agree
 * byte-for-byte. The detail-only fields are filled from the branch's own PR/link
 * rows and the loaded sessions:
 * - `linkedPrNumbers` / `mergedAt` / `closedAt` are real (from `pull_requests`).
 * - `sessions`: when the session loader hydrated a linked session, it carries
 *   the real name/harness/started/ended + per-session token splits and priced
 *   cost (D1). A session that did NOT hydrate degrades to the minimal link-row
 *   spine (real `sessionId` + `isPrimary` + observed time, null/0 usage) rather
 *   than being dropped.
 * - `mergedTrace`: the chronological cross-session trace built from the loaded
 *   sessions' turn items (empty when no session hydrated).
 * - `prBody` / `prBodyHtmlUrl` / `headSha` / `mergeCommitSha` have no v1 local
 *   producer (Epic F enrichment) → null. `additions`/`deletions`/`filesChanged`
 *   are inherited from `row` — now populated from FEA-1899 branch enrichment
 *   when available, else null.
 */
function projectBranchDetail(
  row: BranchRow,
  branchPrs: BranchPrRow[],
  branchLinks: BranchLinkRow[],
  branchCommits: BranchCommitRow[],
  loadedSessions: SyncedAgentSession[]
): BranchPageDetail {
  // PR rows arrive newest-first (read ORDER BY observed_at DESC), so [0] is the
  // displayed PR — the same one the list projection picked.
  const latestPr = branchPrs[0] ?? null;
  const linkedPrNumbers = [
    ...new Set(
      branchPrs
        .map((pr) => pr.prNumber)
        .filter((value): value is number => value != null)
    ),
  ];

  // One link row per session (a session may be linked more than once); prefer a
  // primary link, else keep the first seen.
  const linkBySession = new Map<string, BranchLinkRow>();
  for (const link of branchLinks) {
    const existing = linkBySession.get(link.sessionId);
    if (!existing || (link.isPrimary && !existing.isPrimary)) {
      linkBySession.set(link.sessionId, link);
    }
  }
  const loadedById = new Map(
    loadedSessions.map((session) => [session.externalSessionId, session])
  );
  const sessions: BranchSession[] = row.sessionIds.map((sessionId) => {
    const link = linkBySession.get(sessionId);
    const isPrimary = link?.isPrimary ?? false;
    const loaded = loadedById.get(sessionId);
    if (loaded) {
      return toEnrichedBranchSession(loaded, isPrimary);
    }
    // Session did not hydrate (not in the local store, or load returned a
    // subset): keep the honest link-row spine, never a fabricated zero-cost.
    return {
      sessionId,
      slug: null,
      name: null,
      harness: "",
      startedAt: link?.observedAt ?? row.lastActivityAt,
      endedAt: null,
      isPrimary,
      estimatedCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  });

  // PLN-1148 Phase 2: the detail no longer builds the events-heavy mergedTrace —
  // it light-hydrates (`omitEventData`), so the heavy `data` blobs are never
  // loaded here. The trace is fetched lazily via `getSharedBranchTrace` when the
  // Sessions & timeline tab opens; the default view's only trace need (the
  // lead-time waterfall) is served by the lightweight `leadTime` summary below.
  // `buildBranchLeadTime` is guarded so a projection failure degrades to an empty
  // summary instead of 500-ing the whole detail (matching the loader's contract).
  let leadTime: BranchLeadTimeActivity;
  try {
    leadTime = buildBranchLeadTime(loadedSessions);
  } catch {
    leadTime = { firstActivityT: null, lastActivityT: null, idleSpans: [] };
  }

  return {
    ...row,
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: latestPr?.mergedAt ?? null,
    closedAt: latestPr?.closedAt ?? null,
    // PRD-486: PR-opened time + the per-commit dots for the activity rail. Commits
    // are ordered oldest-first by their real commit time (already ASC from the
    // read; sorted defensively in case the narrowing reorders).
    openedAt: latestPr?.openedAt ?? null,
    commits: branchCommits
      .map((commit) => ({
        sha: commit.sha,
        committedAt: commit.committedAt,
        message: commit.message ?? "",
      }))
      .sort((a, b) => isoEpoch(a.committedAt) - isoEpoch(b.committedAt)),
    sessions,
    // Deferred to the lazy trace fetch (PLN-1148 Phase 2) — never shipped here.
    mergedTrace: [],
    leadTime,
    linkedPrNumbers,
    linkedArtifacts: deriveLinkedArtifactsFromBranchName(row.branchName),
  };
}

/**
 * Hydrate the branch's contributing sessions (real per-session token splits/cost
 * + the merged-trace source) via the optional agent-session loader. A source
 * without `syncSource`, an empty session set, or a load failure degrades to `[]`
 * so the detail still renders from the Prisma branch-reads projection (the
 * per-session usage falls back to the link-row spine and the trace to empty).
 */
async function loadBranchSessions(
  source: BranchSyncSource,
  sessionIds: readonly string[],
  options?: { omitEventData?: boolean }
): Promise<SyncedAgentSession[]> {
  if (!source.syncSource || sessionIds.length === 0) {
    return [];
  }
  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  try {
    return await source.syncSource.loadSyncedSessions(
      [...sessionIds],
      cache,
      options
    );
  } catch {
    // The trace/usage enrichment is best-effort; a loader failure must not 500
    // the whole detail when the Prisma branch-reads projection already succeeded.
    return [];
  }
}

/**
 * PLN-1148 Phase 0: per-stage timing for the branch detail read, emitted ONLY in
 * verbose mode — `gatewayLog.debug` skips its message factory entirely when
 * verbose is off, so this is zero-cost in normal runs. Lets a large-corpus
 * profile attribute the load to the scoped reads vs the session/trace hydration
 * without attaching a debugger. Enable via the gateway logger's verbose toggle.
 */
function startBranchDetailPerf(id: string): {
  mark: (label: string, count?: number) => void;
  done: (outcome: string, counts?: Record<string, number>) => void;
} {
  const t0 = performance.now();
  let last = t0;
  const stages: string[] = [];
  return {
    mark(label, count) {
      const now = performance.now();
      const ms = (now - last).toFixed(1);
      stages.push(
        count == null ? `${label}=${ms}ms` : `${label}=${ms}ms(${count})`
      );
      last = now;
    },
    done(outcome, counts) {
      const total = (performance.now() - t0).toFixed(1);
      gatewayLog.debug("branches-perf", () => {
        const tail = counts
          ? ` ${Object.entries(counts)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}`
          : "";
        return `detail ${outcome} id=${id} total=${total}ms ${stages.join(" ")}${tail}`;
      });
    },
  };
}

/**
 * Project one local branch into the canonical detail response. Reuses the list
 * projection for branch identity (so `id` round-trips with the list keys and the
 * Epic C detail route), hydrates the contributing sessions for per-session usage
 * + the cross-session merged trace, then fills the body via `projectBranchDetail`.
 * Returns `null` — translated to a typed 404 at the IPC boundary — for a missing
 * source, a non-string/empty id, or an id that matches no local branch.
 *
 * PLN-1148 Phase 1: reads are scoped to the requested `(repoFullName, branchName)`
 * via `decodeBranchId` rather than reading the whole corpus and filtering in JS,
 * so the detail's cost scales with the opened branch, not the total local
 * history. Links are read first — they establish the branch exists (a branch IS
 * its set of session links) and give the session-id set the commit read scopes
 * on — so an unknown id 404s after one tiny indexed query.
 */
export async function getSharedBranchDetail(
  source: BranchSyncSource | null | undefined,
  id: unknown,
  cloudHydration?: BranchCloudHydrationSource,
  options: { forceRefresh?: boolean } = {}
): Promise<BranchPageDetail | null> {
  if (!source) {
    return null;
  }
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  // The branch identity the scoped reads filter on — the exact inverse of the
  // list's `encodeBranchId`, so the detail reads the SAME branch the id names.
  const key = decodeBranchId(id);
  const perf = startBranchDetailPerf(id);
  try {
    const linkRows = await readLocalBranchLinkRowsForBranch(source.prisma, key);
    perf.mark("links", linkRows.length);
    if (linkRows.length === 0) {
      perf.done("not-found");
      return null;
    }
    const sessionIds = [...new Set(linkRows.map((link) => link.sessionId))];
    // The remaining branch-scoped reads are independent — run them together.
    const [prRows, tokenRows, commitRows] = await Promise.all([
      readLocalBranchPrRowsForBranch(source.prisma, key),
      readBranchTokenAggregateRowsForBranch(source.prisma, key),
      readBranchCommitRowsForSessions(source.prisma, sessionIds, key),
    ]);
    perf.mark("reads");
    // The reads are already scoped to this branch, so the list projection yields
    // exactly this branch's row — no cross-branch `encodeBranchId` filter needed.
    const row = projectBranchListItems(
      linkRows,
      prRows,
      tokenRows,
      commitRows
    ).find((item) => item.id === id);
    if (!row) {
      perf.done("not-found");
      return null;
    }
    // PLN-1148 Phase 2: LIGHT hydration — `omitEventData: true` drops the heavy
    // event `data` blobs (the dominant load term), keeping only what the sessions
    // list (token/cost/name/harness) and the lead-time summary (event instants)
    // need. The events-heavy `mergedTrace` is built lazily by `getSharedBranchTrace`
    // when the Sessions & timeline tab opens.
    const loadedSessions = await loadBranchSessions(source, row.sessionIds, {
      omitEventData: true,
    });
    perf.mark("sessions", loadedSessions.length);
    const detail = projectBranchDetail(
      row,
      prRows,
      linkRows,
      commitRows,
      loadedSessions
    );
    perf.done("ok", {
      sessions: detail.sessions.length,
      idleSpans: detail.leadTime.idleSpans.length,
    });
    const [hydrated] = await applyCloudHydration([detail], cloudHydration, {
      forceRefresh: options.forceRefresh,
      scope: "detail",
    });
    return hydrated ?? detail;
  } catch (error) {
    perf.done("error");
    rethrowAsSourceError("getSharedBranchDetail", error);
  }
}

async function applyCloudHydration<T extends BranchRow>(
  rows: T[],
  cloudHydration: BranchCloudHydrationSource | undefined,
  options: { forceRefresh?: boolean; scope: "list" | "detail" }
): Promise<T[]> {
  if (!cloudHydration || rows.length === 0) {
    return rows;
  }
  const result = await cloudHydration.hydrate({
    rows,
    forceRefresh: options.forceRefresh,
    scope: options.scope,
  });
  return rows.map((row) =>
    applyCloudHydrationResult(
      row,
      result.status,
      result.failure,
      result.overlays
    )
  );
}

function applyCloudHydrationResult<T extends BranchRow>(
  row: T,
  status: BranchCloudHydrationStatus,
  failure: string | undefined,
  overlays: DesktopCloudGitHubHydrationResult["overlays"] | undefined
): T {
  const overlay = overlayForRow(row, overlays);
  return {
    ...row,
    ...overlay,
    cloudHydrationStatus: status,
    ...(failure === undefined ? {} : { cloudHydrationFailure: failure }),
  };
}

function overlayForRow(
  row: BranchRow,
  overlays: DesktopCloudGitHubHydrationResult["overlays"] | undefined
): Partial<BranchRow> {
  if (!row.repoFullName || row.multiPrWarning || !overlays) {
    return {};
  }
  const overlay = overlays[`${row.repoFullName}::${row.branchName}`];
  if (!overlay) {
    return {};
  }
  return overlay;
}

/**
 * The branch's events-heavy cross-session merged trace (PLN-1148 Phase 2),
 * fetched lazily by the Sessions & timeline tab — split out of
 * `getSharedBranchDetail` so the DEFAULT branch-detail view never loads the
 * multi-KB event `data` blobs the trace projection needs. Reuses the same scoped
 * link read for branch identity + the session set, then FULL-hydrates those
 * sessions (`omitEventData` off) and builds the trace.
 *
 * Best-effort like the in-detail trace it replaces: a missing source, an unknown
 * id, or any read/projection failure degrades to an empty trace rather than
 * throwing, so the tab renders an empty timeline instead of erroring.
 */
export async function getSharedBranchTrace(
  source: BranchSyncSource | null | undefined,
  id: unknown
): Promise<MergedTraceItem[]> {
  if (!source) {
    return [];
  }
  if (typeof id !== "string" || id.length === 0) {
    return [];
  }
  const key = decodeBranchId(id);
  try {
    const linkRows = await readLocalBranchLinkRowsForBranch(source.prisma, key);
    if (linkRows.length === 0) {
      return [];
    }
    const sessionIds = [...new Set(linkRows.map((link) => link.sessionId))];
    // FULL hydration (omitEventData off) — the trace projection needs event data.
    const loadedSessions = await loadBranchSessions(source, sessionIds);
    return buildMergedTrace(loadedSessions);
  } catch {
    return [];
  }
}

/**
 * Map one deduped per-`(session, model)` usage read row onto a priceable
 * `BranchUsageRow`. Shared by the usage summary AND the analytics spend KPIs so
 * both price the SAME deduped rows the SAME way — this is what makes the branches
 * "AI spend" reconcile with `totalEstimatedCost` (and the agent dashboard) rather
 * than diverge via the per-branch attribution sum.
 */
function branchUsageRowFromTokenRow(
  row: Awaited<ReturnType<typeof readBranchUsageTokenRows>>[number]
): BranchUsageRow {
  return {
    owner: null,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    billingMode: normalizeBillingMode(row.billingMode),
    timestamp: row.createdAt ? new Date(row.createdAt) : undefined,
    storedCostUsd: row.costUsdEstimated,
  };
}

/**
 * Aggregate local branches into the canonical usage summary. Rolls up one token
 * row per `(session, model)` for branch-linked sessions (counted once) and hands
 * them to A3's `projectBranchUsageSummary`. Owner has no v1 producer, so
 * `byActor` collapses to a single unattributed bucket; phase is unset, so
 * `phaseStacks` is empty; billing split follows whatever `billing_mode` the
 * local sessions carry (0 when unset).
 */
export async function getSharedBranchUsage(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {}
): Promise<BranchUsageSummary> {
  if (!source) {
    return emptySharedBranchesUsageSummary();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesUsageSummary();
  }
  try {
    // Project the branch list (links + PRs + commits) alongside the usage reads
    // so the rollup can be scoped to the branches active in the requested window
    // (FEA-2155) — the SAME `lastActivityAt` axis the table windows on. Commits
    // are read and threaded in because PRD-486 makes the latest commit the
    // PRIMARY last-active signal: the list op (`getSharedBranches`) computes
    // `lastActivityAt = maxIso([commitMax, ...prTimes]) ?? updatedAt`, so omitting
    // commits here would window on a commit-blind timestamp and the cards would
    // NOT reconcile with the table for any commit-aged branch. The distinct-branch
    // COUNT also falls out of the windowed projection, so the separate
    // `readDistinctBranchKeyRows` is no longer needed: one item per distinct
    // `encodeBranchId` == the old DISTINCT key count for the all-time window.
    // FEA-3056: run SEQUENTIALLY, not `Promise.all`. Same OOM guard as the list +
    // analytics handlers — these unbounded per-row reads must not all be resident
    // in the db-host worker heap at once. Serializing caps peak heap at one big
    // result set; output is identical (same reads, same rows, same order).
    const [tokenRows, eventRows, linkRows, prRows, commitRows] =
      await readSequentially([
        () => readBranchUsageTokenRows(source.prisma),
        () => readBranchUsageEventRows(source.prisma),
        () => readLocalBranchLinkRows(source.prisma),
        () => readLocalBranchPrRows(source.prisma),
        () => readLocalBranchCommitRows(source.prisma),
      ]);
    // No usage KPI surfaces per-branch cost, so the per-branch token aggregate is
    // skipped (pass [] for tokens); branch identity + the commit-inclusive
    // `lastActivityAt` are what the window keys on.
    const windowed = filterBranchItemsByWindow(
      projectBranchListItems(linkRows, prRows, [], commitRows),
      request
    );
    const windowedSessionIds = collectSessionIds(windowed);
    const branchCount = windowed.length;
    // Totals/cost/billing-split from the complete per-(session,model) aggregate
    // (its created_at is the pricing-time proxy); hour buckets from per-event
    // rows so a multi-hour session isn't collapsed onto one aggregate timestamp.
    // Both are restricted to the windowed branches' sessions so the rollup
    // reconciles with the windowed table + summary cards.
    const rows = tokenRows
      .filter((row) => windowedSessionIds.has(row.sessionId))
      .map(branchUsageRowFromTokenRow);
    const hourRows = eventRows
      .filter((row) => windowedSessionIds.has(row.sessionId))
      .map(branchUsageRowFromTokenRow);
    return projectBranchUsage(rows, branchCount, hourRows);
  } catch (error) {
    rethrowAsSourceError("getSharedBranchUsage", error);
  }
}

/**
 * Aggregate local branches into the canonical analytics response (B6). Merge
 * rate, total AI spend, active-branch count (and, once enriched, median PR size
 * + LOC/$) are computed locally from the same branch projection the list uses;
 * GitHub-only KPIs are gated. A read failure rethrows a sanitized, code-only
 * error.
 */
export async function getSharedBranchAnalytics(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchAnalytics> {
  if (!source) {
    return emptySharedBranchesAnalytics();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesAnalytics();
  }
  try {
    // Links + PRs run concurrently; the usage-token read then reuses the session
    // ids already in `linkRows` rather than re-querying session_artifact_links.
    // Spend is the DEDUPED per-session usage (one row per (session, model)), NOT
    // the per-branch token AGGREGATE: that aggregate attributes a shared session's
    // full cost to every branch it touched, so summing it inflates AI spend (a
    // session on N branches counted N times). Pricing the deduped rows once
    // reconciles this card with the usage summary + agent dashboard.
    // Links + PRs + commits run concurrently. Commits (PRD-486) are read because
    // the window keys on `lastActivityAt`, whose PRIMARY signal is the latest
    // commit — the list op the table renders computes
    // `maxIso([commitMax, ...prTimes]) ?? updatedAt`, so windowing on a
    // commit-blind timestamp would mis-window any commit-aged branch and break the
    // card↔table reconciliation this change exists to fix. No KPI reads commit
    // times directly; they only place each branch on the window axis.
    // FEA-3056: run SEQUENTIALLY, not `Promise.all`. This handler fires together
    // with the list handler on Branches load; running these unbounded per-row
    // reads concurrently across both handlers pins every large result set in the
    // db-host worker heap simultaneously and OOMs it. Serializing caps peak heap
    // at one big result set. The token read already followed these; it now joins
    // the same sequence so it is never resident alongside the link/PR/commit rows.
    const [linkRows, prRows, commitRows, usageTokenRows] =
      await readSequentially([
        () => readLocalBranchLinkRows(source.prisma),
        () => readLocalBranchPrRows(source.prisma),
        () => readLocalBranchCommitRows(source.prisma),
        // FEA-2260: resolves branch-linked sessions via a SQL subquery JOIN
        // rather than accepting session IDs as parameters — avoids SQLite's
        // 999-parameter limit.
        () => readBranchAnalyticsTokenRows(source.prisma),
      ]);
    // No analytics KPI surfaces per-branch cost (spend comes from the deduped read
    // above), so the per-branch token aggregate is skipped — pass [] for tokens.
    // `estimatedCostUsd` on these items stays null and is never read; merge rate /
    // median PR size / active count / the LOC numerator all derive from links +
    // PRs, not cost. Hydrate before windowing: cloud overlays can supply a newer
    // `lastActivityAt` and PR LOC, and analytics must use the same hydrated rows
    // the table filters/renders.
    const hydratedItems = await applyCloudHydration(
      projectBranchListItems(linkRows, prRows, [], commitRows),
      cloudHydration,
      {
        scope: "list",
      }
    );
    // Window to the branches active in the requested range (FEA-2155), keyed on
    // the SAME hydrated, commit-inclusive `lastActivityAt` instant the table
    // windows on, so every KPI reconciles with the window-filtered table.
    const windowed = filterBranchItemsByWindow(hydratedItems, request);
    const windowedSessionIds = collectSessionIds(windowed);
    // Restrict spend to the windowed branches' sessions so AI spend reflects the
    // same set of branches the count KPIs do. (Reusing the already-fetched rows —
    // no extra read — keeps the single session_artifact_links query intact.)
    const windowedUsageRows = usageTokenRows.filter((row) =>
      windowedSessionIds.has(row.sessionId)
    );

    // Headline AI spend: CAPTURED cost of every windowed branch-linked session,
    // counted ONCE. Stored cost (not re-derived list price) so it reconciles with
    // the dashboard; un-priced rows (subscription / un-costed models) count as $0.
    const totalSpendUsd = sumStoredBranchCost(
      windowedUsageRows.map(branchUsageRowFromTokenRow)
    );
    // LOC-per-$ denominator: captured cost EVEN-SPLIT-attributed to the
    // LOC-enriched branches. A session is apportioned across the branches it
    // touched and only its enriched-branch share counts — so a session that
    // also worked un-enriched branches doesn't drag spend with no LOC to offset
    // it into the ratio (which deflates LOC/$). The numerator (net LOC) is
    // summed over the SAME enriched branches in `projectBranchAnalytics`.
    const locEnrichedSpendUsd = sumLocEnrichedSpend(
      windowed,
      windowedUsageRows
    );
    return projectBranchAnalytics(windowed, {
      totalSpendUsd,
      locEnrichedSpendUsd,
    });
  } catch (error) {
    rethrowAsSourceError("getSharedBranchAnalytics", error);
  }
}
