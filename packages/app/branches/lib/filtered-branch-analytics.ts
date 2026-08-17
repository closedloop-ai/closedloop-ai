import {
  type BranchAnalytics,
  type BranchKpi,
  BranchKpiState,
  BranchSessionPresence,
  BranchStatus,
  NO_BRANCH_KPI_BASELINE,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { median } from "@repo/api/src/utils/math";
import { countPrLifecycle } from "@repo/lib/branches/branch-lifecycle-count";
import {
  isLocEnriched,
  sumEvenSplitEnrichedSpend,
} from "@repo/lib/branches/loc-per-dollar";
import { reportableSpendUsd } from "@repo/lib/branches/spend-kpi";
import {
  type BranchFilters,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
  type BranchRow as RenderBranchRow,
  shortRepoName,
} from "./branch-row";
import { toRenderStatus } from "./branch-row-adapter";

/**
 * FEA-3629 — re-derive the Branches top-bar summary KPIs over the CURRENTLY
 * filtered set.
 *
 * The Branches toolbar applies its status/owner/repo facets purely client-side
 * (`filterBranchRows` over the render rows) — the table below narrows, but the
 * summary cards were fed the server's full-corpus `BranchAnalytics`, so the
 * headline stats never moved when a filter was applied (they showed unfiltered
 * totals while the table was filtered). The server analytics route only accepts
 * the date window (and status/repo, but NOT owner), so there is no single server
 * query that matches every toolbar facet; instead we re-project the KPIs that
 * are derivable from the wire rows over the same filtered subset the table
 * shows, mirroring the Sessions page's filter-aware summary.
 *
 * The re-projection reuses the EXACT rules the two server producers use
 * (`apps/desktop/.../branch-analytics-projection.ts` and the web
 * `getBranchAnalytics`): merge rate over DECIDED single-PR branches, median PR
 * size over merged LOC-enriched single-PR branches, active = status not
 * merged/closed, and the even-split Value-per-$ denominator kernel. So when the
 * supplied visible set IS the whole corpus AND no facet is active, the derived
 * numbers equal the server's and the fully-unfiltered case is unchanged.
 *
 * FEA-3694 — the derivation ALWAYS runs over the supplied `visibleRows`, even
 * with no facet active: facet activation is only one filtering input, and the
 * surface also narrows the visible population via search/pagination before it
 * reaches here. An earlier early-return to `base` on empty facets ignored those
 * other constraints and let the header cards drift from the narrowed table.
 *
 * FEA-3629 v2 — callers MUST pass the wire rows for the table's VISIBLE set
 * (windowed), NOT the raw server `items`. Use `selectVisibleWireRows` at the
 * call site to recover them from the render `visibleRows`. Feeding the raw
 * corpus was the #3281 gap: it counted rows the table hides and, on the desktop
 * LOCAL (unwindowed) source, re-expanded the cards back to all-time on any
 * facet.
 *
 * GitHub-timing KPIs (time-to-merge, lead time) and the build-vs-rework split are
 * NOT re-derivable from the row shape, so the server's values pass through
 * untouched. A re-derived KPI drops its 30-day baseline/delta: that baseline is
 * a full-corpus prior-window figure, so a "vs. prior 30 days" delta against a
 * filtered value would be apples-to-oranges (see `available`/`unavailable`).
 */

/**
 * Apply the toolbar facet predicate to a WIRE row, mirroring `filterBranchRows`
 * (which runs over render rows): status is compared through the same
 * wire→render status map, owner falls back to the "unattributed" render value,
 * and repo compares the short name — so the re-derived subset is exactly the set
 * the table renders.
 */
function wireRowMatchesFilters(
  row: WireBranchRow,
  filters: BranchFilters
): boolean {
  const renderStatus = toRenderStatus(row.status);
  const owner = row.owner ?? RENDER_UNATTRIBUTED;
  // Mirror the render adapter EXACTLY: a null repoFullName becomes the
  // "—" render placeholder before shortRepoName, so the repo facet's "—"
  // option matches null-repo rows here just as it does in the table.
  const repo = shortRepoName(row.repoFullName ?? RENDER_MISSING);
  return (
    (filters.statuses.length === 0 ||
      filters.statuses.includes(renderStatus)) &&
    (filters.owners.length === 0 || filters.owners.includes(owner)) &&
    (filters.repos.length === 0 || filters.repos.includes(repo)) &&
    wireRowMatchesSessionPresence(row, filters.sessionPresence) &&
    wireRowMatchesLocRange(row, filters.locMin, filters.locMax)
  );
}

/** Linked-session presence over a wire row, mirroring the render-row predicate. */
function wireRowMatchesSessionPresence(
  row: WireBranchRow,
  presence: string[]
): boolean {
  if (presence.length === 0) {
    return true;
  }
  const key =
    row.sessionIds.length > 0
      ? BranchSessionPresence.Has
      : BranchSessionPresence.None;
  return presence.includes(key);
}

/**
 * LOC-range over a wire row's `additions + deletions`, mirroring the render-row
 * predicate: unavailable LOC (both counts null) is EXCLUDED once either bound is
 * set; no bound ⇒ every row passes.
 */
function wireRowMatchesLocRange(
  row: WireBranchRow,
  min: number | undefined,
  max: number | undefined
): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }
  if (row.additions === null && row.deletions === null) {
    return false;
  }
  const loc = (row.additions ?? 0) + (row.deletions ?? 0);
  if (min !== undefined && loc < min) {
    return false;
  }
  return !(max !== undefined && loc > max);
}

