// FEA-2952 / PLN-1323 — the compute engine.
//
// `computeDeliveryKpis` is the SINGLE walker over the declarative registry. It is
// pure: given NormalizedDeliveryRows it resolves each KPI definition through the
// same pipeline — population → filter (onlyEnriched) → measure → aggregate →
// transform → round — then attaches display metadata. Derived KPIs read from the
// value table populated by the base pass. No surface-specific logic lives here;
// all the variation is DATA in registry.ts.
//
// Empty populations yield `value: null` ("unavailable"), never a fabricated 0 —
// matching the existing KPI contract where "no data" is distinct from a real
// zero. `count` is the one aggregation that legitimately returns 0 on empty
// (there genuinely were zero rows).

import type { KpiFormat } from "../../types/insights.ts";
import { aggregations, ratio, round } from "./aggregations.ts";
import { branchMeasures, prMeasures, sessionMeasures } from "./measures.ts";
import type {
  NormalizedDeliveryRows,
  NormalizedPr,
} from "./normalized-rows.ts";
import {
  branchPopulations,
  type PrPopulation,
  type PrPopulationKey,
  prPopulations,
  sessionPopulations,
} from "./populations.ts";
import type { DeliveryKpiDefinition, DeliveryKpiKey } from "./registry.ts";
import { DELIVERY_KPI_REGISTRY, KpiTransform } from "./registry.ts";

/** One computed delivery KPI. `value` is null when the metric is unavailable. */
export type DeliveryKpi = {
  key: DeliveryKpiKey;
  value: number | null;
  label: string;
  help: string;
  format: KpiFormat;
};

/**
 * The set of PUBLIC (non-internal) delivery KPIs, keyed by KPI key.
 *
 * TRADEOFF: `internal` is runtime data on the registry, not encoded in the key
 * type, so there is no clean type-level way to derive a `PublicDeliveryKpiKey`
 * union that excludes the internal keys — any such union would have to be hand-
 * maintained in lockstep with the registry and would silently drift. We therefore
 * model the public map as `Partial<Record<...>>`: honest about the fact that
 * internal keys (DecidedCount, SessionTokensTotal) are omitted at runtime, which
 * forces every caller to null-check an indexed lookup rather than trusting a key
 * that is `undefined` at runtime.
 */
export type DeliveryKpis = Partial<Record<DeliveryKpiKey, DeliveryKpi>>;

/**
 * The internal-INCLUSIVE map of every computed raw value (base + internal +
 * derived), keyed by KPI key. Used by the parity harness so a discrepancy in an
 * internal building-block KPI (e.g. DecidedCount) is not invisible.
 */
export type DeliveryKpiValues = Map<DeliveryKpiKey, number | null>;

/** The full result of a compute pass: the public KPI map plus every raw value. */
export type DeliveryKpiResult = {
  /** Public (non-internal) KPIs with display metadata. */
  kpis: DeliveryKpis;
  /** Every computed raw value, including internal KPIs, for parity checks. */
  values: DeliveryKpiValues;
};

/**
 * Applies a post-aggregate transform to a non-null value. Exhaustive over
 * `KpiTransform`: the `default` arm is compile-time `never`-checked, so adding a
 * new transform without handling it here is a typecheck error rather than a
 * silent pass-through.
 */
function applyTransform(
  value: number,
  transform: KpiTransform | undefined
): number {
  if (transform === undefined) {
    return value;
  }
  switch (transform) {
    case KpiTransform.PerThousand:
      return value / 1000;
    default: {
      const exhaustive: never = transform;
      throw new Error(`Unhandled KPI transform: ${String(exhaustive)}`);
    }
  }
}

/** Restricts a PR population to enriched rows when the definition demands it. */
function applyEnrichedFilter(
  prs: NormalizedPr[],
  onlyEnriched: boolean | undefined
): NormalizedPr[] {
  if (onlyEnriched) {
    return prs.filter((pr) => pr.enriched);
  }
  return prs;
}

/**
 * Per-compute-pass cache of population selections, keyed `${source}:${key}`. A
 * population shared across KPIs (`mergedPrs` feeds 4 KPIs, `sessions` feeds 3) —
 * and the arms of the composed `decidedPrs` — therefore filter their source rows
 * exactly once per pass instead of once per referencing KPI (FEA-2978). Scoped to
 * a single `computeDeliveryKpiResult` call so it never leaks across passes.
 */
type PopulationCache = Map<string, readonly unknown[]>;

/** Returns the cached selection for `cacheKey`, computing it via `select` on miss. */
function memoizePopulation<T>(
  cache: PopulationCache,
  cacheKey: string,
  select: () => T[]
): T[] {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached as T[];
  }
  const selected = select();
  cache.set(cacheKey, selected);
  return selected;
}

/**
 * Resolves a PR population to its rows, memoized per pass. `decidedPrs` composes
 * two other populations; it receives this same resolver as its `resolve`
 * callback, so its `mergedPrs`/`closedPrs` arms hit the cache rather than
 * re-scanning `rows.prs`. Base populations ignore the second argument.
 */
