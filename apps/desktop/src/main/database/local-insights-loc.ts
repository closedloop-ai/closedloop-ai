/**
 * The captured-PR size KPIs of the desktop-local Delivery insights.
 *
 * Per-PR line counts are not stored locally (ISS-12709), so every captured PR is
 * unsized: KLOC, LOC and Median PR size are unknown (`null`), and the coverage
 * pair says all scanned PRs lack a known size.
 */

import type { KpiStat } from "@closedloop-ai/loops-api/insights";
import {
  comparableKpi,
  KpiFormat,
  kpi,
  SizeCoveragePopulation,
  withSizeCoverage,
} from "@closedloop-ai/loops-api/insights";
import { CAPTURED_LOC_LABEL } from "@repo/api/src/types/insights-loc-terminology-flag";

/** Null-preserving KLOC / median / coverage figures over one window. */
export type CapturedPrLocTotals = {
  /** Gross lines summed over the window. Raw LINES, not KLOC. */
  totalLoc: number;
  /**
   * `totalLoc` in thousands, rounded to one decimal — or `null` when NO
   * captured PR carries line counts, because then the window's KLOC is unknown.
   */
  klocCaptured: number | null;
  /** Median size over ENRICHED PRs only, or `null` when none are enriched. */
  medianPrSize: number | null;
  /**
   * Every captured PR the window's row scan covered — the denominator the size
   * coverage is a share of. ISS-5414 renders this through the two captions.
   */
  scanned: number;
  /**
   * Captured PRs the projection cannot fully size (NOT enriched — at least one
   * line count missing). The coverage exclusion, not a zero. Deliberately the
   * NOT-ENRICHED count rather than the not-sized one, matching cloud's
   * `mergedPrsWithoutLoc`: a half-projected PR contributes its known side to
   * `totalLoc` but its real size is still unknown, so a window carrying one
   * must not read as complete coverage of a figure that is only a lower bound.
   */
  prsWithoutKnownSize: number;
};

/** Totals for a window of `capturedPrCount` PRs, none of which has a known size. */
export function unsizedCapturedPrLocTotals(
  capturedPrCount: number
): CapturedPrLocTotals {
  return {
    totalLoc: 0,
    klocCaptured: null,
    medianPrSize: null,
    scanned: capturedPrCount,
    prsWithoutKnownSize: capturedPrCount,
  };
}

/** The Delivery KPIs derived wholly from {@link CapturedPrLocTotals}. */
export type CapturedLocKpis = {
  kloc: KpiStat;
  loc: KpiStat;
  prsWithoutLoc: KpiStat;
  prsScanned: KpiStat;
  prSize: KpiStat;
};

/**
 * Builds this surface's LOC-derived Delivery KPIs. `computeDelivery` splices
 * them into its list, so their order on the wire is unchanged.
 *
 * ISS-5414 mirrors cloud's PLN-1535 M4 coverage pair here, so a reader of this
 * response can tell "this surface changed this many lines" from "…this many
 * lines THAT WE CAN SEE" too. Both tiles under-report by however many captured
 * PRs never got their size fetched: `klocCaptured` folds an un-enriched PR in
 * as 0 and `medianPrSize` drops it outright. Both keys are `internal`
 * (response-only, back no tile of their own), matching cloud; they reach a
 * reader through the two captions below.
 *
 * The clause's "sized" is the ENRICHED count (`scanned - prsWithoutKnownSize`),
 * NOT this module's `sized` (OR) column. The two words deliberately differ: the
 * column asks "did the sum see anything of this row", the caption asks "is this
 * row's size KNOWN". Only the second is a coverage claim a reader can act on,
 * and it is the conservative one — a HALF-projected PR (one line count present,
 * the other NULL) contributes its present half to `totalLoc` yet is reported
 * unsized, so the caption UNDER-claims coverage of a figure that is itself only
 * a lower bound. Quoting the OR-population instead would print "sized 1 of 1"
 * over a tile showing half a PR's real size — asserting complete coverage of an
 * incomplete figure, which is what `prsWithoutKnownSize`'s contract forbids.
 * Cloud has no such row: `mergedPullRequestLoc` nulls a half-projected row
 * outright.
 *
 * The keys are `capturedPrs*`, NOT cloud's `mergedPrs*`, even though the pair
 * plays the same role on both surfaces. A `merged`-prefixed insights key is a
 * standing promise of identical merged-PR semantics across producers — that is
 * the whole reason FEA-2946/FEA-2947 added `mergedCount` and `mergedKloc`
 * beside desktop's captured-population `merged` and `kloc` tiles. This
 * surface's KLOC and Median-PR-size tiles measure CAPTURED PRs, so a
 * `mergedPrsScanned` emitted here would hand a cross-surface consumer the exact
 * key-means-two-populations trap those keys exist to prevent. Naming it for
 * what it counts costs a consumer one extra key to read and cannot mislead one
 * that reads only the other.
 */
