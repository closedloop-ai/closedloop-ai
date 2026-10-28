import type { BranchAnalyticsRollupOrganizationRow } from "@/app/branches/branch-analytics-rollup-contract";

/**
 * One row as the due-organization selection returns it, for the suites that
 * hand `refreshDueBranchAnalyticsRollups` a mocked page.
 *
 * `asOf` is required rather than defaulted: two suites previously each kept
 * their own `dueRow` under the same name and the same docstring, one dating the
 * cursor an hour back and the other at the run clock — which silently made
 * every age it produced exactly 0, the one value the summary's contract says
 * not to report. Making the caller state the age is what stops that recurring.
 */
export function dueRollupOrganizationRow(
  organizationId: string,
  asOf: Date
): BranchAnalyticsRollupOrganizationRow {
  return { organizationId, asOf, hasRollupState: true };
}

/** A row for an organization that has never been rolled up at all. */
export function neverRolledUpOrganizationRow(
  organizationId: string
): BranchAnalyticsRollupOrganizationRow {
  return { organizationId, asOf: null, hasRollupState: false };
}

/**
 * A state-carrying organization that is due but whose cursor was never stamped.
 * Distinct from the row above: it HAS state, so it is not counted as never
 * rolled up, and it still carries no age.
 */
export function unstampedRollupOrganizationRow(
  organizationId: string
): BranchAnalyticsRollupOrganizationRow {
  return { organizationId, asOf: null, hasRollupState: true };
}
