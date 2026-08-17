import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  isLocEnriched,
  sumEvenSplitEnrichedSpend,
} from "@repo/lib/branches/loc-per-dollar";

/**
 * Per-branch cost attribution helpers (FEA-3576 / FEA-2276 / FEA-4331), split out
 * of `branch-read-service.ts` so the cost-split concern lives in its own co-located
 * module instead of growing the grandfathered service. These are pure functions
 * over the service's usage/detail shapes — no database access — imported back by
 * the list, detail, and refresh read paths.
 *
 * The single shared invariant: a session touching N branches contributes only its
 * 1/N share to each branch, so the per-branch costs across a session sum back to
 * the session's captured cost ONCE — never the full-replication a shared session's
 * whole cost added to every branch it links to would produce. The even-split
 * divisor is always the session's GLOBAL active-write branch count, so the list
 * row, the detail header, and the per-session timeline bars all reconcile.
 */

/** The distinct-session cost view a branch's usage exposes to these helpers. */
type BranchSessionCostUsage = {
  estimatedCostUsd: number;
  sessionIds: string[];
  sessions: BranchPageDetail["sessions"];
};

/**
 * The session's global active-write branch count used as the even-split divisor,
 * floored at 1 so a missing/zero count never divides a cost by zero and a session
 * on a single branch keeps its full cost.
 */
function sessionBranchCount(
  branchCounts: ReadonlyMap<string, number>,
  sessionId: string
): number {
  return Math.max(1, branchCounts.get(sessionId) ?? 1);
}

/**
 * Distinct captured cost per session id — a session repeats across its branch
 * links, so its cost must be counted ONCE. Prefers a priced (`!== null`) value
 * over a null placeholder for the same session id. Shared by both even-split cost
 * paths (`evenSplitBranchCost` and the LOC-enriched spend rollup).
 */
function distinctSessionCosts(
  sessions: Iterable<BranchPageDetail["sessions"][number]>
): Map<string, number> {
  const costBySession = new Map<string, number>();
  for (const session of sessions) {
    if (
      !costBySession.has(session.sessionId) ||
      session.estimatedCostUsd !== null
    ) {
      costBySession.set(session.sessionId, session.estimatedCostUsd ?? 0);
    }
  }
  return costBySession;
}

/**
 * The branch's EVEN-SPLIT total cost: each linked session's captured cost divided
 * by its global active-write branch count, so a session shared with other
 * branches contributes only this branch's share. This is the per-branch cost the
 * branch-detail cost caption and Value-per-$ cards render; even-splitting matches
 * the desktop producer, where full per-branch attribution counted a shared
 * session's whole cost against every branch it touched and diverged from web.
 * Each session's cost is taken ONCE (the same session repeats across links).
 * `null` (never 0) when nothing prices — the existing detail cost contract.
 */
function evenSplitBranchCost(
  usage: BranchSessionCostUsage,
  branchCounts: Map<string, number>
): number | null {
  const costBySession = distinctSessionCosts(usage.sessions);
  let total = 0;
  for (const [sessionId, cost] of costBySession) {
    const branchCount = sessionBranchCount(branchCounts, sessionId);
    total += cost / branchCount;
  }
  return usage.sessions.some((session) => session.estimatedCostUsd !== null)
    ? total
    : null;
}

/**
 * FEA-4331 — the raw per-branch cost accumulator (`usage.estimatedCostUsd`): a
 * session's FULL captured cost added once per branch it links to. This is a
 * SHARED-SESSION OVER-COUNT across branches (a session on N branches reports its
 * whole cost on each). It is the value `toBranchRow` surfaces on the STABLE
 * `estimatedCostUsd` wire field — deliberately kept at this replicated semantics
 * so pre-FEA-4331 clients (desktop ≤ v0.16.627 cloud mode) that infer filtered
 * spend from it are not skewed (review: wongk). The corrected even-split share is
 * carried additively on `attributedCostUsd` (`evenSplitBranchCostByBranch`);
 * upgraded consumers prefer that, and everyone prefers the deduped `sessionCostUsd`
 * map for filtered spend.
 */
function rawBranchCost(usage: BranchSessionCostUsage): number | null {
  return usage.estimatedCostUsd > 0 ? usage.estimatedCostUsd : null;
}

/**
 * FEA-4331 — the LIST path's per-branch EVEN-SPLIT cost, one entry per branch on
 * the page. Each linked session's captured cost is divided by its GLOBAL
 * active-write branch count (`getSessionBranchCounts`, the same unfiltered divisor
 * the branch-detail cost uses), so a session shared across branches contributes
 * only each branch's 1/N share — the per-branch costs across a session sum back to
 * its cost once, never N times. Mirrors the desktop producer's list projection,
 * whose `readBranchTokenAggregateRows` divides `cost_usd_estimated` by
 * `branch_count` per branch (apps/desktop/src/main/database/branch-reads.ts), so
 * the two surfaces show the same per-branch cost. A branch with nothing priced
 * maps to null.
 */
