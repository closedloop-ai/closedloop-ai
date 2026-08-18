import {
  costFilterIncludesUnknown,
  getSessionCostBucket,
  isExhaustiveCostFilter,
  matchesCostBucket,
  matchesUnknownCost,
  type SessionCostBucketId,
  type SessionSubstantiveCounts,
  sessionCostIsNumeric,
} from "@repo/api/src/agent-session-filters";
import { isSubscriptionBillingMode } from "@repo/api/src/types/billing-mode";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { toNumber } from "@/lib/prisma-number";
import { roundCost } from "./coercion";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./records";

/**
 * FEA-4276: the single documented captured-cost authority for a session, shared
 * by the Sessions LIST projection (`toSessionListItem`) and the session DETAIL
 * projection (`findSessionDetail`).
 *
 * There are two independently-synced cost sources on a session:
 *   - `SessionDetail.estimatedCost` — the desktop's per-model rollup, summed from
 *     `tokenUsageByModel`. This is what the list historically read directly.
 *   - `AgentSessionTokenEvent.estimatedCost` — the raw per-event token cost log.
 *
 * These can diverge for LEGACY sessions — this is a read repair, not a
 * description of current producer behavior. The FEA-3419 (rev-38) reprice path
 * DOES keep the two in sync going forward: `updateSessionCostRollup` rebuilds
 * `sessions.cost_usd_estimated` EXCLUSIVELY from the repriced `token_usage`
 * (mirrored per event), and the rebuild bumps the sync watermark so BOTH the
 * rollup and the per-event stream re-upload together. So for any session the
 * current desktop has rebuilt, rollup ≈ Σ per-event and this helper returns the
 * same figure from either source.
 *
 * The divergence this authority repairs is confined to sessions the current
 * producer has NOT reconciled: (a) sessions last synced BEFORE rev-38 reached
 * them, whose cloud rollup predates the reprice while their per-event rows were
 * later corrected in place (FEA-3419's `updateTokenEventCost` upsert lands even
 * when the rollup re-upload lagged); and (b) the FEA-2926 window, where the
 * DETAIL total was already made to prefer Σ per-event over the rollup so the
 * properties-panel total and the per-turn / timeline buckets agree by
 * construction. The LIST kept reading the rollup, so it disagreed with the
 * record a reviewer opens for exactly those legacy rows (FEA-4276: $1,378.39
 * list vs $33.24 detail). This helper aligns the two for those legacy sessions
 * and is a no-op for every session the current producer already keeps whole.
 *
 * This helper is that reconciliation, extracted so BOTH surfaces derive the
 * displayed cost identically: prefer Σ per-event costs when the session has
 * token events and they were not truncated by the read cap; otherwise fall back
 * to the stored rollup (Codex/OTel sessions with no per-event stream, or a
 * pathological > cap session whose truncated sum would under-report).
 *
 * Pure by design — no DB access — so the widely-imported `projections.ts` (and
 * its tests) can reconcile a row without pulling a query helper into the module
 * graph. The bulk per-session aggregate that feeds `tokenEventCount` /
 * `pricedEventCount` / `tokenEventCostSum` lives in the org-scoped, bounded
 * reader `getReconciledCostsBySessionId` (`cost-reconciled-reader.ts`).
 */