// A re-derived KPI drops the base's 30-day baseline/delta: those are a
// FULL-CORPUS prior-window figure, so comparing a FILTERED value against it
// would report an apples-to-oranges delta ("vs. prior 30 days"). We cannot
// recompute a filtered baseline client-side (no historical filtered data), so
// the honest choice is no delta on a filtered KPI — the card simply omits it.
function available(value: number): BranchKpi {
  return {
    value,
    state: BranchKpiState.Available,
    ...NO_BRANCH_KPI_BASELINE,
  };
}

function unavailable(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Unavailable,
    ...NO_BRANCH_KPI_BASELINE,
  };
}

/**
 * FEA-4268 — the FILE-CACHE-only LOC basis the analytics KPIs use, so a row whose
 * DISPLAYED `additions`/`deletions` were backfilled from the connected PR
 * (`resolveDetailLoc`) is NOT treated as file-cache-enriched here. Falls back to
 * the displayed fields when the additive `analytics*` fields are absent (a
 * producer predating FEA-4268, whose displayed fields still carried the file-cache
 * value), preserving the old basis on stale client/server pairings.
 */
function analyticsLoc(row: WireBranchRow): {
  additions: number | null;
  deletions: number | null;
} {
  return {
    additions:
      row.analyticsAdditions === undefined
        ? row.additions
        : row.analyticsAdditions,
    deletions:
      row.analyticsDeletions === undefined
        ? row.deletions
        : row.analyticsDeletions,
  };
}

/**
 * A branch carries LOC enrichment for ANALYTICS once BOTH file-cache line counts
 * have landed — read from the analytics basis, never the PR-backfilled display
 * value, so Median PR size / Value-per-$ match the server and desktop producer.
 */
function isLocEnrichedRow(row: WireBranchRow): boolean {
  return isLocEnriched(analyticsLoc(row));
}

/**
 * FEA-3695 — the per-session cost map for the filtered subset, each session
 * counted EXACTLY ONCE, keyed on the non-nullable session id.
 *
 * The AUTHORITATIVE identity: the server surfaces `sessionCostUsd` on the list
 * response — a `sessionId → USD` map of each session's OWN captured cost, the
 * same deduped basis the headline AI-spend KPI uses. We narrow it to just the
 * sessions the filtered rows reference (via a `Set`, so a session linked to two
 * visible branches is collected once) and read each session's cost straight from
 * the map. There is NO allocation, NO inference, NO per-branch division — so the
 * filtered total is a strict subset-sum of authoritative per-session costs and
 * can never exceed the unique-session population (the #3695 double-count is
 * structurally impossible).
 *
 * This replaces the prior even-split-then-MAX inference over the per-branch
 * `estimatedCostUsd` (the SUM of a branch's sessions' costs): that could neither
 * recover a branch's true per-session split nor stay additive across branches,
 * so the AC counterexample — branch {s1:$90, s2:$10} plus a branch {s1:$90} —
 * reported $140 where the authoritative unique spend is $100.
 *
 * FALLBACK (`authoritativeCost` undefined — an older producer that predates the
 * wire field): keep the legacy inference so spend still renders SOMETHING rather
 * than "—" on a stale client/server pairing. When the map IS present, the legacy
 * path is never taken. An un-priced session (absent from the map) contributes
 * nothing.
 */
