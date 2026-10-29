import type { Prisma } from "@repo/database";
import type { SessionUsageInput } from "./records";
import { buildUsageSummaryWhere } from "./usage-summary-where";

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
 * — the overwhelmingly common read — is therefore byte-identical to before.
 *
 * A dimension the user HAS filtered on costs a `buildUsageSummaryWhere`
 * re-composition per facet, bounded by how many facets the user has actually
 * operated (0 on the common read, rarely above 2).
 *
 * ISS-7176 removed the cost-bucket half of this cost entirely: a cost bucket is
 * now an ordinary `estimated_cost` predicate `buildUsageSummaryWhere` composes
 * directly, with no candidate scan and no reconciliation to keep in sync across
 * facets. ISS-10150 (`quality`) and ISS-10753 (`statuses`) did the same for the
 * two remaining D13 facets — `resolveFacetCohort` no longer exists, and no
 * facet resolves through a capped cohort scan any more.
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
  dateField: "sessionStartedAt" | "lastActivityAt" = "lastActivityAt"
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
      const relaxed = await buildUsageSummaryWhere(
        { ...input, filters: omitFacetDimension(input.filters, dimension) },
        dateField
      );
      return [dimension, relaxed] as const;
    })
  );
  return Object.fromEntries(entries) as SessionFacetCountWheres;
}
