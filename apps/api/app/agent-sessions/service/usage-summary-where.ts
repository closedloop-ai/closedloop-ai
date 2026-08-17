import type { Prisma } from "@repo/database";
import { isCostReconciliationSensitiveQuery } from "./cost-authority";
import { resolveCostBucketMatchedSessionIds } from "./list-page-fetch";
import { buildWhere } from "./query-builder";
import type { SessionUsageInput } from "./records";

/**
 * FEA-4293/4294 (thread wongk, table↔summary parity): build the `where` the
 * Sessions usage SUMMARY aggregates over so it paints EXACTLY the population the
 * Sessions TABLE does — including under a cost-bucket filter.
 *
 * A cost-bucket filter is applied by the table on the RECONCILED captured cost
 * (`findCostReconciledPage`), not on the stored `SessionDetail.estimatedCost`
 * rollup that `buildCostBucketWhere`'s DB predicate keys off. Those two diverge
 * for legacy rows (a row stored at `estimatedCost = 0` whose priced per-event
 * cost totals $0.42 displays under "≤ $1" in the table, but a `> 0` rollup
 * predicate drops it). If the summary restated the rollup predicate it would
 * show fewer sessions / less cost than the table for the same filter — the
 * divergence wongk flagged.
 *
 * So on a cost-sensitive query this:
 *   1. builds the base `where` with the cost-bucket clause STRIPPED (every other
 *      facet + the date window stay), identical to the table's candidate `where`;
 *   2. resolves the SAME reconciled-cost-matched session id set the table paints
 *      (`resolveCostBucketMatchedSessionIds`, same candidate scan + reconcile
 *      authority + numeric-cost/bucket filter);
 *   3. ANDs `artifactId IN (matchedIds)` onto the base `where`, so every summary
 *      aggregate is scoped to exactly that set.
 *
 * A query with no canonical cost bucket is NOT cost-sensitive and keeps the
 * plain `buildWhere` path unchanged (no extra candidate read).
 *
 * The date window defaults to `lastActivityAt` — the SAME field `findSessions`
 * and the summary/export use (ISS-4429) — so the windowed population matches
 * too. The analytics read passes `sessionStartedAt` instead (a session belongs
 * to the period it started in — see `buildWhere`), so it reuses this reconciled
 * cohort while keeping its own date semantics; otherwise its cost-bucket /
 * ISS-4481 Unknown filter would run against the stale `estimatedCost` rollup and
 * disagree with the reconciled list/usage/export cohort (thread wongk).
 */
export async function buildUsageSummaryWhere(
  input: SessionUsageInput,
  dateField: "sessionStartedAt" | "lastActivityAt" = "lastActivityAt"
): Promise<Prisma.SessionDetailWhereInput> {
  const parts = await buildUsageSummaryWhereParts(input, dateField);
  return parts.where;
}

/**
 * The same build, but also handing back the reconciled cost-matched id set (or
 * `null` on a non-cost-sensitive query, which resolves no set at all).
 *
 * ISS-5283 needs the ids, not just the composed `where`: the per-facet counts run
 * a SECOND, wider candidate scan, and that scan is bounded by the same
 * `SESSION_COST_RECONCILE_CANDIDATE_CAP` — so on an org whose in-window candidate
 * set clears the cap, the two scans truncate DIFFERENT tails and a facet could
 * advertise fewer sessions for the current selection than the table and the cards
 * already show for it. Handing the fully-filtered set to the facet builder lets it
 * union the two, which keeps every option's count at or above the parent
 * population it belongs to. See `facet-count-where.ts`.
 */
export async function buildUsageSummaryWhereParts(
  input: SessionUsageInput,
  dateField: "sessionStartedAt" | "lastActivityAt" = "lastActivityAt"
): Promise<{
  where: Prisma.SessionDetailWhereInput;
  costMatchedIds: string[] | null;
}> {
  const costSensitive = isCostReconciliationSensitiveQuery(input.filters);
  if (!costSensitive) {
    return {
      where: buildWhere(input, input.filters, dateField),
      costMatchedIds: null,
    };
  }
  // Strip `costBuckets` so `buildWhere` omits the stale-rollup `buildCostBucketWhere`
  // clause; the cost filter is re-applied on the reconciled value below, exactly as
  // the table's `findCostReconciledPage` does. This branch runs only for a
  // cost-sensitive filter — a real numeric bucket or the ISS-4481 Unknown option; a
  // stale/legacy-only array normalized to "not cost-sensitive" and never reaches here.
  const baseWhere = buildWhere(
    input,
    { ...input.filters, costBuckets: undefined },
    dateField
  );
  const matchedIds = await resolveCostBucketMatchedSessionIds({
    organizationId: input.organizationId,
    where: baseWhere,
    // Pass the RAW cost-filter array (not just the normalized numeric ids) so the
    // reconciled matcher can also read the ISS-4481 Unknown option — the summary
    // must scope to the SAME set the table paints, which now includes an
    // Unknown/missing-cost filter, not only the numeric buckets.
    costBuckets: input.filters.costBuckets ?? [],
    // thread wongk (FEA-4326): pass the filters through so the capped candidate
    // scan orders by the SAME `nonCostOrderBy(filters)` the table's cost path
    // uses. The summary/export query carries no `sortBy`, so this resolves to the
    // default `lastActivityAt` order — matching the table's default cost-path
    // candidate set, so the two cohorts can't diverge when the cap bites.
    filters: input.filters,
  });
  return {
    where: { AND: [baseWhere, { artifactId: { in: matchedIds } }] },
    costMatchedIds: matchedIds,
  };
}