function costBySessionForSubset(
  rows: readonly WireBranchRow[],
  authoritativeCost: Readonly<Record<string, number>> | undefined
): Map<string, number> {
  return authoritativeCost
    ? authoritativeCostBySession(rows, authoritativeCost)
    : inferredCostBySession(rows);
}

/**
 * Authoritative path: sum each DISTINCT session the filtered rows reference
 * exactly once, straight from the deduped server map. A session linked to two
 * visible branches is collected once (the `Set` guard), and an un-priced session
 * (absent from the map) contributes nothing. This is a strict subset-sum of
 * authoritative per-session costs, so it can never exceed the unique population.
 */
function authoritativeCostBySession(
  rows: readonly WireBranchRow[],
  authoritativeCost: Readonly<Record<string, number>>
): Map<string, number> {
  const costBySession = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    for (const sessionId of row.sessionIds) {
      if (seen.has(sessionId)) {
        continue;
      }
      seen.add(sessionId);
      const cost = authoritativeCost[sessionId];
      if (cost != null) {
        costBySession.set(sessionId, cost);
      }
    }
  }
  return costBySession;
}

/**
 * Legacy fallback (older producer without the wire map): recover a per-session
 * figure from the per-branch total by even-splitting and keeping the MAX any
 * branch reports (counts a shared session roughly once). Lossy — retained only
 * so spend renders SOMETHING on a stale client/server pairing.
 */
function inferredCostBySession(
  rows: readonly WireBranchRow[]
): Map<string, number> {
  const costBySession = new Map<string, number>();
  for (const row of rows) {
    const cost = row.estimatedCostUsd;
    if (cost == null || row.sessionIds.length === 0) {
      continue;
    }
    const perSession = cost / row.sessionIds.length;
    for (const sessionId of row.sessionIds) {
      costBySession.set(
        sessionId,
        Math.max(costBySession.get(sessionId) ?? 0, perSession)
      );
    }
  }
  return costBySession;
}

/**
 * Re-project the row-derivable summary KPIs over the exact VISIBLE branch
 * population the surface supplies (`visibleRows`), narrowed by the active facet
 * filters, while preserving the base analytics for everything the row shape
 * cannot express.
 *
 * FEA-3694 — the header must always derive from the supplied visible rows, even
 * when NO facet filter is active. Facet activation is only ONE filtering input:
 * the caller also narrows the visible population via search and pagination
 * before it reaches this helper (`selectVisibleWireRows` over the table's
 * `visibleRows`). An earlier version short-circuited to `base` whenever the
 * facets were empty, which ignored those other row constraints and left the
 * header cards showing full-corpus totals while the table below was narrowed by
 * search/pagination. We now always re-derive over `visibleRows`; when that set
 * IS the whole corpus AND no facet is active the derived numbers equal the
 * server's (same rules, same population), so the fully-unfiltered case is
 * unchanged.
 */
