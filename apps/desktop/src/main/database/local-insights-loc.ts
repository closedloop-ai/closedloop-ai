/**
 * Captured-PR lines-of-change resolution for the desktop-local Delivery
 * insights.
 *
 * This is the local SSOT for turning the per-PR LOC projection rows into the
 * "KLOC captured" total, the "Median PR size" population, the KLOC-over-time
 * buckets, the coverage exclusion that says how much of the population the
 * projection could not size, and the four Delivery KPIs built from them.
 * Extracted from `local-insights.ts` — grandfathered and shrink-only at the
 * time — under ISS-5412 so the cohesive LOC logic lives in one module, mirroring
 * the cloud
 * read service's `apps/api/app/insights/merged-pr-loc.ts` split, whose
 * null-preserving contract this file follows.
 *
 * Two populations, deliberately different, both derived in SQL by
 * `computeDelivery`'s LOC projection:
 *
 * - **enriched** (BOTH line counts present — AND) is the size-known population.
 *   Only these have a usable per-PR size, so only these median.
 * - **sized** (EITHER line count present — OR) is the population the COALESCE'd
 *   `loc` sum can actually see. A half-projected row still contributes its
 *   known side to the sum, so it IS evidence the sum read even though its total
 *   size is unknown. When NOTHING is sized the sum is vacuously 0, and the KLOC
 *   total is UNKNOWN rather than a real zero.
 */

import type { KpiStat } from "@closedloop-ai/loops-api/insights";
import {
  comparableKpi,
  KpiFormat,
  kpi,
  SizeCoveragePopulation,
  withSizeCoverage,
} from "@closedloop-ai/loops-api/insights";
import { median, round } from "@repo/api/src/utils/math";
import { numberOrZero as num } from "./db-helpers.js";

/** One captured-PR LOC row, as the current-window projection selects it. */
export type CapturedPrLocRow = {
  loc: bigint | number;
  enriched: bigint | number;
  sized: bigint | number;
  day: string;
};

/** One captured-PR LOC row from the prior window (no day bucket needed). */
export type PriorPrLocRow = {
  loc: bigint | number;
  enriched: bigint | number;
};

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

/**
 * FEA-2944: round a KLOC (thousands-of-lines) value to one decimal, the single
 * canonical KLOC rounding shared with the cloud dashboard's `round(x, 1)` in
 * apps/api/app/insights/merged-pr-loc.ts. Both the "KLOC captured" KPI and its
 * trend pass thousands-of-lines through this so the two surfaces (and the KPI
 * vs. its own trend) can never print a different KLOC for the same underlying
 * lines. Delegates to the canonical `round` helper in @repo/api/src/utils/math
 * rather than re-implementing the round-to-decimals pattern.
 */
export function roundKloc(value: number): number {
  return round(value, 1);
}

/**
 * FEA-2038 / FEA-2868 / FEA-2923 / ISS-5412 — the current window's LOC figures.
 *
 * KLOC sums over ALL captured PRs (an un-enriched PR folds in as 0 via the
 * projection's COALESCE, which leaves a sum unchanged), while the median is
 * taken over ENRICHED PRs only — folding un-enriched PRs in as 0 was dragging
 * the Delivery median toward 0 and disagreeing with the Branches list, which
 * uses the same enriched-only rule (FEA-2949).
 *
 * ISS-5412: a window where NO captured PR carries line counts has an UNKNOWN
 * KLOC, not a KLOC of zero — `roundKloc(0 / 1000)` rendered "0.0 thousands of
 * lines changed in captured PRs" over PRs that certainly changed lines, the
 * unavailable-as-real-zero conflation the shared insights rules forbid. `null`
 * renders `—` (formatKpiValue), exactly as cloud's twin does
 * (`knownLocValues.length > 0 ? … : null`), so the same missing data no longer
 * reads `0.0` in Local mode and `—` in Cloud mode. Once SOME PR is sized the
 * sum is a genuine (possibly partial) figure and still reports, with
 * `prsWithoutKnownSize` carrying how much of the population it could not size.
 *
 * An EMPTY window (no captured PRs at all) is `null` too, not `0.0`, for the
 * same reason cloud's twin returns null on an empty population: the tile is a
 * measurement of captured PRs, and there is nothing to measure. It dashes
 * alongside its already-nullable row neighbours — "Median PR size" (FEA-2923)
 * and "Merge rate" (FEA-3217) — rather than being the one tile on the row
 * asserting a figure over an empty cohort.
 */