function resolvePrPopulation(
  key: PrPopulationKey,
  rows: NormalizedDeliveryRows,
  cache: PopulationCache
): NormalizedPr[] {
  return memoizePopulation(cache, `pr:${key}`, () => {
    const select: PrPopulation = prPopulations[key];
    return select(rows, (armKey) => resolvePrPopulation(armKey, rows, cache));
  });
}

/**
 * Measures a base (non-derived) KPI to its raw aggregate value (pre-transform,
 * pre-round). Returns null for an empty population unless the aggregation is
 * `count` (which is 0 on empty by definition). Nulls produced per-row by a
 * measure (e.g. mergeLatencyMs on an unmerged PR) are dropped before aggregating.
 */
function measureBase(
  def: Extract<DeliveryKpiDefinition, { source: "pr" | "branch" | "session" }>,
  rows: NormalizedDeliveryRows,
  cache: PopulationCache
): number | null {
  const values = collectValues(def, rows, cache);
  return aggregations[def.aggregate](values);
}

/** Collects the per-row measured numbers for a base KPI definition. */
function collectValues(
  def: Extract<DeliveryKpiDefinition, { source: "pr" | "branch" | "session" }>,
  rows: NormalizedDeliveryRows,
  cache: PopulationCache
): number[] {
  const raw = collectRawValues(def, rows, cache);
  return raw.filter((value): value is number => value !== null);
}

function collectRawValues(
  def: Extract<DeliveryKpiDefinition, { source: "pr" | "branch" | "session" }>,
  rows: NormalizedDeliveryRows,
  cache: PopulationCache
): (number | null)[] {
  if (def.source === "pr") {
    const population = applyEnrichedFilter(
      resolvePrPopulation(def.population, rows, cache),
      def.onlyEnriched
    );
    return population.map((pr) => prMeasures[def.measure](pr));
  }
  if (def.source === "branch") {
    const population = memoizePopulation(
      cache,
      `branch:${def.population}`,
      () => branchPopulations[def.population](rows)
    );
    return population.map((branch) => branchMeasures[def.measure](branch));
  }
  if (def.source === "session") {
    const population = memoizePopulation(
      cache,
      `session:${def.population}`,
      () => sessionPopulations[def.population](rows)
    );
    return population.map((session) => sessionMeasures[def.measure](session));
  }
  // Exhaustive: a new base source variant fails typecheck here rather than
  // silently landing in the session path.
  const exhaustive: never = def;
  throw new Error(
    `Unhandled base KPI source: ${String((exhaustive as { source: string }).source)}`
  );
}

/**
 * Applies a base KPI's transform to its raw aggregate WITHOUT rounding. This is
 * the value derived KPIs consume: rounding is display-only, so a derived ratio
 * must divide by the true (pre-round) base value, not a display-rounded one
 * (otherwise e.g. a small window whose KLOC rounds to 0.0 would zero out the
 * tokens-per-KLOC denominator despite real underlying lines). See
 * `computeDeliveryKpiResult` for the two-table split.
 */
function transformBase(
  raw: number | null,
  def: Extract<DeliveryKpiDefinition, { source: "pr" | "branch" | "session" }>
): number | null {
  if (raw === null) {
    return null;
  }
  return applyTransform(raw, def.transform);
}

/**
 * Rounds a transform-applied base value for DISPLAY only. Null-safe; a
 * definition with no `round` is passed through unchanged.
 */
function roundBaseForDisplay(
  transformed: number | null,
  def: Extract<DeliveryKpiDefinition, { source: "pr" | "branch" | "session" }>
): number | null {
  if (transformed === null || def.round === undefined) {
    return transformed;
  }
  return round(transformed, def.round);
}

/**
 * INVARIANT: a derived KPI may reference ONLY base (non-derived) KPIs as its
 * numerator/denominator — never another derived KPI. The engine runs two full
 * passes over the whole registry (pass 1 computes ALL base values, pass 2 all
 * derived), so a derived KPI can safely read any base value regardless of array
 * order. But a derived-of-derived would resolve against a value that pass 2 may
 * not have computed yet, silently yielding null/stale numbers. This guard makes
 * that mistake LOUD (throwing) instead of latent.
 *
 * Called once at module initialization (see below) against the canonical registry.
 * Exported so unit tests can call it against arbitrary test registries.
 */
function validateDerivedReferencesBase(
  registry: readonly DeliveryKpiDefinition[]
): void {
  const sourceByKey = new Map<DeliveryKpiKey, DeliveryKpiDefinition["source"]>(
    registry.map((def) => [def.key, def.source])
  );
  for (const def of registry) {
    if (def.source !== "derived") {
      continue;
    }
    for (const refKey of [
      def.derived.numeratorKpi,
      def.derived.denominatorKpi,
    ]) {
      if (sourceByKey.get(refKey) === "derived") {
        throw new Error(
          `Derived KPI "${def.key}" references derived KPI "${refKey}"; derived KPIs may reference only base KPIs, not other derived KPIs.`
        );
      }
    }
  }
}

