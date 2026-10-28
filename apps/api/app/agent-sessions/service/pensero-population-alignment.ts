import "server-only";

/**
 * ISS-11117 — whether a Sessions usage request's two Pensero terms describe the
 * same population.
 *
 * ## The defect
 *
 * The Sessions points ratio divides a points total keyed on BRANCHES by
 * `resolveLocPerDollarCostBasis`, which is the cost of the SESSIONS this
 * request matched. The branch population is the attribution lens's, so it
 * already narrows with the filters — but each branch in it keeps every point
 * attributed to it, whichever session earned them.
 *
 * So whenever a filter excludes some sessions that touched an included branch,
 * the divisor shrinks and the numerator does not: pick one owner, one model,
 * one repository, and the branch's reviewers' and other harnesses' spend leaves
 * the denominator while their delivery points stay in the numerator
 * (chatgpt-codex-connector, PR #7863). The ratio comes out HIGH by an amount
 * nothing on screen can show.
 *
 * ## The DATE axis is not this module's, because it is reconcilable
 *
 * A date range narrows both terms and is carried rather than refused: the
 * delivery fold sums only the shares the provider dated inside the request's
 * window (`DeliveryPointWindow`), so numerator and divisor cover one period.
 * What is left here is the axis no window can reconcile — the numerator is
 * branch-keyed and the divisor is session-keyed, so a facet that splits a
 * branch's sessions has no counterpart in the points total at all.
 *
 * For that axis the answer is to publish only when the two terms agree, and
 * render LOC/$ otherwise — the AC2 fallback, unchanged, with the LOC number the
 * reader can already see left in place.
 *
 * ## Why an exhaustive Record and not a list of facet names
 *
 * A `ReadonlySet<string>` of "narrowing params" is the side inventory this repo
 * loses to: a new facet is added to the query schema, nothing names it here, it
 * falls through as non-narrowing, and the ratio silently starts lying for that
 * filter. {@link SESSIONS_PENSERO_POPULATION_NARROWING} is typed
 * `Record<keyof AgentSessionUsageQuery, boolean>`, so a new query param fails
 * `tsc` in this file until someone classifies it.
 */

import type { AgentSessionUsageQuery } from "../validators";

/**
 * For each usage query param, whether supplying it can narrow the SESSION
 * population without narrowing the branch-lifetime points numerator.
 *
 * `true` for every predicate that reaches `buildWhere`. `false` only for params
 * that this rule must not refuse on: the two date bounds narrow the NUMERATOR
 * too (`penseroDeliveryWindow` carries them into the delivery fold), so they
 * leave the two terms aligned; `comparison` opts into a second read and changes
 * no predicate; `search` is accepted for version-skewed clients and is not
 * implemented server-side; and `viewerScope`/`teamId` are a pair whose
 * narrowing is carried by `teamId`.
 */
const SESSIONS_PENSERO_POPULATION_NARROWING: Record<
  keyof AgentSessionUsageQuery,
  boolean
> = {
  startDate: false,
  endDate: false,
  comparison: false,
  // ISS-11204: a response-shape opt-out. It selects no session rows, so it
  // cannot part the two terms — but it DOES empty the branch population the
  // numerator is read over, which `usage-summary.ts` handles by hydrating the
  // lens anyway when a Pensero reader is present.
  attribution: false,
  search: false,
  viewerScope: false,
  completedAfter: true,
  componentSlug: true,
  harness: true,
  status: true,
  statuses: true,
  userId: true,
  userIds: true,
  repositories: true,
  harnesses: true,
  models: true,
  autonomyTiers: true,
  costBuckets: true,
  changePresence: true,
  prAssociation: true,
  priorities: true,
  quality: true,
  teamId: true,
  projectId: true,
  projectIds: true,
};

/**
 * True when nothing in this request narrows the session population away from
 * the branch lifetimes the numerator sums.
 *
 * An EMPTY array counts as absent: the facets serialize as arrays and a cleared
 * multi-select arrives as `[]`, which selects every row and must not withhold a
 * ratio that is perfectly aligned.
 */
export function penseroSessionPopulationIsWhole(
  query: AgentSessionUsageQuery
): boolean {
  for (const [name, narrows] of Object.entries(
    SESSIONS_PENSERO_POPULATION_NARROWING
  )) {
    if (!narrows) {
      continue;
    }
    const value = (query as Record<string, unknown>)[name];
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    return false;
  }
  return true;
}
