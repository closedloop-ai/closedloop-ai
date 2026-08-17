/**
 * The LOC/$ (lines-per-dollar) DENOMINATOR kernel, shared by both branch
 * analytics producers so the ONE cross-surface card cannot re-diverge:
 *
 * - web  — apps/api/app/branches/branch-read-service.ts (`getBranchAnalytics`)
 * - desktop — apps/desktop/src/main/branch/branch-analytics-projection.ts
 * - client — packages/app/branches/lib/filtered-branch-analytics.ts, which
 *   re-derives the SAME card over the table's visible/filtered rows (FEA-3629)
 *   and therefore overrides whatever either server producer computed
 *
 * These two hand-maintained copies once drifted (net vs gross churn, attribution
 * vs even-split spend) and shipped different numbers for the same card; this is
 * the single implementation both now adapt into. Lives in `@repo/lib` — Node-safe,
 * no server-only deps — the same home as the sibling `merged-trace` kernel both
 * surfaces already import.
 *
 * Each surface owns the shape of its rows and its per-session cost map (desktop
 * sums stored per-model cost and drops un-priced rows; web takes each linked
 * session once, coercing an un-priced session to 0), then calls this kernel with
 * the normalized inputs. The apportionment — the FEA-2032 even-split design — is
 * what lives here.
 */

/**
 * A branch carries FEA-1899 LOC enrichment once BOTH line counts have landed —
 * AND, not OR: a branch missing either count has UNKNOWN LOC, distinct from a
 * branch with KNOWN-zero LOC (both present, no lines touched). This single
 * predicate keeps the enrichment definition from drifting between surfaces.
 */
export function isLocEnriched(row: {
  additions: number | null;
  deletions: number | null;
}): row is { additions: number; deletions: number } {
  return row.additions !== null && row.deletions !== null;
}

/** One branch's contribution to the even-split: whether it is LOC-enriched and the deduped session ids linked to it. */
export type EvenSplitBranch = {
  enriched: boolean;
  /** Session ids linked to this branch, already deduped per branch. */
  sessionIds: Iterable<string>;
};

/**
 * Even-split enriched spend — the Value-per-$ denominator. Each session's cost
 * is apportioned EVENLY across the branches it touched (FEA-2032), keeping only
 * the enriched-branch fraction: a session that worked an enriched branch AND an
 * un-enriched one has only part of its spend offset by known LOC, so counting its
 * full cost would drag un-enriched spend — money with no LOC to offset it — into
 * the denominator and deflate the ratio.
 *
 * `costBySession` must count each session's cost ONCE (it is divided here, not
 * summed across branches). A 0-cost entry is treated as priced-zero, so whether
 * the all-un-priced case returns `0` or `null` follows how the caller built the
 * map (drop un-priced rows → `null`; coerce to 0 → `0`) — both render "—" at the
 * card's `> 0` gate. Returns `null` when no enriched branch carried any priced
 * session.
 *
 * ISS-4689 — `globalBranchCountBySession` supplies the WINDOW-INDEPENDENT
 * divisor: how many corpus-member branches each session touched GLOBALLY, not
 * just within `branches`. Without it the divisor is the in-set count, so
 * narrowing the date window drops a session's out-of-window branch from BOTH the
 * divisor and the churn numerator and the ratio moves with the window (the
 * residual ISS-4632 left): a $100 session on two enriched branches of different
 * ages read $100/2000 churn all-time but $100/1000 churn at 7d. With the global
 * divisor the session contributes `cost × inSetEnriched / globalTouched`, so the
 * in-window branch carries exactly its own 1/N share of spend against its own
 * churn and the ratio holds across windows.
 *
 * Optional and clamped, never trusted blindly: a session with no global entry —
 * or a stale/non-finite/smaller-than-in-set one, which a version-skewed producer
 * or a partial wire map can hand us — falls back to the in-set count. That both
 * preserves the pre-ISS-4689 behavior for callers that cannot supply a global
 * divisor and keeps a session from ever attributing MORE than its full cost.
 */
export function sumEvenSplitEnrichedSpend(
  branches: readonly EvenSplitBranch[],
  costBySession: ReadonlyMap<string, number>,
  globalBranchCountBySession?: ReadonlyMap<string, number>
): number | null {
  // Per session: how many distinct branches it touched, and how many of those
  // are LOC-enriched — the even-split divisor and enriched-fraction numerator.
  const branchCount = new Map<string, number>();
  const enrichedCount = new Map<string, number>();
  for (const branch of branches) {
    for (const sessionId of branch.sessionIds) {
      branchCount.set(sessionId, (branchCount.get(sessionId) ?? 0) + 1);
      if (branch.enriched) {
        enrichedCount.set(sessionId, (enrichedCount.get(sessionId) ?? 0) + 1);
      }
    }
  }

  let total = 0;
  let anyPriced = false;
  for (const [sessionId, cost] of costBySession) {
    const touched = branchCount.get(sessionId) ?? 0;
    const enriched = enrichedCount.get(sessionId) ?? 0;
    if (touched === 0 || enriched === 0) {
      continue;
    }
    const divisor = evenSplitDivisor(
      touched,
      globalBranchCountBySession?.get(sessionId)
    );
    total += cost * (enriched / divisor);
    anyPriced = true;
  }
  return anyPriced ? total : null;
}

/**
 * The even-split divisor for one session: its GLOBAL corpus-member branch count
 * when that is usable, else the in-set count (`inSetTouched`, the pre-ISS-4689
 * behavior).
 *
 * `globalCount` can arrive from a wire map (JSON, so unvalidated at runtime) or
 * from a producer that predates the global divisor, so it is only taken when it
 * is a POSITIVE SAFE INTEGER that EXCEEDS the in-set count. A missing, non-finite,
 * fractional, or smaller value is not a smaller divisor — it is an unusable one:
 * a branch count is a cardinality, so a fractional `2.5` is malformed on its face
 * and would render a plausible-but-wrong ratio (ISS-4689 review), and dividing by
 * less than the branches actually in the set would attribute more than 100% of
 * the session's cost. In every unusable case the in-set count stands as the floor.
 */
function evenSplitDivisor(
  inSetTouched: number,
  globalCount: number | undefined
): number {
  if (globalCount === undefined || !isBranchCardinality(globalCount)) {
    return inSetTouched;
  }
  return Math.max(inSetTouched, globalCount);
}

/**
 * Whether a wire-supplied global branch count is a usable cardinality: a
 * positive safe integer. `Number.isSafeInteger` rejects `NaN`, both infinities,
 * every fractional value, and anything past 2^53-1 in one predicate.
 */
function isBranchCardinality(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
