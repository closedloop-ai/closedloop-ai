import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import type { TurnItem } from "@repo/api/src/types/agent-session";
import {
  type BranchAnalytics,
  type BranchLinkedArtifact,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchPrState,
  type BranchRow,
  type BranchSession,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
  encodeBranchId,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
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
  readBranchTokenAggregateRows,
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
  readBranchUsageTokenRowsForSessions,
  readDistinctBranchKeyRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchPrRows,
} from "./database/branch-reads.js";
import type { SqliteAgentDatabase } from "./database/sqlite.js";
import { reportTokenCostPricingMiss } from "./token-cost-pricing-miss.js";

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
export type BranchSyncSource = Pick<SqliteAgentDatabase, "prisma"> &
  Partial<Pick<SqliteAgentDatabase, "syncSource">>;

/**
 * Cloud-only filters have no meaning for the local (self-scoped) source — mirror
 * the agent-sessions fail-closed: a present cloud filter yields the empty
 * canonical response rather than silently ignoring the constraint.
 *
 * DEFERRAL (v1): the SUPPORTED local filters (owner / repo / status / search /
 * startDate / endDate) are intentionally NOT applied inside these serving ops.
 * The renderer applies them client-side over the full local corpus for the LIST
 * (`useBranchFilterState`), matching the plan's local-corpus model; usage and
 * analytics are computed corpus-wide on purpose (the KPI cards + by-person chart
 * are a global summary, not a filtered slice). Server-side local filtering lands
 * with the authed REST source. Documented here so callers aren't misled into
 * expecting a filtered result from these functions.
 */
