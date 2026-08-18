/**
 * Computes the arithmetic mean of an array of numbers.
 * Typically we would use this functionality from an external library. However, adding an extra
 * dependency for one function is overkill, so we decided to implement it here.
 */
export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * Median of a numeric array. Returns `null` for an empty input so callers can
 * distinguish "no data" from a real zero; callers that want 0-on-empty use
 * `median(values) ?? 0`. Does not mutate the input.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Constrains `value` to the inclusive `[min, max]` range. The single canonical
 * generic 3-arg clamp for numeric surfaces (UI positioning math — tooltip
 * offsets, drag handles, bucket indices — and ratio/percent surfaces) that must
 * agree on how out-of-range values are pinned. Product-specific specializations
 * (fixed bounds, 2-arg min=0) should delegate to this rather than re-derive it.
 *
 * Implemented as `Math.min(Math.max(value, min), max)`, so:
 * - `NaN` input propagates to `NaN` (both `Math.min`/`Math.max` return `NaN`).
 * - An inverted range (`min > max`) pins to `max` rather than throwing.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Clamps `value` to the unit interval `[0, 1]`. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Clamps `value` to the percentage range `[0, 100]`, coercing any non-finite
 * input (`NaN`, `±Infinity`) to `0`. Unlike the generic {@link clamp} (which
 * propagates `NaN` and pins `+Infinity` to the max), a percentage surface has no
 * meaningful non-finite position, so UI/derivation callers get a safe `0` rather
 * than a `NaN` coordinate or a spurious `100`. This is the SSOT for the
 * `!Number.isFinite(value) → 0` contract that UI copies previously hand-rolled.
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(value, 0, 100);
}

/**
 * Rounds `value` to `decimals` decimal places using standard half-up rounding.
 * The single canonical round-to-decimals helper for numeric surfaces (KLOC,
 * USD, ratios) that must agree on how a raw float is printed.
 */
export function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * Checks whether a number can be represented with at most N decimal places.
 * Uses an epsilon tolerance to account for IEEE-754 floating-point arithmetic.
 */
export function hasAtMostDecimalPlaces(
  value: number,
  maxDecimalPlaces: number
): boolean {
  if (!Number.isFinite(value) || maxDecimalPlaces < 0) {
    return false;
  }

  const scale = 10 ** maxDecimalPlaces;
  const scaledValue = value * scale;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(scaledValue));

  return Math.abs(scaledValue - Math.round(scaledValue)) <= epsilon;
}