export function reconcileSessionCost(input: {
  /** Number of per-event token rows observed for this session. */
  tokenEventCount: number;
  /**
   * Number of rows whose cost is authoritative for the whole event: a legacy
   * positive cost, or a new `complete` summary (including truthful zero).
   * Legacy zero and partial/unavailable summaries remain unpriced so an
   * incomplete per-event sum cannot replace the stored whole-session rollup.
   */
  pricedEventCount: number;
  /** Σ of the observed per-event token costs (USD). */
  tokenEventCostSum: number;
  /**
   * FEA-4276 (shafty review): Σ of the observed per-event input+output token
   * COUNTS. The per-event stream is optional, chunked into separate sync
   * requests, and append-only, so a chunk can be dropped or overflow-truncated at
   * INGEST — leaving fewer rows than the session actually has WITHOUT hitting the
   * read cap. Row count alone can't detect that (a partial 1–9,999-row stream
   * looks complete), so we cross-check the per-event token counts against the
   * desktop's authoritative rollup token total (`rollupTokenTotal`): a complete
   * stream sums to the rollup, an incomplete one sums to LESS. This is a
   * magnitude-independent completeness proof — it catches dropped rows without
   * rejecting the legitimate reprice case (FEA-4276), where token COUNTS match the
   * rollup and only the per-token PRICE was corrected.
   */
  tokenEventTokenSum: number;
  /**
   * The desktop rollup's authoritative input+output token total
   * (`SessionDetail.inputTokens + outputTokens`), the completeness reference for
   * `tokenEventTokenSum`. A rollup of 0 (Codex/OTel sessions with no token
   * accounting, or older payloads) disables the token cross-check — there is no
   * reference to compare against, and the priced/capped gates still apply.
   */
  rollupTokenTotal: number;
  /** Stored per-model rollup (`SessionDetail.estimatedCost`), the fallback. */
  storedRollup: number;
}): number {
  const {
    tokenEventCount,
    pricedEventCount,
    tokenEventCostSum,
    tokenEventTokenSum,
    rollupTokenTotal,
    storedRollup,
  } = input;
  // A count at/above the cap means the per-event read was (or would be)
  // truncated, so its sum can under-report — fall back to the rollup. This
  // mirrors the detail path's `isCapped` guard so list and detail agree exactly
  // on capped sessions too.
  const isCapped = tokenEventCount >= SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS;
  // COMPLETENESS: only fully-priced streams have a trustworthy per-event sum.
  // Any unpriced row makes the sum a partial/zero under-report, so fall back to
  // the rollup (which the desktop producer keeps whole).
  const isFullyPriced = pricedEventCount >= tokenEventCount;
  // INGEST COMPLETENESS (shafty review): if the desktop rollup accounts for more
  // tokens than the per-event rows we hold, a chunk was dropped/overflowed at
  // ingest and the cost sum is a partial under-report — fall back to the rollup.
  // Only enforced when the rollup carries a token total to compare against.
  const isTokenComplete =
    rollupTokenTotal <= 0 || tokenEventTokenSum >= rollupTokenTotal;
  if (tokenEventCount > 0 && !isCapped && isFullyPriced && isTokenComplete) {
    return roundCost(tokenEventCostSum);
  }
  return storedRollup;
}

/**
 * Per-session reconciled-cost inputs, keyed by session artifact id, produced by
 * the bulk `getReconciledCostsBySessionId` reader and consumed by
 * `toSessionListItem`. `count` is the (cap-bounded) per-event row count;
 * `pricedCount` is how many rows carried authoritative complete cost evidence
 * (legacy positive costs still count; see `isAuthoritativeTokenEventCost`);
 * `sum` is Σ of the events' `estimatedCost`; `tokenSum` is Σ of their input+output token
 * COUNTS, cross-checked against the rollup token total to catch a
 * dropped/overflowed ingest chunk (the shafty completeness review).
 */
export type SessionCostAuthorityMap = ReadonlyMap<
  string,
  { count: number; pricedCount: number; sum: number; tokenSum: number }
>;

/** Mirrors the list reader's SQL predicate for one detail token-event row. */
export function isAuthoritativeTokenEventCost(input: {
  estimatedCost: number | null;
  costCompleteness: string | null;
}): boolean {
  if (input.estimatedCost === null) {
    return false;
  }
  return (
    input.costCompleteness === TokenCostCompleteness.Complete ||
    (input.costCompleteness === null && input.estimatedCost > 0)
  );
}

/** Counts detail rows whose event cost can replace the whole-session rollup. */
export function countAuthoritativeTokenEventCosts(
  events: readonly {
    estimatedCost: number | bigint | { toNumber?: () => number } | null;
    costCompleteness: string | null;
  }[]
): number {
  return events.filter((event) =>
    isAuthoritativeTokenEventCost({
      estimatedCost:
        event.estimatedCost === null ? null : toNumber(event.estimatedCost),
      costCompleteness: event.costCompleteness,
    })
  ).length;
}

/** The `sortBy` value that orders the Sessions list by cost. */
export const SESSION_COST_SORT_BY = "cost";

/**
 * FEA-4276: does this list query key filtering or ordering off cost? Cost is the
 * ONE list dimension whose stored `SessionDetail.estimatedCost` rollup can
 * diverge from the reconciled captured-cost authority (`reconcileSessionCost`)
 * the UI now shows. `buildCostBucketWhere` / `buildAgentSessionOrderBy` predicate
 * on that stale rollup column, so when the query filters by a cost bucket or
 * sorts by cost the service must resolve the reconciled cost BEFORE filtering,
 * ordering, counting, and pagination — otherwise a session lands in the wrong
 * bucket or the wrong page position relative to the figure it displays. Every
 * OTHER dimension (date, harness, model, autonomy, …) is unaffected and keeps the
 * cheap DB-paginated path.
 */