function evenSplitBranchCostByBranch(
  usageByBranch: Map<string, BranchSessionCostUsage>,
  branchCounts: Map<string, number>
): Map<string, number | null> {
  const costByBranch = new Map<string, number | null>();
  for (const [branchId, usage] of usageByBranch) {
    costByBranch.set(branchId, evenSplitBranchCost(usage, branchCounts));
  }
  return costByBranch;
}

/**
 * FEA-4331 — the DISTINCT session ids across a page's branch usage, so the list
 * path can fetch each session's GLOBAL branch count once (the even-split divisor).
 * A session shared by several branches is collected once.
 */
function collectDistinctSessionIds(
  usageByBranch: Map<string, BranchSessionCostUsage>
): string[] {
  const sessionIds = new Set<string>();
  for (const usage of usageByBranch.values()) {
    for (const sessionId of usage.sessionIds) {
      sessionIds.add(sessionId);
    }
  }
  return [...sessionIds];
}

/**
 * FEA-3576 — stamp each `detail.sessions[]` row with its OWN even-split cost share
 * (`estimatedCostUsd ÷ its global active-write branch count`), the SAME per-session
 * division `evenSplitBranchCost` sums. Because both use one branch count per
 * session, `Σ session.evenSplitCostUsd` over the branch's DISTINCT sessions equals
 * `evenSplitBranchCost(usage, branchCounts)` (i.e. `detail.attributedCostUsd`) to
 * the cent — so the timeline's per-user bars reconcile with the header cost stat
 * without a lossy branch-wide scale. Duplicate session rows all receive the same
 * per-session share (idempotent); the timeline dedups before summing so a repeated
 * row is not double-counted. An un-priced session keeps a null share (mirrors
 * `estimatedCostUsd`). Mutates `detail.sessions` in place.
 */
function attachSessionEvenSplitCosts(
  detail: BranchPageDetail,
  branchCounts: Map<string, number>
): void {
  for (const session of detail.sessions) {
    if (session.estimatedCostUsd == null) {
      session.evenSplitCostUsd = null;
      continue;
    }
    const branchCount = sessionBranchCount(branchCounts, session.sessionId);
    session.evenSplitCostUsd = session.estimatedCostUsd / branchCount;
  }
}

/** The LOC-enrichment view of one branch the Value-per-$ denominator reads. */
type BranchLocEnrichmentMetrics = {
  /** Branch artifact id — keys this branch's sessions in `usageByBranch`. */
  id: string;
  additions: number | null;
  deletions: number | null;
};

/**
 * The Value-per-$ DENOMINATOR: captured cost even-split-attributed to the
 * LOC-enriched branches. The apportionment (FEA-2032 even-split) is the shared
 * `sumEvenSplitEnrichedSpend` kernel — the same one the desktop producer adapts
 * into (apps/desktop/src/main/branch/branch-analytics-projection.ts), so the two
 * surfaces cannot re-diverge. This adapter owns only web's per-session cost map:
 * each linked session's captured cost taken ONCE (the same session artifact is
 * pushed onto every branch it links to, so set-if-absent), an un-priced session
 * coerced to 0.
 *
 * NOT `sumUsage(usageByBranch.values())`: that is per-branch ATTRIBUTION, which
 * counts a session once per branch it touched. Each session's cost enters the map
 * exactly ONCE, then the kernel splits it.
 *
 * ISS-4689 — `globalBranchCounts` is the `getSessionBranchCounts` map: each
 * session's GLOBAL (unfiltered, corpus-wide) active-write branch count, the SAME
 * divisor the list row's `attributedCostUsd` and the branch-detail header use. It
 * makes the ratio window-independent: without it the kernel divides by the count
 * of branches in the SUPPLIED (windowed) `metrics` set, so narrowing the window
 * drops a shared session's out-of-window branch from the divisor as well as its
 * churn from the numerator and the ratio moves. Optional — omitted, the kernel
 * falls back to the in-set count.
 */
function sumLocEnrichedSpend(
  metrics: readonly BranchLocEnrichmentMetrics[],
  usageByBranch: ReadonlyMap<string, BranchSessionCostUsage>,
  globalBranchCounts?: ReadonlyMap<string, number>
): number | null {
  const costBySession = distinctSessionCosts(
    [...usageByBranch.values()].flatMap((usage) => usage.sessions)
  );
  return sumEvenSplitEnrichedSpend(
    metrics.map((metric) => ({
      enriched: isLocEnriched(metric),
      sessionIds: usageByBranch.get(metric.id)?.sessionIds ?? [],
    })),
    costBySession,
    globalBranchCounts
  );
}

export {
  attachSessionEvenSplitCosts,
  type BranchLocEnrichmentMetrics,
  type BranchSessionCostUsage,
  collectDistinctSessionIds,
  distinctSessionCosts,
  evenSplitBranchCost,
  evenSplitBranchCostByBranch,
  rawBranchCost,
  sessionBranchCount,
  sumLocEnrichedSpend,
};