export function capturedLocKpis(
  {
    totalLoc,
    klocCaptured,
    medianPrSize,
    scanned,
    prsWithoutKnownSize,
  }: CapturedPrLocTotals,
  deltas: { klocDeltaPct: number | null; prSizeDeltaPct: number | null }
): CapturedLocKpis {
  const coverageSub = (sub: string) =>
    withSizeCoverage(
      sub,
      scanned,
      prsWithoutKnownSize,
      SizeCoveragePopulation.Captured
    );
  return {
    kloc: comparableKpi(
      "kloc",
      "KLOC captured",
      klocCaptured,
      KpiFormat.Number,
      coverageSub("thousands of lines changed in captured PRs"),
      deltas.klocDeltaPct
    ),
    // ISS-8184: the raw-line twin of `kloc`, backing the same tile under the LOC
    // terminology flag. `totalLoc` rather than `klocCaptured * 1000` — the
    // latter is rounded to one decimal, which would round-trip a line count to
    // the nearest hundred — but it inherits `klocCaptured`'s null, so an
    // unsizable window still dashes on both vocabularies rather than one of them
    // asserting a measured 0. The delta is a PERCENTAGE and so scale-invariant,
    // which is why both tiles can report the same one.
    loc: comparableKpi(
      "loc",
      CAPTURED_LOC_LABEL,
      klocCaptured === null ? null : totalLoc,
      KpiFormat.Number,
      coverageSub("lines changed in captured PRs"),
      deltas.klocDeltaPct
    ),
    // ISS-5412: the KLOC tile's coverage exclusion — captured PRs the local
    // projection cannot fully size (at least one line count missing), so a
    // reader can tell a partial KLOC from a complete one. Mirrors cloud's
    // `mergedPrsWithoutLoc` (apps/api/app/insights/merged-pr-loc.ts), both in
    // its BOTH-counts-required rule and in its population rule: the count is
    // taken of the SAME captured-PR population the KLOC sum is taken of, not of
    // the `merged` tile's authored-merged count, so "3 without size" can never
    // be read against a denominator it does not belong to. Flagged `internal`:
    // response-only, backs no tile. Plain `kpi()` — no prior-window figure is
    // computed for it, so its `deltaPct` stays null and declares
    // `KpiDeltaBasis.NotComputed`.
    prsWithoutLoc: kpi(
      "capturedPrsWithoutLoc",
      "Captured PRs without size",
      prsWithoutKnownSize,
      KpiFormat.Number,
      "captured PRs the projection cannot size",
      true
    ),
    // ISS-5414: the denominator half of the pair. Ships beside the exclusion so
    // a consumer reading the response (not the caption) can work the coverage
    // out itself. `internal` and plain `kpi()` for the same reasons.
    prsScanned: kpi(
      "capturedPrsScanned",
      "Captured PRs scanned",
      scanned,
      KpiFormat.Number,
      "captured PRs the size coverage is taken of",
      true
    ),
    // ISS-7868: the LABEL names the population, the way `kloc` above sends
    // "KLOC captured" against cloud's "KLOC merged". Both producers used to emit
    // the byte-identical "Median PR size" for two different medians — this one
    // over CAPTURED PRs, cloud's (`apps/api/app/insights/merged-pr-loc.ts`) over
    // MERGED ones — and the desktop swaps producers on auth state, so the same
    // card silently changed what it measured when a user signed in. The only
    // disclosure was this `sub`, which lives behind the info tooltip; a figure a
    // reader has to hover to interpret is one they will read wrong.
    prSize: comparableKpi(
      "pr-size",
      "Median captured PR size",
      medianPrSize,
      KpiFormat.Number,
      coverageSub("median lines changed per captured PR"),
      deltas.prSizeDeltaPct
    ),
  };
}
