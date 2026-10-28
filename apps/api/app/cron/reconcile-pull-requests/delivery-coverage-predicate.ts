/**
 * ISS-12034: what "covered" MEANS for the PRD-683 delivery-coverage ratio, in
 * one place, because two lanes now have to agree on it.
 *
 * `delivery-coverage-metrics.ts` counts a session-linked target into
 * `enrichedOrVisiblePrCount`; `session-linked-targets.ts` selects the rows that
 * count is MISSING so the installed tier can refresh them. Those are the same
 * predicate read in opposite directions, and before this module the numerator
 * lived in TypeScript while the selector would have had to hand-copy it as SQL.
 *
 * THE SHARING IS LOAD-BEARING, NOT TIDINESS — the same reason
 * `DESKTOP_PR_FETCHABLE_FACT_COLUMNS` is a shared map rather than two column
 * lists. A hand-copied `additions IS NULL OR deletions IS NULL` drifts from
 * {@link hasCompleteDeliveryCoverageLoc} silently, and the failure is invisible
 * in both directions: a selector narrower than the numerator strands rows the
 * monitor keeps paging on, and a wider one spends provider reads on rows that
 * were already counted.
 *
 * So the LOC columns are declared once, as field/column pairs, and both sides
 * render from them: the TypeScript predicate reads `field`, the selector's SQL
 * renders `column`.
 */

/**
 * The LOC columns a target must have to count as enriched, as the Prisma field
 * and the Postgres column that back each one.
 *
 * Deliberately NOT `changedFiles`, which the self-heal arm does select on
 * (`selectSelfHealTargets`): the coverage numerator has never required it, and
 * adding it here would move a monitored Datadog series rather than fix one.
 */
export const DELIVERY_COVERAGE_LOC_FIELDS = [
  { field: "additions", column: "additions" },
  { field: "deletions", column: "deletions" },
] as const;

export type DeliveryCoverageLocField =
  (typeof DELIVERY_COVERAGE_LOC_FIELDS)[number]["field"];

export type DeliveryCoverageLocDetail = {
  [Field in DeliveryCoverageLocField]: number | null;
};

export type DeliveryCoverageDetail = DeliveryCoverageLocDetail & {
  isCurrent: boolean;
};

/** Whether every {@link DELIVERY_COVERAGE_LOC_FIELDS} column is present. */
export function hasCompleteDeliveryCoverageLoc(
  detail: DeliveryCoverageLocDetail
): boolean {
  return DELIVERY_COVERAGE_LOC_FIELDS.every(
    ({ field }) => detail[field] !== null
  );
}

/**
 * Whether a session-linked target counts into `enrichedOrVisiblePrCount`.
 *
 * `isCurrent` alone is sufficient on purpose: a row promoted to its branch's
 * current PR is visible to the product whether or not its LOC landed, and the
 * ratio has counted it since the emitter shipped.
 */
export function isDeliveryCoverageCovered(
  detail: DeliveryCoverageDetail
): boolean {
  return hasCompleteDeliveryCoverageLoc(detail) || detail.isCurrent;
}