export function capturedPrLocTotals(
  rows: readonly CapturedPrLocRow[]
): CapturedPrLocTotals {
  const totalLoc = sumLoc(rows);
  const sizedPrCount = rows.filter((row) => num(row.sized) === 1).length;
  const enrichedPrCount = rows.filter((row) => num(row.enriched) === 1).length;
  return {
    totalLoc,
    klocCaptured: sizedPrCount > 0 ? roundKloc(totalLoc / 1000) : null,
    medianPrSize: enrichedMedian(rows),
    scanned: rows.length,
    prsWithoutKnownSize: rows.length - enrichedPrCount,
  };
}

/**
 * Prior-window equivalents for the period-over-period deltas.
 *
 * The KLOC delta is computed in RAW LINES (see the `kloc` KPI) — the ratio is
 * unit-invariant, but comparing in lines keeps a small-but-real prior (e.g. 900
 * lines / 0.9 KLOC) above the near-zero-count floor.
 *
 * FEA-2868 (thread 1): the prior median stays NULLABLE. When the prior window
 * has no enriched PRs, `median()` returns null and it must NOT be coerced to 0
 * — a 0 baseline would surface a bogus +100% PR-size delta against a baseline
 * that does not exist.
 */
export function priorPrLocTotals(rows: readonly PriorPrLocRow[]): {
  totalLoc: number;
  medianPrSize: number | null;
} {
  return { totalLoc: sumLoc(rows), medianPrSize: enrichedMedian(rows) };
}

/**
 * FEA-2944: accumulate raw thousands-of-lines per day, then round each day to
 * one decimal at emit — matching both the KLOC KPI and the cloud KLOC trend
 * (`bucketKlocByDay`, which rounds `round(dayTotal, 1)`). Emitting the
 * unrounded `loc / 1000` was a THIRD rounding that disagreed with the desktop
 * KPI's own headline number.
 */
export function klocByDay(
  rows: readonly CapturedPrLocRow[]
): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + num(row.loc) / 1000);
  }
  for (const [day, dayKloc] of byDay) {
    byDay.set(day, roundKloc(dayKloc));
  }
  return byDay;
}

function sumLoc(rows: readonly { loc: bigint | number }[]): number {
  return rows
    .map((row) => num(row.loc))
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);
}

// FEA-2923: when NO captured PR in the window is LOC-enriched (all sizes
// unknown) there is nothing to take a median over — `null` so the KPI renders
// `—` instead of a misleading 0. `null` (not a non-finite number) keeps the
// value JSON-serializable and matches the `KpiStat.value: number | null`
// contract.
function enrichedMedian(
  rows: readonly { loc: bigint | number; enriched: bigint | number }[]
): number | null {
  const enriched = rows
    .filter((row) => num(row.enriched) === 1)
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  return enriched.length > 0 ? (median(enriched) ?? 0) : null;
}

/** The Delivery KPIs derived wholly from {@link CapturedPrLocTotals}. */
export type CapturedLocKpis = {
  kloc: KpiStat;
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
 * Cloud has no such row: `mergedPrLoc` nulls a half-projected row outright.
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
    prSize: comparableKpi(
      "pr-size",
      "Median PR size",
      medianPrSize,
      KpiFormat.Number,
      coverageSub("median lines changed per captured PR"),
      deltas.prSizeDeltaPct
    ),
  };
}
