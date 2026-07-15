// FEA-2952 / PLN-1323 — parity-test scaffold.
//
// The whole point of the SSOT is that the cloud (Postgres) and desktop (SQLite)
// adapters, once wired in the phase-2 PRs, produce IDENTICAL KPI values from
// equivalent underlying data. `assertKpiParity` is the shared harness those PRs
// plug into: give it one (or two) NormalizedDeliveryRows fixtures and a golden
// expected map, and it asserts computeDeliveryKpis matches the golden AND — when
// a second fixture is supplied — that both fixtures agree with each other.
//
// No adapter consumes this yet (foundation-only); it exists so a phase-2 desktop/
// cloud adapter test is a two-line call rather than a re-implementation.

import { computeDeliveryKpiResult, computeDerived } from "./compute.ts";
import type { NormalizedDeliveryRows } from "./normalized-rows.ts";
import { DELIVERY_KPI_REGISTRY, DeliveryKpiKey } from "./registry.ts";

/** The value-only projection of a computed KPI set, for golden comparison. */
export type ExpectedKpiValues = Partial<Record<DeliveryKpiKey, number | null>>;

export type KpiParityResult = {
  ok: boolean;
  /** Mismatches keyed by KPI key: what was expected vs what was computed. */
  mismatches: KpiMismatch[];
};

export type KpiMismatch = {
  key: DeliveryKpiKey;
  expected: number | null;
  actual: number | null;
  /** Which side produced the mismatch — the golden, or the A↔B cross-check. */
  kind: "golden" | "cross";
};

/**
 * Compares `computeDeliveryKpis(rowsA)` against `expected` (and, when `rowsB` is
 * provided, cross-checks A vs B). Returns a structured result rather than
 * throwing, so callers can use it inside any test framework's assertion. A key
 * present in `expected` but absent from the computed set is reported as a
 * mismatch against `undefined`→null.
 *
 * The A↔B cross-check compares ALL computed values (base + internal + derived),
 * not just the public map, so a desktop/cloud discrepancy in an internal
 * building-block KPI (e.g. DecidedCount, which never surfaces publicly but drives
 * merge rate) is caught rather than being invisible.
 *
 * @param rowsA   the primary normalized fixture (e.g. the cloud adapter's output)
 * @param rowsB   optional second fixture (e.g. the desktop adapter's output) to
 *                cross-check against A; pass null/undefined to skip cross-check
 * @param expected the golden KPI values every fixture must match
 */
function assertKpiParity(
  rowsA: NormalizedDeliveryRows,
  rowsB: NormalizedDeliveryRows | null | undefined,
  expected: ExpectedKpiValues
): KpiParityResult {
  const mismatches: KpiMismatch[] = [];
  const resultA = computeDeliveryKpiResult(rowsA);

  for (const key of Object.keys(expected) as DeliveryKpiKey[]) {
    const want = expected[key] ?? null;
    const got = resultA.values.get(key) ?? null;
    if (got !== want) {
      mismatches.push({ key, expected: want, actual: got, kind: "golden" });
    }
  }

  if (rowsB) {
    const resultB = computeDeliveryKpiResult(rowsB);
    // Compare every computed value (base + internal + derived), not just the
    // public map, so an internal-KPI divergence is not hidden.
    const allKeys = new Set<DeliveryKpiKey>([
      ...resultA.values.keys(),
      ...resultB.values.keys(),
    ]);
    for (const key of allKeys) {
      const a = resultA.values.get(key) ?? null;
      const b = resultB.values.get(key) ?? null;
      if (a !== b) {
        mismatches.push({ key, expected: a, actual: b, kind: "cross" });
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * FEA-3151 — the cloud insights service's merge rate, routed through the SSOT.
 *
 * The cloud service (`apps/api/app/insights/service.ts` `getDelivery`) has only
 * scalar counts on hand — an exact DB `count()` of merged PRs and of decided
 * (merged + closed) PRs — not the materialized `NormalizedPr[]` the pure engine
 * consumes. Rather than re-derive the merge-rate formula (denominator choice,
 * scale, rounding, divide-by-zero → null) at that call site — the exact
 * cross-surface drift FEA-3118 caught — this helper reconstitutes a minimal
 * fixture from those counts and runs the ONE engine (`computeDeliveryKpiResult`),
 * reading back the registry-defined `MergeRate`. So cloud, Desktop, and Web all
 * read a single definition (`registry.ts` MergeRate = merged / (merged + closed),
 * DECIDED denominator), and any future change to that definition — denominator,
 * scale, or rounding — flows to the cloud surface automatically.
 *
 * O(1), COUNT-ONLY: merge rate is a DERIVED KPI (MergedCount ÷ DecidedCount) and
 * its two operands are pure COUNTS. Rather than expand the scalar counts into
 * `mergedCount + closedCount` synthetic rows and re-run the whole population →
 * measure → aggregate engine (unbounded per-PR CPU/heap in large/all-time
 * windows), this seeds ONLY the two base COUNT values the derived formula reads —
 * `MergedCount = mergedCount`, `DecidedCount = mergedCount + closedCount`, exactly
 * what the `count` aggregation over those populations would have produced — and
 * runs the SSOT's own `computeDerived` for the registry's MergeRate entry. The
 * formula (which base KPIs feed it, the scale, the rounding, divide-by-zero →
 * null) still comes entirely from `registry.ts` via the shared engine, so any
 * future change to the definition flows here automatically. Returns the SSOT
 * value verbatim, including `null` when there are zero decided PRs (the KPI is
 * genuinely unavailable — no decided cohort to take a rate over), which the
 * caller maps to its display contract.
 *
 * @param mergedCount merged PRs in range (the merge-rate numerator)
 * @param closedCount closed-without-merge PRs in range; with `mergedCount` this
 *                    forms the DECIDED denominator merged + closed
 */
function ssotMergeRateFromCounts(
  mergedCount: number,
  closedCount: number
): number | null {
  const mergeRateDef = DELIVERY_KPI_REGISTRY.find(
    (def) => def.key === DeliveryKpiKey.MergeRate
  );
  if (mergeRateDef?.source !== "derived") {
    throw new Error(
      "MergeRate is not a derived KPI in the registry; ssotMergeRateFromCounts assumes it derives from count operands."
    );
  }
  // Seed only the raw base COUNT values the derived formula reads — no rows, no
  // per-PR walk. `count` over `mergedPrs` / `decidedPrs` yields exactly these.
  const rawValues = new Map<DeliveryKpiKey, number | null>([
    [DeliveryKpiKey.MergedCount, mergedCount],
    [DeliveryKpiKey.DecidedCount, mergedCount + closedCount],
  ]);
  return computeDerived(mergeRateDef, rawValues);
}

export { assertKpiParity, ssotMergeRateFromCounts };
