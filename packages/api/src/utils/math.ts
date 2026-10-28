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

/**
 * Coerces `value` to a non-negative integer, mapping any non-finite input to
 * `0`. The counting sibling of {@link clampPercent}: a tally has no meaningful
 * `NaN` or negative position, so a broken producer yields "none" rather than a
 * nonsense number on screen or on a monitor.
 *
 * Three surfaces had each hand-rolled this — the web trace-marker rows, the
 * desktop renderer's import-progress display, and the desktop main process's
 * sync-lane health rollup — which is exactly how a small rule drifts when it
 * lives behind separate platform adapters.
 *
 * This is a coercion, not an availability signal: a caller that must tell a real
 * `0` from a count it could not compute has to carry that distinction itself.
 */
export function clampNonNegativeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Page count for a row total and page size, floored at one.
 *
 * The web shell (Sessions, My Tasks), the shared filter/table hooks, the packs
 * matrix, Branches, the desktop renderer's Sessions and Insights views, the
 * agent-component page projector, and the agent telemetry analytics view each
 * carried this expression inline — one rule in ten places behind two platform
 * adapters. It lives beside {@link clampPercent} rather than in `@repo/app`
 * because two of those callers deliberately stay off the renderer package's
 * dependency graph so they can be unit-tested without it.
 *
 * The floor at one is the load-bearing part: an empty result still has a single
 * (empty) page, so a footer reads "Page 1 of 1" rather than "Page 1 of 0".
 * Callers keep their own page-size clamping — the surfaces disagree on whether a
 * zero or absent page size is reachable at all, and folding that in here would
 * change what three of them currently do.
 */
export function resolveTotalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Highest zero-based page index a read capped at `maxOffset` can still serve.
 *
 * The offset a paginator sends is `pageIndex * pageSize`, so the last page it
 * may offer is the one whose offset is the largest multiple of `pageSize` that
 * does not exceed the cap.
 */
export function resolveMaxPageIndex(
  maxOffset: number,
  pageSize: number
): number {
  return Math.floor(maxOffset / pageSize);
}

/**
 * {@link resolveTotalPages}, narrowed to the pages a capped read can serve.
 *
 * ISS-9074: a host whose API rejects an offset past a ceiling must not advertise
 * pages beyond it — the footer always renders a last-page link, so an uncapped
 * count turns the tail of a large list into a link that can only ever 400, on a
 * page that cannot self-repair because the clamp which would rescue it reads a
 * total the failed query never returned. `maxOffset` is optional because a host
 * whose source has no ceiling (desktop's local SQLite) is the other half of the
 * same contract, and must keep advertising every page its rows imply.
 */
export function resolveCappedTotalPages(
  total: number,
  pageSize: number,
  maxOffset?: number
): number {
  const totalPages = resolveTotalPages(total, pageSize);
  if (maxOffset === undefined) {
    return totalPages;
  }
  return Math.min(resolveMaxPageIndex(maxOffset, pageSize) + 1, totalPages);
}

/**
 * The offset a read can actually serve for a requested one, given the population
 * it matched: the requested offset, or the start of the last non-empty page when
 * that overshoots.
 *
 * Flooring to a multiple of `limit` is the load-bearing part, not a rounding
 * preference — it is what guarantees `offset % limit === 0`, so the repaired
 * value names a PAGE the paginator can hold rather than a row midway through
 * one. Rounding to the nearest page start would let a repaired offset sit past
 * the population it was repaired against.
 *
 * ISS-9555 lifted this out of `packages/lib/branches/branch-list-page.ts`, where
 * it was module-private and untested, so it sits with the rest of the page
 * arithmetic (`resolveMaxPageIndex`, `resolveTotalPages`) and has cases of its
 * own. Branches is its ONLY caller. Sessions was going to be the second and
 * deliberately is not: an out-of-range Sessions read reports the page it was
 * asked for and answers empty rather than moving the reader, so it has no offset
 * to repair. It repairs against a TOTAL and never against a ceiling: an offset
 * past a route's `maxOffset` is a request that gets rejected (ISS-8528), not one
 * that gets quietly moved.
 */
export function repairOffset(
  requested: number,
  total: number,
  limit: number
): number {
  if (total === 0) {
    return 0;
  }
  return Math.min(requested, Math.floor((total - 1) / limit) * limit);
}