export function deriveFilteredBranchAnalytics(
  base: BranchAnalytics,
  // The wire rows for the table's VISIBLE population (windowed →
  // search/pagination-narrowed) the surface currently shows — NOT the raw server
  // corpus. Recover them with `selectVisibleWireRows` at the call site.
  visibleRows: readonly WireBranchRow[],
  filters: BranchFilters,
  // FEA-3695 — the authoritative per-session cost map from the list response
  // (`BranchListResponse.sessionCostUsd`), each session's own captured cost keyed
  // once by non-nullable session id. When present, filtered spend and
  // LOC-per-$ are computed as a strict subset-sum over it (no double-count);
  // when absent (older producer), the helper falls back to the legacy branch-
  // total inference. This map is WINDOWED (FEA-4270) and feeds filtered AI-spend.
  sessionCostUsd?: Readonly<Record<string, number>>,
  // ISS-4632 — the LIFETIME per-session cost map
  // (`BranchListResponse.lifetimeSessionCostUsd`), same shape but without the date
  // window applied. Feeds the Value-per-$ ratio DENOMINATOR so it divides lifetime
  // churn by lifetime spend, removing the SPEND axis's window-sensitivity.
  // Optional: when absent (older server that predates the field), fall back to
  // the windowed `sessionCostUsd` — the pre-fix behavior — so a version-skewed
  // client still renders a value.
  lifetimeSessionCostUsd?: Readonly<Record<string, number>>,
  // ISS-4689 — each session's GLOBAL corpus-member branch count
  // (`BranchListResponse.sessionBranchCount`), the even-split DIVISOR for the
  // Value-per-$ denominator. Without it the kernel can only divide by the branches
  // present in `rows` — a set the date window, the facets, and pagination have all
  // already narrowed — so a multi-branch session whose branches span different ages
  // lost the out-of-window branch from the divisor AND its churn from the numerator,
  // and the ratio moved with the window even on the ISS-4632 lifetime cost map.
  // Optional: absent (older server), the kernel falls back to the in-set count.
  sessionBranchCount?: Readonly<Record<string, number>>
): BranchAnalytics {
  // Apply the facet predicate over the supplied visible rows. With no facet
  // active `wireRowMatchesFilters` matches every row, so this is a no-op narrow
  // and the derivation runs over the full visible population.
  const rows = visibleRows.filter((row) => wireRowMatchesFilters(row, filters));

  // FEA-4333: classify each single-PR branch's connected PR through the SAME
  // merge-evidence-first `countPrLifecycle` classifier the two server producers
  // use, so a stale-open-but-merged PR (raw `prState` OPEN + `mergedAt` set)
  // lands ONLY in the merged bucket, never `active` — the active-PR and merged
  // counts are mutually exclusive by construction. Previously this recompute read
  // raw `row.prState`, so it silently re-introduced the double-classification the
  // server fix removed (the corrected server value is discarded because this
  // derivation ALWAYS runs, FEA-3694). Multi-PR branches stay excluded (ambiguous
  // lifecycle — the row carries only the latest PR's state), matching both
  // producers and the median-PR-size cohort below.
  const prLifecycleCounts = countPrLifecycle(
    rows
      .filter((row) => !row.multiPrWarning)
      // `mergedAt` is an OPTIONAL wire field (omitted by pre-FEA-4333 and desktop
      // producers) — coalesce the absent value to null so the classifier falls
      // back to `prState` alone, its safe pre-fix default.
      .map((row) => ({ prState: row.prState, mergedAt: row.mergedAt ?? null }))
  );
  // Merge rate = merged / decided (merged + closed), matching both server
  // producers. A still-open PR has no terminal outcome yet, so it is excluded
  // from the denominator.
  const decidedCount = prLifecycleCounts.merged + prLifecycleCounts.closed;
  const mergeRate =
    decidedCount > 0
      ? available((prLifecycleCounts.merged / decidedCount) * 100)
      : unavailable();

  // Median PR size over MERGED, single-PR, LOC-enriched branches (un-enriched
  // excluded, never folded in as 0). FEA-4268: uses the FILE-CACHE analytics basis
  // (`analyticsLoc`), not the PR-backfilled display value, so the median matches
  // the server's `analyticsPullRequestSize` and the desktop producer.
  const sizes = rows
    .filter(
      (row) =>
        row.status === BranchStatus.Merged &&
        !row.multiPrWarning &&
        isLocEnrichedRow(row)
    )
    .map((row) => {
      const loc = analyticsLoc(row);
      return (loc.additions ?? 0) + (loc.deletions ?? 0);
    });
  const medianPrSize =
    sizes.length > 0 ? available(median(sizes) ?? 0) : unavailable();

  // Active branches — status not merged/closed. A 0 over a non-empty subset is
  // meaningful (everything merged); only an empty subset is unavailable.
  const activeBranchCount =
    rows.length > 0
      ? available(
          rows.filter(
            (row) =>
              row.status !== BranchStatus.Merged &&
              row.status !== BranchStatus.Closed
          ).length
        )
      : unavailable();

  // Active-PR and merged counts from the SAME merge-evidence-first
  // `countPrLifecycle` buckets (FEA-4333). `activePrCount` is the `active` bucket
  // — an OPEN PR with no merge evidence — so a stale-open-but-merged PR is EXCLUDED
  // here (it is in the `merged` bucket), keeping the two counts mutually exclusive.
  // The merged count reuses the very bucket that feeds the merge-rate numerator, so
  // the "Merged PRs" count and the rate's numerator can never disagree for one
  // subset.
  const activePrCount =
    rows.length > 0 ? available(prLifecycleCounts.active) : unavailable();
  const mergedCount =
    rows.length > 0 ? available(prLifecycleCounts.merged) : unavailable();

  // Total AI spend — session-deduped priced cost over the filtered subset (a
  // session shared across branches is counted once), so the card reflects the
  // filtered set instead of the unfiltered corpus and never double-counts.
  //
  // ISS-4737 — availability follows the SHARED null-on-zero rule
  // (`reportableSpendUsd`), the same one both server producers now call, NOT
  // "the subset contains at least one priced session". Keying on the presence of
  // a priced session let a subset whose priced sessions summed to exactly $0
  // render `$0` — a card asserting "you spent nothing" where the truth is "we
  // have no usable spend figure for this set" — while the server reported the
  // same corpus as no-data. "Nothing priced" and "priced, sums to zero" stay
  // distinguishable upstream in `costBySession` (empty map vs zero-valued
  // entries); only the rendered KPI, which has no state to express the
  // difference, collapses them.
  const costBySession = costBySessionForSubset(rows, sessionCostUsd);
  let spendTotal = 0;
  for (const cost of costBySession.values()) {
    spendTotal += cost;
  }
  // No corrupt-total report on THIS producer, unlike the two server ones
  // (`isAnomalousSpendTotal` in `branch-analytics-kpis.ts` / `shared-branches-api.ts`):
  // this is browser code, where the repo's `no-client-debug-logging` gate bans
  // logging outright, and its input is the per-session cost map the server
  // already validated and reported on before it reached the wire.
  const reportableSpend = reportableSpendUsd(spendTotal);
  const totalSpendUsd =
    reportableSpend === null ? unavailable() : available(reportableSpend);

  // LOC / $ = total churn ÷ even-split enriched spend, reusing the shared
  // denominator kernel so the ratio matches the server definition. FEA-4268: churn
  // and enrichment read the FILE-CACHE analytics basis (`analyticsLoc`), never the
  // PR-backfilled display value.
  // ISS-4632: the denominator reads a LIFETIME cost map, not the windowed
  // `costBySession` above, so it matches the lifetime-churn numerator and
  // narrowing the window no longer shrinks only the denominator. Falls back to the
  // windowed map when the server omits the lifetime one (version skew) — the
  // pre-fix behavior.
  // ISS-4689: the DIVISOR is likewise window-independent — each session's global
  // corpus-member branch count from the server, not the count of branches left in
  // `rows` after the window/facets/pagination narrowed it. Absent (older server),
  // the kernel falls back to that in-set count.
  const lifetimeCostBySession = costBySessionForSubset(
    rows,
    lifetimeSessionCostUsd ?? sessionCostUsd
  );
  const globalBranchCounts = sessionBranchCount
    ? new Map(Object.entries(sessionBranchCount))
    : undefined;
  const locRows = rows.filter(isLocEnrichedRow);
  const totalChurn = locRows.reduce((sum, row) => {
    const loc = analyticsLoc(row);
    return sum + (loc.additions ?? 0) + (loc.deletions ?? 0);
  }, 0);
  const locEnrichedSpend = sumEvenSplitEnrichedSpend(
    rows.map((row) => ({
      enriched: isLocEnrichedRow(row),
      sessionIds: row.sessionIds,
    })),
    lifetimeCostBySession,
    globalBranchCounts
  );
  const locPerDollar =
    locRows.length > 0 && locEnrichedSpend != null && locEnrichedSpend > 0
      ? available(totalChurn / locEnrichedSpend)
      : unavailable();

  return {
    ...base,
    mergeRate,
    medianPrSize,
    activeBranchCount,
    activePrCount,
    mergedCount,
    totalSpendUsd,
    locPerDollar,
  };
}

