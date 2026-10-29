/**
 * ISS-8424: whether the Delivery response is entitled to state a merged-PR
 * number at all.
 *
 * `apps/api/lib/pull-request-population.ts` admits a merged PR only once
 * `lastVerifiedAt` is stamped, and on an OAuth-only org nothing stamps it
 * except the tier-2 targeted sync — there is no webhook lane. Until that has
 * run, the whole org-merged population is empty and every merged-PR figure was
 * rendering as the number `0`: a fabricated measurement of a population nobody
 * has measured, which is the value AGENTS.md's bad-data rule and PRD-683
 * Outcome 3 both exist to forbid.
 *
 * This module owns the distinction and nothing else. The census counts come
 * from `censusMergedPrVerification`; the tile-availability half is
 * `service/tiles.ts`.
 */
import type { KpiStat } from "@repo/api/src/types/insights";

/**
 * The census of this scope's SESSION-LINKED merged pull requests, over the
 * window the Delivery read is rendering.
 *
 * Two booleans rather than two counts: the only question asked of it is whether
 * each population is non-empty, and answering it with a number would both cost
 * a full scan on every Delivery read and leave a figure a later reader could
 * mistake for a measurement. See `censusMergedPrVerification`.
 */
export type MergedPrVerificationCensus = {
  /** Any session-linked merged row in the window, verified or not. */
  hasSessionLinkedMergedPrs: boolean;
  /** Any of those carrying a `lastVerifiedAt` stamp. */
  hasVerifiedMergedPrs: boolean;
};

/**
 * Every KPI key the Delivery response emits, and whether its value is derived
 * from the org-merged pull-request population.
 *
 * An exhaustive record rather than a bare key list, because a list is the shape
 * that silently widens: a new merged-PR KPI added to the response would just
 * fall through it and keep printing a fabricated `0`. Classification is
 * mandatory here and `delivery-measurement.test.ts` drives the real response to
 * assert no emitted key is missing, so adding a KPI without classifying it
 * fails a test rather than shipping a lie.
 */
export const DELIVERY_KPI_DERIVED_FROM_MERGED_PRS: Record<string, boolean> = {
  merged: true,
  mergedCount: true,
  ttm: true,
  kloc: true,
  loc: true,
  mergedKloc: true,
  mergedLoc: true,
  mergedPrsWithoutLoc: true,
  mergedPrsScanned: true,
  "pr-size": true,
  // The DECIDED cohort is merged + closed, and the closed-unmerged count in the
  // shared fold applies the same membership predicate — so an unmeasured population leaves both
  // operands unmeasured, not just the numerator.
  "merge-rate": true,
  // Session spend. Read from `agent_session_*`, never from a PR row, so it is
  // measured even when no PR has been verified.
  cost: false,
};

/**
 * True when this scope has session-linked merged pull requests and NONE of them
 * has been verified — the not-yet-measured state.
 *
 * A scope with no session-linked merged rows at all is NOT unmeasured: PRD-683
 * Rulings 1/2 make session-linkage the definition of the population, so "no
 * session-linked merged PRs" is a real measurement whose honest value is `0`.
 * Requiring `hasSessionLinkedMergedPrs` is what keeps this from turning every
 * genuinely quiet org's true zero into an em dash.
 */
export function isMergedPrPopulationUnmeasured(
  census: MergedPrVerificationCensus
): boolean {
  return census.hasSessionLinkedMergedPrs && !census.hasVerifiedMergedPrs;
}

/**
 * Replace every merged-PR-derived KPI value with `null`.
 *
 * `null` is the contract `KpiStat.value` already carries for "no computable
 * value" and the clients already render it as `—`, so this reaches the derived
 * consumers too: the shared AI-Impact card divides by the `mergedCount` and
 * `kloc` values it reads by key, and a null numerator or denominator makes its
 * cost-per-PR, tokens-per-KLOC, and top-repo derivations honest without the
 * card needing to know why.
 *
 * Non-merged-PR KPIs are returned untouched — a `$0.004` session cost is a real
 * measurement whether or not a pull request has been verified.
 */
export function withUnmeasuredMergedPrKpis(kpis: KpiStat[]): KpiStat[] {
  return kpis.map((stat) =>
    DELIVERY_KPI_DERIVED_FROM_MERGED_PRS[stat.key] === true
      ? { ...stat, value: null, deltaPct: null }
      : stat
  );
}
