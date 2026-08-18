import type { Prisma } from "@repo/database";
import type { SessionUsageInput } from "./records";
import { buildUsageSummaryWhereParts } from "./usage-summary-where";

/**
 * ISS-5283 — per-facet count scoping for the Sessions usage summary.
 *
 * ## The semantics, stated explicitly (this is a product decision, not just a query one)
 *
 * **Each facet's counts apply every OTHER active filter, but EXCLUDE its own
 * dimension.**
 *
 * Both of the alternatives are wrong, in opposite directions:
 *
 *  - *No filters on any facet* — the counts describe the unfiltered corpus while
 *    the table describes the filtered one. A user reading "Claude — 2,600" next
 *    to an empty table is told those rows are one click away; they are not.
 *
 *  - *Every filter on every facet* (what this code replaces) — selecting
 *    `Harness = Claude` makes every OTHER harness count 0, so the facet collapses
 *    to the single value already chosen and the user can never switch or widen.
 *    A single-select facet becomes a one-way door. This is the WORSE bug: the
 *    first merely misinforms, this one removes function.
 *
 * Excluding only the facet's own dimension gives both halves of the acceptance:
 * selecting an Owner with no Claude sessions correctly zeroes Harness→Claude
 * (every other filter still applies), while every harness the user could switch
 * to stays listed with the count it WOULD yield.
 *
 * ## What it costs
 *
 * A dimension that carries no active filter has an "excluding" `where` that is
 * by definition identical to the full one, so this returns the caller's already
 * built `where` unchanged and issues no extra query. An unfiltered Sessions page
 * — the overwhelmingly common read — is therefore byte-identical to before,
 * including under the cost-bucket reconciliation path in
 * `buildUsageSummaryWhere`, whose candidate scan is NOT re-run for a dimension
 * that resolves to the base `where`.
 *
 * A dimension the user HAS filtered on costs a `buildWhere` re-composition, and
 * — on a cost-sensitive query — a second capped candidate scan plus its
 * reconciled-cost read, up to four of them per summary read. That is a real
 * cost, not a free path (stage review); it is bounded by how many facets the
 * user has actually operated, which is 0 on the common read and rarely above 2.
 *
 * ## Reconciling the cost path's cap (stage review)
 *
 * `resolveCostBucketMatchedSessionIds` scans at most
 * `SESSION_COST_RECONCILE_CANDIDATE_CAP` candidates, ordered by recency, and
 * honestly drops the rest. The relaxed scan runs over a strictly WIDER
 * population than the fully-filtered one, so on an org that clears the cap the
 * two truncate different tails — and the facet could then advertise FEWER
 * sessions for the selection the table and the cards are already showing, a
 * count that fails to reconcile with its own parent population. So the relaxed
 * id set is UNIONED with the fully-filtered one the totals use. The union can
 * only add rows that also satisfy the full filter, i.e. rows under the
 * CURRENTLY SELECTED option, so it restores that option's count to at least the
 * parent total and leaves every other option's count untouched.
 *
 * ## What is deliberately NOT excluded
 *
 * The Owner facet clears `userIds` — the facet the Sessions toolbar operates —
 * but NEVER `userId` or `viewerScope`. On the Sessions page `userId` is the
 * pinned cross-surface cohort FEA-4304/FEA-3534 documented as an AND constraint
 * the Owner facet is not permitted to widen; dropping it would reintroduce
 * exactly the cross-user leak FEA-4304 closed, with the UI badge still claiming
 * the scope was intact.
 *
 * That makes the rule at the top of this file specifically the **Sessions
 * `userIds` facet's** rule, and it is stated that way on purpose (stage review).
 * Analytics (`agent-telemetry-analytics.tsx`) operates its User Breakdown by
 * sending the clicked owner as `sharedFilters.userId` and reading `usage.byUser`
 * — so on THAT surface the owner breakdown still collapses to the selected row.
 * This file does not change that (it behaved the same before), and it does not
 * claim to: separating a user-operated `userId` from the pinned scope is a
 * change to the Analytics query contract, not to this predicate.
 *
 * The date window, quality, team scope, and the autonomy/cost/change/PR clauses
 * likewise stay on every facet: none of them is the counted dimension.
 */

/** The Sessions facets whose option counts come from a server-side aggregate. */
export const SessionFacetDimension = {
  Owner: "owner",
  Harness: "harness",
  Model: "model",
  Repository: "repository",
  Project: "project",
} as const;
export type SessionFacetDimension =
  (typeof SessionFacetDimension)[keyof typeof SessionFacetDimension];

type SessionFacetFilters = SessionUsageInput["filters"];

/**
 * The `where` each facet's aggregate runs under, keyed by dimension. A
 * dimension with no active filter maps to the SAME object reference as the
 * caller's `where`, which is what makes the unfiltered read free.
 */
export type SessionFacetCountWheres = Record<
  SessionFacetDimension,
  Prisma.SessionDetailWhereInput
>;

/**
 * True when the user has actually operated this facet. Drives the reuse
 * optimization above AND keeps the semantics honest: a facet nobody filtered
 * needs no exclusion, because there is nothing of its own to exclude.
 *
 * `harness` is checked alongside `harnesses` because the query builder still
 * honors the legacy single-value field (version-skewed clients serialize it);
 * excluding only the plural form would leave a live harness predicate in the
 * harness facet's own count and silently keep the collapse bug for those
 * clients.
 */