function hasUnsupportedCloudFilter(request: SharedBranchesQuery): boolean {
  return Boolean(request.userId || request.teamId || request.projectId);
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
    const existing = branches.get(id);
    if (!existing) {
      branches.set(id, {
        repoFullName: link.repoFullName,
        branchName: link.branchName,
        sessionIds: new Set([link.sessionId]),
        updatedAt: link.activityAt,
        linesAdded: link.linesAdded,
        linesRemoved: link.linesRemoved,
        filesChanged: link.filesChanged,
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
    // LOC lives on the one branch artifact, so it's identical across this
    // branch's links; adopt it only if an earlier row hadn't carried it yet.
    if (existing.linesAdded == null && link.linesAdded != null) {
      existing.linesAdded = link.linesAdded;
      existing.linesRemoved = link.linesRemoved;
      existing.filesChanged = link.filesChanged;
    }
  }
  return branches;
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

  const items: BranchRow[] = [];
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

    // PRD-486: a branch's "last active" is its latest REAL lifecycle event — a
    // commit, or a PR opened/merged/closed — NOT session activity (which the
    // cloud already excludes per PLN-1034). Fall back to the session-derived time
    // only when a branch has no commit/PR signal yet, so commit-less branches
    // (and pre-PRD-486 imports) don't regress to epoch-0 or vanish from the sort.
    const eventActivity = maxIso([
      commitMaxByBranch.get(id),
      ...prs.flatMap((pr) => [pr.openedAt, pr.mergedAt, pr.closedAt]),
    ]);

    items.push({
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
      additions: branch.linesAdded,
      deletions: branch.linesRemoved,
      filesChanged: branch.filesChanged,
      estimatedCostUsd: sumStoredBranchCost(tokensByBranch.get(id) ?? []),
      lastActivityAt: eventActivity ?? branch.updatedAt,
      sessionIds: [...branch.sessionIds].sort(),
    });
  }

  // Newest activity first. Sort by parsed epoch (not raw string order) so mixed
  // timestamp formats still rank by true instant.
  items.sort((a, b) => isoEpoch(b.lastActivityAt) - isoEpoch(a.lastActivityAt));
  return items;
}

/**
 * Project local SQLite-backed branches into the canonical shared list response.
 * Three bounded grouped reads (links, PRs, token aggregate) — no per-branch
 * fan-out. A read failure rethrows a sanitized, code-only error so no raw SQL
 * crosses the IPC boundary (the renderer surfaces it as the list error state).
 */
export async function getSharedBranches(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesListRequest = {}
): Promise<BranchListResponse> {
  if (!source) {
    return emptySharedBranchesListResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesListResponse();
  }
  try {
    // Independent grouped reads — run concurrently (first joint use is the
    // projection below), so the list pays one read latency, not three.
    const [linkRows, prRows, tokenRows, commitRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readBranchTokenAggregateRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
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
    return {
      items: pageBranches(matched, request.limit, request.offset),
      total: matched.length,
      viewerScope: BranchViewerScope.Self,
    };
  } catch {
    throw new Error(SHARED_BRANCHES_SOURCE_ERROR_CODE);
  }
}

/**
 * A gap between consecutive trace items >= this is a synthesized idle marker.
 * SSOT pair: keep in sync with `DEFAULT_IDLE_THRESHOLD_MS` in
 * `packages/app/branches/lib/branch-derivations.ts` — the renderer re-derives
 * idle spans from the same trace and must use the same threshold.
 */
const MERGED_TRACE_IDLE_THRESHOLD_MS = 120_000;

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

/** Parse a subagent cost label (e.g. "$0.42") into a number, else null. */
function parseSubagentCostUsd(value: string | null): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map a Sessions-detail `TurnItem` onto the contract `MergedTraceItem`, tagging
 * its `sessionId`. The detail projection (`projectAgentSessionTurnItems`) only
 * ever emits `prompt`/`say`/`tools`/`subagent`/`event` — the per-session
 * `sessionstart` and the gap `idle` markers are SYNTHESIZED by the merged builder
 * below (the projection carries neither), so those fall through to `null` here.
 */
function mapTurnItemToTrace(
  item: TurnItem,
  sessionId: string
): MergedTraceItem | null {
  switch (item.type) {
    case "prompt":
    case "say":
      return {
        type: item.type,
        sessionId,
        t: item.t,
        tMs: item.tMs,
        cumCostUsd: item.cum,
        actorName: item.actor.name,
        text: item.text,
      };
    case "tools":
      return {
        type: "tools",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        endMs: item.endMs,
        summary: item.summary,
        hasFail: item.hasFail,
        failN: item.failN,
        // Carry the per-tool rows so the branch trace's tool cards expand with
        // the same detail the session-detail trace shows.
        items: item.items,
      };
    case "subagent":
      return {
        type: "subagent",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        sub: item.sub,
        model: item.model,
        costUsd: parseSubagentCostUsd(item.cost),
      };
    case "event":
      return {
        type: "event",
        sessionId,
        t: item.t,
        dot: item.dot,
        text: item.text,
        tag: item.tag,
      };
    case "end":
      return { type: "end", sessionId, text: item.text };
    default:
      // `sessionstart` (synthesized per session) and `idle` (synthesized from
      // real gaps) are handled by the merged builder, not mapped 1:1.
      return null;
  }
}

/** Project one loaded session into its stamped `MergedTraceItem`s (+ end tail). */
function collectSessionTraceItems(session: SyncedAgentSession): {
  stamped: { ms: number; item: MergedTraceItem }[];
  tail: MergedTraceItem[];
} {
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
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];

  // Synthesize exactly one session-boundary marker at the session's start. The
  // detail projection never emits one, and the richer `isResumed`/`machine`
  // signals have no v1 producer — they stay undefined until Epic E captures them
  // (the contract union already carries the optional fields).
  const startMs = Date.parse(session.startedAt);
  if (!Number.isNaN(startMs)) {
    stamped.push({
      ms: startMs,
      item: {
        type: "sessionstart",
        sessionId: session.externalSessionId,
        t: session.startedAt,
        actor: {
          name: session.name ?? session.model ?? null,
          harness: session.harness ?? null,
        },
      },
    });
  }

  for (const turn of turnItems) {
    const mapped = mapTurnItemToTrace(turn, session.externalSessionId);
    if (!mapped) {
      continue;
    }
    if (mapped.type === "end") {
      tail.push(mapped);
      continue;
    }
    const ms = Date.parse(mapped.t);
    if (Number.isNaN(ms)) {
      continue;
    }
    stamped.push({ ms, item: mapped });
  }
  return { stamped, tail };
}

/**
 * Build the chronological cross-session `mergedTrace`: project each session's
 * turn items, k-way merge-sort all stamped items by timestamp, and synthesize an
 * `idle` marker wherever consecutive items gap by >= the idle threshold. Each
 * session contributes exactly one `sessionstart` (carrying the richer
 * `isResumed`/`machine` actor fields E4 needs). `end` markers (which carry no
 * timestamp) trail the stream.
 */
function buildMergedTrace(sessions: SyncedAgentSession[]): MergedTraceItem[] {
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];
  for (const session of sessions) {
    const collected = collectSessionTraceItems(session);
    stamped.push(...collected.stamped);
    tail.push(...collected.tail);
  }
  stamped.sort((a, b) => a.ms - b.ms);

  const merged: MergedTraceItem[] = [];
  for (let i = 0; i < stamped.length; i += 1) {
    const current = stamped[i];
    if (i > 0) {
      const previous = stamped[i - 1];
      const gapMs = current.ms - previous.ms;
      if (gapMs >= MERGED_TRACE_IDLE_THRESHOLD_MS) {
        merged.push({
          type: "idle",
          sessionId: current.item.sessionId,
          t: new Date(previous.ms).toISOString(),
          gapMs,
        });
      }
    }
    merged.push(current.item);
  }
  merged.push(...tail);
  return merged;
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

  // buildMergedTrace runs OUTSIDE loadBranchSessions' degrade boundary, so guard
  // it here: a projection failure degrades to an empty trace (matching the
  // loader's best-effort contract) instead of 500-ing the whole detail.
  let mergedTrace: MergedTraceItem[] = [];
  try {
    mergedTrace = buildMergedTrace(loadedSessions);
  } catch {
    mergedTrace = [];
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
    mergedTrace,
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
  sessionIds: readonly string[]
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
    return await source.syncSource.loadSyncedSessions([...sessionIds], cache);
  } catch {
    // The trace/usage enrichment is best-effort; a loader failure must not 500
    // the whole detail when the Prisma branch-reads projection already succeeded.
    return [];
  }
}