export function isCostReconciliationSensitiveQuery(filters: {
  sortBy?: string;
  costBuckets?: readonly string[];
}): boolean {
  if (filters.sortBy === SESSION_COST_SORT_BY) {
    return true;
  }
  // shafty thread (ISS-4481): an EXHAUSTIVE cost selection (every numeric bucket
  // AND Unknown) excludes no row, so it is a no-op filter. It must NOT route
  // through the bounded reconciled path — that scan caps at 10,000 candidates and
  // would silently drop older sessions for a filter that filters nothing. Treat it
  // as "no cost filter": fall through to the cheap DB-paginated path. (A cost
  // sort, handled above, still reconciles regardless.)
  if (isExhaustiveCostFilter(filters.costBuckets)) {
    return false;
  }
  // ISS-4481: the selectable Unknown/missing-cost option also filters on the
  // DISPLAYED value — a row whose stored rollup is 0 but whose RECONCILED per-event
  // cost is > 0 renders a `$` figure, so it is NOT unknown. Routing Unknown through
  // the reconciled path makes the "—" filter match the "—" render exactly, the same
  // reconciled-cost basis the numeric buckets use.
  if (costFilterIncludesUnknown(filters.costBuckets)) {
    return true;
  }
  // Only a CANONICAL cost bucket makes the query cost-sensitive. An unknown-only
  // `costBuckets` (a stale/legacy id) normalizes to zero buckets, which is "no
  // cost filter" — it must NOT route through the reconciled path (where an
  // unknown id would otherwise match nothing and return an empty page), matching
  // `buildCostBucketWhere`'s skip-unknown contract on the DB path (FEA-4276
  // shafty review).
  return normalizeCostBucketIds(filters.costBuckets).length > 0;
}

/**
 * FEA-4276 (shafty review): reduce a raw `costBuckets` query array to the
 * canonical, de-duplicated bucket ids, preserving first-seen order. Unknown ids
 * (stale/legacy values, typos, arbitrary repeats) are dropped, so:
 *   - an unknown-ONLY array normalizes to `[]` ("no cost filter"), never an
 *     empty result — the same skip-unknown contract `buildCostBucketWhere` uses;
 *   - repeated arbitrary values collapse to at most the four canonical ids, so a
 *     caller can't multiply the in-memory reconciled filter pass with junk input.
 * Both the sensitivity gate and `reconcileAndOrderByCost` normalize through this
 * one helper so the reconciled path and the DB path treat bucket ids identically.
 */