/**
 * Computes a derived KPI from already-computed base values. Reads its
 * numerator/denominator from the RAW (transform-applied, pre-round) base table
 * so the ratio divides by the true value, not the display-rounded one — then
 * applies its OWN `round` to the final ratio.
 */
function computeDerived(
  def: Extract<DeliveryKpiDefinition, { source: "derived" }>,
  rawValues: Map<DeliveryKpiKey, number | null>
): number | null {
  const numerator = rawValues.get(def.derived.numeratorKpi) ?? null;
  const denominator = rawValues.get(def.derived.denominatorKpi) ?? null;
  if (numerator === null || denominator === null) {
    return null;
  }
  const result = ratio(numerator, denominator, def.derived.scale ?? 1);
  return def.round === undefined || result === null
    ? result
    : round(result, def.round);
}

function toKpi(def: DeliveryKpiDefinition, value: number | null): DeliveryKpi {
  return {
    key: def.key,
    value,
    label: def.label,
    help: def.help,
    format: def.format,
  };
}

/**
 * Module-init guard: validate the registry once when the module loads (not on
 * every compute call). A derived-of-derived reference fails fast at startup —
 * the earliest possible detection — rather than being re-detected on every
 * `computeDeliveryKpiResult` invocation. The function remains exported so unit
 * tests can still call it against arbitrary test registries.
 */
validateDerivedReferencesBase(DELIVERY_KPI_REGISTRY);

/**
 * Walks the delivery-KPI registry and computes every KPI from the normalized
 * rows, returning BOTH the public KPI map and the internal-inclusive raw value
 * table.
 *
 * TWO-PASS ORDER INVARIANT: the engine makes two FULL passes over the registry —
 * pass 1 computes ALL base (non-derived) values, pass 2 computes ALL derived
 * values reading from the base table. Because each pass sweeps the entire
 * registry, the base-vs-derived ARRAY ORDER of entries does not affect
 * correctness (a derived entry appearing before a base entry it references is
 * fine). The only real hazard is a derived-of-derived reference, which
 * `validateDerivedReferencesBase` guards against loudly — run once at module
 * initialization above.
 *
 * RAW-vs-DISPLAY VALUE INVARIANT: pass 1 keeps TWO tables for each base KPI — a
 * `rawValues` map holding the transform-applied but UN-rounded value (what
 * derived KPIs consume, so ratios divide by the true denominator, not a
 * display-rounded 0.0), and the public `values`/`kpis` display value which stays
 * rounded exactly as before. Derived KPIs read `rawValues` and apply their own
 * round to the final ratio.
 *
 * Internal building-block KPIs are excluded from `kpis` but retained in `values`.
 */
function computeDeliveryKpiResult(
  rows: NormalizedDeliveryRows
): DeliveryKpiResult {
  const values: DeliveryKpiValues = new Map();
  // Transform-applied, pre-round base values — the denominators/numerators that
  // derived KPIs divide by. Kept separate from the rounded display `values`.
  const rawValues: Map<DeliveryKpiKey, number | null> = new Map();
  const kpis: DeliveryKpis = {};

  // Population results are memoized for this pass so each population filters its
  // source rows exactly once, no matter how many KPIs reference it (FEA-2978).
  const populationCache: PopulationCache = new Map();

  // Pass 1: base KPIs. Store the pre-round value in `rawValues` (for derived
  // math) and the rounded value in `values`/`kpis` (for display + parity).
  for (const def of DELIVERY_KPI_REGISTRY) {
    if (def.source === "derived") {
      continue;
    }
    const transformed = transformBase(
      measureBase(def, rows, populationCache),
      def
    );
    rawValues.set(def.key, transformed);
    const displayed = roundBaseForDisplay(transformed, def);
    values.set(def.key, displayed);
    if (!def.internal) {
      kpis[def.key] = toKpi(def, displayed);
    }
  }

  // Pass 2: derived KPIs (read numerator/denominator from the RAW base table).
  for (const def of DELIVERY_KPI_REGISTRY) {
    if (def.source !== "derived") {
      continue;
    }
    const finalized = computeDerived(def, rawValues);
    values.set(def.key, finalized);
    if (!def.internal) {
      kpis[def.key] = toKpi(def, finalized);
    }
  }

  return { kpis, values };
}

/**
 * Public entrypoint: computes the delivery-KPI map from the normalized rows.
 * Internal building-block KPIs are excluded from the returned map (they remain
 * available via `computeDeliveryKpiResult().values` for parity checks). The
 * returned record is keyed by KPI key.
 */
function computeDeliveryKpis(rows: NormalizedDeliveryRows): DeliveryKpis {
  return computeDeliveryKpiResult(rows).kpis;
}

export {
  applyTransform,
  computeDeliveryKpiResult,
  computeDeliveryKpis,
  computeDerived,
  validateDerivedReferencesBase,
};