/**
 * Project one local branch into the canonical detail response. Reuses the list
 * projection for branch identity (so `id` round-trips with the list keys and the
 * Epic C detail route), hydrates the contributing sessions for per-session usage
 * + the cross-session merged trace, then fills the body via `projectBranchDetail`.
 * Returns `null` — translated to a typed 404 at the IPC boundary — for a missing
 * source, a non-string/empty id, or an id that matches no local branch.
 */
export async function getSharedBranchDetail(
  source: BranchSyncSource | null | undefined,
  id: unknown
): Promise<BranchPageDetail | null> {
  if (!source) {
    return null;
  }
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  try {
    const [linkRows, prRows, tokenRows, commitRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readBranchTokenAggregateRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
    ]);
    const row = projectBranchListItems(
      linkRows,
      prRows,
      tokenRows,
      commitRows
    ).find((item) => item.id === id);
    if (!row) {
      return null;
    }
    // Narrow the grouped reads to this branch via the same identity the list
    // keys on, so the detail can never mis-attribute another branch's PRs/links.
    const matchesId = (parts: {
      repoFullName: string | null;
      branchName: string;
    }) => encodeBranchId(parts) === id;
    const branchPrs = prRows.filter((pr) => matchesId(pr));
    const branchLinks = linkRows.filter((link) => matchesId(link));
    const branchCommits = commitRows.filter((commit) => matchesId(commit));
    const loadedSessions = await loadBranchSessions(source, row.sessionIds);
    return projectBranchDetail(
      row,
      branchPrs,
      branchLinks,
      branchCommits,
      loadedSessions
    );
  } catch {
    throw new Error(SHARED_BRANCHES_SOURCE_ERROR_CODE);
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
    const [tokenRows, eventRows, branchKeys] = await Promise.all([
      readBranchUsageTokenRows(source.prisma),
      readBranchUsageEventRows(source.prisma),
      readDistinctBranchKeyRows(source.prisma),
    ]);
    const branchCount = new Set(branchKeys.map((key) => encodeBranchId(key)))
      .size;
    // Totals/cost/billing-split from the complete per-(session,model) aggregate
    // (its created_at is the pricing-time proxy); hour buckets from per-event
    // rows so a multi-hour session isn't collapsed onto one aggregate timestamp.
    const rows = tokenRows.map(branchUsageRowFromTokenRow);
    const hourRows = eventRows.map(branchUsageRowFromTokenRow);
    return projectBranchUsage(rows, branchCount, hourRows);
  } catch {
    throw new Error(SHARED_BRANCHES_SOURCE_ERROR_CODE);
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
  request: SharedBranchesQuery = {}
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
    const [linkRows, prRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
    ]);
    // The branch-linked session ids are already in `linkRows`, so hand them to the
    // usage-token read instead of letting it re-query session_artifact_links (the
    // full `readBranchUsageTokenRows` also resolves billing mode, which analytics
    // doesn't use). Collapses this path from 4 DB round-trips to 3.
    const usageTokenRows = await readBranchUsageTokenRowsForSessions(
      source.prisma,
      linkRows.map((row) => row.sessionId)
    );
    // No analytics KPI surfaces per-branch cost (spend comes from the deduped read
    // above), so the per-branch token aggregate AND the commit read (PRD-486) are
    // both skipped — pass [] for tokens and commits. `estimatedCostUsd` on these
    // items stays null and is never read; merge rate / median PR size / active
    // count / the LOC numerator all derive from links + PRs, not cost.
    const items = projectBranchListItems(linkRows, prRows, [], []);

    // Headline AI spend: CAPTURED cost of every branch-linked session, counted
    // ONCE. Stored cost (not re-derived list price) so it reconciles with the
    // dashboard; un-priced rows (subscription / un-costed models) count as $0.
    const totalSpendUsd = sumStoredBranchCost(
      usageTokenRows.map(branchUsageRowFromTokenRow)
    );
    // LOC-per-$ denominator: captured cost EVEN-SPLIT-attributed to the
    // LOC-enriched branches. A session is apportioned across the branches it
    // touched and only its enriched-branch share counts — so a session that
    // also worked un-enriched branches doesn't drag spend with no LOC to offset
    // it into the ratio (which deflates LOC/$). The numerator (net LOC) is
    // summed over the SAME enriched branches in `projectBranchAnalytics`.
    const locEnrichedSpendUsd = sumLocEnrichedSpend(items, usageTokenRows);
    return projectBranchAnalytics(items, {
      totalSpendUsd,
      locEnrichedSpendUsd,
    });
  } catch {
    throw new Error(SHARED_BRANCHES_SOURCE_ERROR_CODE);
  }
}