/**
 * FEA-3629 (v2) — narrow the wire corpus to the rows the TABLE currently shows
 * BEFORE the facet re-projection.
 *
 * The summary derivation must re-project over the same pre-facet set the table
 * renders — i.e. the date-WINDOWED rows (`visibleRows`), not the raw server
 * corpus (`allWireRows`). The two diverge on the desktop LOCAL (offline /
 * signed-out) source, which does NOT window server-side, so its raw `items` are
 * all-time — feeding them here silently re-expands the summary cards back to
 * all-time the moment any facet is applied (the FEA-2155 regression the v1 fix
 * reintroduced).
 *
 * `visibleRows` are RENDER rows (already windowed by the page/view). We recover
 * the corresponding WIRE rows by id — the derivation
 * needs wire fields (`estimatedCostUsd`, `sessionIds`, `prState`,
 * `multiPrWarning`) the render row drops — so the re-projected KPIs are computed
 * over EXACTLY the table's pre-facet corpus and then narrowed by the facets,
 * keeping the cards and the filtered table in lockstep.
 */
export function selectVisibleWireRows(
  allWireRows: readonly WireBranchRow[],
  visibleRows: readonly RenderBranchRow[]
): WireBranchRow[] {
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  return allWireRows.filter((row) => visibleIds.has(row.id));
}