function isFacetDimensionFiltered(
  filters: SessionFacetFilters,
  dimension: SessionFacetDimension
): boolean {
  if (dimension === SessionFacetDimension.Owner) {
    return (filters.userIds?.length ?? 0) > 0;
  }
  if (dimension === SessionFacetDimension.Harness) {
    return (filters.harnesses?.length ?? 0) > 0 || filters.harness != null;
  }
  if (dimension === SessionFacetDimension.Model) {
    return (filters.models?.length ?? 0) > 0;
  }
  if (dimension === SessionFacetDimension.Project) {
    // ISS-5355: only the multi-select facet is the Project facet's OWN
    // dimension. The singular `projectId` is a caller-supplied scope (the
    // project detail strip's destination), so — like Owner's `userId` — it
    // survives exclusion and keeps the relaxed count inside the scope.
    return (filters.projectIds?.length ?? 0) > 0;
  }
  return (filters.repositories?.length ?? 0) > 0;
}

/**
 * The caller's filters with ONE dimension's facet selection removed. Filter
 * -object surgery, not `where`-object surgery — the same idiom
 * `buildIdleCountWhere` and the cost-bucket path already use, so the excluded
 * variant goes through the identical `buildWhere` composition and cannot drift
 * from the list predicate.
 */
function omitFacetDimension(
  filters: SessionFacetFilters,
  dimension: SessionFacetDimension
): SessionFacetFilters {
  if (dimension === SessionFacetDimension.Owner) {
    // `userId` / `viewerScope` intentionally survive — see the module doc.
    return { ...filters, userIds: undefined };
  }
  if (dimension === SessionFacetDimension.Harness) {
    return { ...filters, harness: undefined, harnesses: undefined };
  }
  if (dimension === SessionFacetDimension.Model) {
    return { ...filters, models: undefined };
  }
  if (dimension === SessionFacetDimension.Project) {
    // `projectId` intentionally survives — see `isFacetDimensionFiltered`.
    return { ...filters, projectIds: undefined };
  }
  return { ...filters, repositories: undefined };
}

/**
 * Build every facet `where` for a usage-summary read. `where` is the fully
 * filtered predicate the summary TOTALS use — those still describe the current
 * view and are not relaxed here; only the per-option facet counts are.
 */
export async function buildSessionFacetCountWheres(
  input: SessionUsageInput,
  where: Prisma.SessionDetailWhereInput,
  dateField: "sessionStartedAt" | "lastActivityAt" = "lastActivityAt",
  /**
   * The reconciled cost-matched id set the summary TOTALS are scoped to, from
   * `buildUsageSummaryWhereParts`. `null` on a non-cost-sensitive query. Used to
   * keep a relaxed facet count from falling below its own parent when the
   * candidate cap bites — see the module doc.
   */
  costMatchedIds: string[] | null = null
): Promise<SessionFacetCountWheres> {
  const dimensions = [
    SessionFacetDimension.Owner,
    SessionFacetDimension.Harness,
    SessionFacetDimension.Model,
    SessionFacetDimension.Repository,
    SessionFacetDimension.Project,
  ] as const;
  const entries = await Promise.all(
    dimensions.map(async (dimension) => {
      if (!isFacetDimensionFiltered(input.filters, dimension)) {
        // No filter on this dimension ⇒ the excluded where IS the full where.
        return [dimension, where] as const;
      }
      const relaxed = await buildUsageSummaryWhereParts(
        { ...input, filters: omitFacetDimension(input.filters, dimension) },
        dateField
      );
      return [dimension, unionCostMatchedIds(relaxed, costMatchedIds)] as const;
    })
  );
  return Object.fromEntries(entries) as SessionFacetCountWheres;
}

/**
 * Widen a relaxed cost-sensitive `where` so its `artifactId IN (…)` also carries
 * every id the fully-filtered totals counted. See "Reconciling the cost path's
 * cap" in the module doc. A non-cost-sensitive relaxed build has no id set to
 * union and is returned unchanged.
 */
function unionCostMatchedIds(
  relaxed: {
    where: Prisma.SessionDetailWhereInput;
    costMatchedIds: string[] | null;
  },
  costMatchedIds: string[] | null
): Prisma.SessionDetailWhereInput {
  if (relaxed.costMatchedIds === null || costMatchedIds === null) {
    return relaxed.where;
  }
  const merged = [...new Set([...relaxed.costMatchedIds, ...costMatchedIds])];
  if (merged.length === relaxed.costMatchedIds.length) {
    // The relaxed scan already covered the filtered one — nothing to widen.
    return relaxed.where;
  }
  // `buildUsageSummaryWhereParts` composes exactly `AND: [baseWhere, { artifactId: { in } }]`
  // on the cost path, so rebuilding that pair here keeps the shape it produced.
  const [baseWhere] = Array.isArray(relaxed.where.AND)
    ? relaxed.where.AND
    : [relaxed.where];
  return { AND: [baseWhere, { artifactId: { in: merged } }] };
}