export function normalizeCostBucketIds(
  buckets: readonly string[] | undefined
): SessionCostBucketId[] {
  if (!buckets || buckets.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: SessionCostBucketId[] = [];
  for (const bucketId of buckets) {
    if (seen.has(bucketId)) {
      continue;
    }
    seen.add(bucketId);
    const bucket = getSessionCostBucket(bucketId);
    if (bucket) {
      normalized.push(bucket.id);
    }
  }
  return normalized;
}

/**
 * A candidate session narrowed to just what cost reconciliation needs: its id,
 * the stored rollup fallback, the rollup input+output token total (the
 * completeness reference for the per-event token cross-check — see
 * `reconcileSessionCost`), and the `sessionUpdatedAt` tiebreaker that
 * `buildAgentSessionOrderBy`'s cost sort uses after `estimatedCost`.
 */
export type CostReconcileCandidate = {
  artifactId: string;
  storedRollup: number;
  rollupTokenTotal: number;
  sessionUpdatedAt: Date | null;
  /**
   * The session's billing mode, serving two cost readers. The cost sort uses it
   * to tell a real subscription `$0.00` (a displayed value) from a `—` (blank)
   * row (shafty thread — see {@link resolveCostSortKey}). The FEA-4294
   * cost-bucket filter uses it to tell a KNOWN $0 (a subscription session, which
   * still displays a `$` figure) from an UNKNOWN cost (renders "—"), excluding
   * the latter from numeric buckets (see `sessionCostIsNumeric`). Null → treated
   * as non-subscription.
   */
  billingMode: string | null;
  /**
   * ISS-4481: the session's substantive-work counts (turns/tokens/tool-uses).
   * The numeric-vs-unknown predicate gates on measurable work BEFORE billing mode
   * (mirroring the display authority `deriveCostAvailability`), so a no-work
   * subscription session is Unknown ("—"), not a fabricated "$0.00". Passed into
   * `matchesUnknownCost` / `sessionCostIsNumeric` so the reconciled cohort filters
   * on the SAME empty-session boundary the Cost cell renders.
   */
  substantiveCounts: SessionSubstantiveCounts;
};

/** A candidate paired with its reconciled captured cost. */
export type ReconciledCandidate = CostReconcileCandidate & {
  reconciledCost: number;
};

/**
 * FEA-4276: resolve the reconciled captured cost for every candidate row, then
 * apply cost-bucket filtering and cost ordering on THAT value (not the stale
 * rollup) so the filtered/sorted/paginated set matches what the list displays.
 *
 * `costAuthorityById` is the batched per-event aggregate
 * (`getReconciledCostsBySessionId`); rows absent from it have no per-event stream
 * and fall back to their stored rollup, exactly like `reconcileSessionCost`.
 *
 * Ordering, after bucket filtering, is one of three cases:
 *   - `sortByCost`: re-order by reconciled cost with `sessionUpdatedAt desc`
 *     then the unique `artifactId` as the stable tiebreaker — mirroring the DB
 *     cost order-by (FEA-4329).
 *   - `postFilterCompare` supplied (a canonical `costBuckets` filter composed
 *     with a display-value sort — Owner/Duration): re-order the cost-FILTERED
 *     survivors by that comparator, so the requested display sort is honored
 *     instead of being silently dropped (thread #1/#4). Cost is the filter; the
 *     display value is the order.
 *   - neither: preserve the caller-supplied DB order (the candidates were
 *     already fetched in the requested non-cost column order), so a cost-bucket
 *     filter can compose with a DB-native non-cost sort without disturbing it.
 *
 * `sortByCost` and `postFilterCompare` are mutually exclusive by construction (a
 * single `sortBy` is either `cost` or a display-value column, never both); if
 * both were somehow set, `sortByCost` wins.
 */
export function reconcileAndOrderByCost<
  T extends CostReconcileCandidate = CostReconcileCandidate,
>(
  candidates: readonly T[],
  costAuthorityById: SessionCostAuthorityMap,
  options: {
    costBuckets?: readonly string[];
    sortByCost: boolean;
    dir: "asc" | "desc";
    /**
     * Optional comparator applied to the cost-FILTERED survivors when the query
     * is NOT a cost sort — used to honor a display-value sort (Owner/Duration)
     * composed with a cost-bucket filter (thread #1/#4). Receives the widened
     * candidate `T`, so the caller closes it over the display columns it added.
     */
    postFilterCompare?: (a: T, b: T) => number;
  }
): (T & { reconciledCost: number })[] {
  const reconciled = candidates.map((candidate) => {
    const authority = costAuthorityById.get(candidate.artifactId);
    const reconciledCost = reconcileSessionCost({
      tokenEventCount: authority?.count ?? 0,
      pricedEventCount: authority?.pricedCount ?? 0,
      tokenEventCostSum: authority?.sum ?? 0,
      tokenEventTokenSum: authority?.tokenSum ?? 0,
      rollupTokenTotal: candidate.rollupTokenTotal,
      storedRollup: candidate.storedRollup,
    });
    return { ...candidate, reconciledCost };
  });

  // Normalize to canonical, de-duped bucket ids so an unknown-only filter is a
  // no-op (not an empty result) and repeated junk can't multiply this pass —
  // the same skip-unknown contract `buildCostBucketWhere` uses on the DB path
  // (FEA-4276 shafty review). ISS-4481: the selectable Unknown option is NOT a
  // numeric bucket, so it is read off the raw filter separately.
  const buckets = normalizeCostBucketIds(options.costBuckets);
  const includeUnknown = costFilterIncludesUnknown(options.costBuckets);
  const filtered =
    buckets.length > 0 || includeUnknown
      ? reconciled.filter((candidate) =>
          matchesCostFilter(candidate, buckets, includeUnknown)
        )
      : reconciled;

  if (options.sortByCost) {
    return [...filtered].sort((a, b) =>
      compareByReconciledCost(a, b, options.dir)
    );
  }
  // A cost-bucket filter composed with a display-value sort: order the
  // cost-filtered survivors by the requested display comparator (thread #1/#4).
  if (options.postFilterCompare) {
    const compare = options.postFilterCompare;
    return [...filtered].sort((a, b) => compare(a, b));
  }
  return filtered;
}

/**
 * The DISPLAYED cost value for sorting, or `null` when the Cost cell renders `—`
 * (a blank) rather than a figure. The cell shows `—` for the `Unavailable` and
 * `NoUsage` availabilities — i.e. a NON-subscription session whose reconciled
 * cost is 0 (`deriveCostAvailability` in `packages/app` renders a value only for
 * `Available`, which requires cost > 0, or `Subscription`, which always shows a
 * figure even at $0.00). Mirroring that here keeps a subscription `$0.00` sorting
 * as a real 0 while the blank `—` rows sort LAST in both directions, instead of
 * all three colliding at numeric 0 (shafty thread). SSOT-aligned: the `—`
 * predicate is exactly `deriveCostAvailability`'s non-Available/non-Subscription
 * branch, expressed with the shared `isSubscriptionBillingMode`.
 */
function resolveCostSortKey(candidate: ReconciledCandidate): number | null {
  if (isSubscriptionBillingMode(candidate.billingMode)) {
    return candidate.reconciledCost;
  }
  if (candidate.reconciledCost > 0) {
    return candidate.reconciledCost;
  }
  return null;
}

/**
 * Order two reconciled candidates by the DISPLAYED cost in the requested
 * direction. Blank `—` rows ({@link resolveCostSortKey} → null) sort LAST in BOTH
 * directions (FEA-4330 semantics), never interleaved with a real `$0.00`. Ties
 * break on `sessionUpdatedAt` descending, then the unique `artifactId` descending
 * — the FEA-4329 stable tiebreaker — so equal-value rows still paginate
 * deterministically (thread #7).
 */
function compareByReconciledCost(
  a: ReconciledCandidate,
  b: ReconciledCandidate,
  dir: "asc" | "desc"
): number {
  const aKey = resolveCostSortKey(a);
  const bKey = resolveCostSortKey(b);
  if (aKey === null || bKey === null) {
    if (aKey === bKey) {
      return compareByCostTiebreaker(a, b);
    }
    // Present value always precedes a blank, regardless of direction.
    return aKey === null ? 1 : -1;
  }
  if (aKey !== bKey) {
    const delta = aKey - bKey;
    return dir === "asc" ? delta : -delta;
  }
  return compareByCostTiebreaker(a, b);
}

/**
 * FEA-4329 tiebreaker for the cost sort: `sessionUpdatedAt` descending, then the
 * unique `artifactId` descending, so equal-cost + equal-timestamp rows still get
 * a total, deterministic order (thread #7).
 */
function compareByCostTiebreaker(
  a: ReconciledCandidate,
  b: ReconciledCandidate
): number {
  const aUpdated = a.sessionUpdatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bUpdated = b.sessionUpdatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  if (a.artifactId === b.artifactId) {
    return 0;
  }
  return a.artifactId < b.artifactId ? 1 : -1;
}

/**
 * ISS-4481: does a reconciled candidate satisfy the selected Cost filter? The
 * dimension composes OR-within (any selected option matches), so a row passes
 * when either:
 *   - the Unknown option is selected and the row's RECONCILED cost is unknown
 *     (renders "—" — non-subscription, non-positive), or
 *   - a numeric bucket is selected, the row has a KNOWN numeric cost (FEA-4294 —
 *     a "—" row's placeholder 0 must never satisfy "≤ $1"), and that cost falls
 *     in one of the selected buckets on its DISPLAYED (2dp) value (FEA-4293).
 * Unknown and the numeric buckets are mutually exclusive per row (a cost is
 * either numeric or unknown), so the two branches never double-count.
 */
function matchesCostFilter(
  candidate: ReconciledCandidate,
  buckets: readonly SessionCostBucketId[],
  includeUnknown: boolean
): boolean {
  const signals = {
    estimatedCost: candidate.reconciledCost,
    billingMode: candidate.billingMode,
    ...candidate.substantiveCounts,
  };
  if (includeUnknown && matchesUnknownCost(signals)) {
    return true;
  }
  if (buckets.length === 0) {
    return false;
  }
  return (
    sessionCostIsNumeric(signals) &&
    buckets.some((bucketId) =>
      matchesCostBucket(candidate.reconciledCost, bucketId)
    )
  );
}
