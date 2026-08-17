import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import type {
  TokenTrendPoint,
  TokenTrendResponse,
} from "@repo/api/src/types/agent-component-analytics";
import type { TimeSeries } from "@repo/api/src/types/insights";
import type { TimeSeriesMarker } from "@repo/design-system/components/ui/time-series-area-chart";
import { UsageMetric } from "../../insights/components/overview/usage-graph-toggles";
import { coerceHash, versionLabelForHash } from "./version-label";

/**
 * Token-trend chart data builders (FEA-4027).
 *
 * Pure transforms that turn a component's `TokenTrendResponse` into the shared
 * `TimeSeries` shape the dashboard's usage graph consumes — one series per
 * model, per-bucket values for either the TOKENS metric (input + output) or the
 * DOLLARS metric (estimated USD) — plus the vertical version-lifecycle markers
 * (each version's created day, and the day it was first used) drawn on the time
 * axis. Kept lib-side (no React) so they can be unit-tested behaviorally.
 */

/** Bucket a session/version timestamp to a YYYY-MM-DD chart bucket. */
export function bucketDay(value: unknown): string {
  const UNKNOWN_BUCKET = "unknown";
  if (typeof value === "string") {
    return value.slice(0, 10) || UNKNOWN_BUCKET;
  }
  if (value instanceof Date || typeof value === "number") {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime())
      ? UNKNOWN_BUCKET
      : asDate.toISOString().slice(0, 10);
  }
  return UNKNOWN_BUCKET;
}

/**
 * The per-metric value a single token-trend point contributes, or `null` when
 * this point has nothing measured to contribute for that metric.
 *
 * Tokens sums total token volume — input + output + cache read + cache write —
 * to match the dashboard's token view (FEA-3497, which sums `input + output +
 * cache_read + cache_write` server-side) so the shared "Tokens" toggle reads the
 * SAME number on both surfaces, including for cache-heavy harnesses that move
 * huge cache volume cheaply. A single absent token field is a real zero
 * contribution to that sum, so it floors at 0 and the point still plots.
 *
 * Dollars is different, and `null` is the whole point of this signature. An
 * absent `estimatedCostUsd` means "we could not compute cost", not "we measured
 * zero dollars", and root AGENTS.md names exactly this shape: never emit a
 * plausible-but-wrong number, and a `$0` you could not compute is its example.
 * Coercing it to 0 drew a $0.00 point beside days with real spend, which reads
 * as a day nobody spent anything. The point is dropped from the bucket instead,
 * so an unattributed day is absent rather than fabricated — and a component
 * whose cost never arrived falls through to the chart's own empty state, whose
 * copy (see `token-trend-chart.tsx`) names spend rather than tokens.
 */
function metricValue(
  point: TokenTrendPoint,
  metric: UsageMetric
): number | null {
  if (metric === UsageMetric.Cost) {
    return Number.isFinite(point.estimatedCostUsd)
      ? point.estimatedCostUsd
      : null;
  }
  return (
    finiteOrZero(point.inputTokens) +
    finiteOrZero(point.outputTokens) +
    finiteOrZero(point.cacheReadTokens) +
    finiteOrZero(point.cacheWriteTokens)
  );
}

/**
 * ISS-4802: coerce one wire-supplied TOKEN field to a finite number.
 *
 * These arrive as JSON from a version-skewed producer, so the `number` on
 * `TokenTrendPoint` is a compile-time claim, not a runtime guarantee — a missing
 * or null field yields `NaN` from the bare sum. That `NaN` was the blank chart:
 * the chart's own empty check asks whether every plotted value is `0`, and
 * `NaN === 0` is false, so a poisoned series read as "has data", skipped the
 * "No usage recorded" fallback, and handed `NaN` to the renderer — which then
 * painted no areas AND no axes, because a non-finite value collapses the
 * y-domain. The result was an empty frame that looked like a broken page rather
 * than either a chart or an empty state.
 *
 * Zero is the right floor for ONE field of the token sum: the other three still
 * carry measured volume, so the point plots the tokens it does have. It is NOT
 * the right floor for cost, which is a single field with no siblings to make the
 * total meaningful — see {@link metricValue}.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * ISS-4802: the legend key for a point whose `model` did not survive the wire.
 *
 * `point.model` reaches the DOM as a series `label`, and it is the one field on
 * the point that the numeric hardening above does not cover — `model: string` is
 * the same compile-time-only claim as `inputTokens: number`. An absent value
 * previously minted `{ key: undefined, label: undefined }`, which renders the
 * literal word "undefined" in the legend and, on the By-provider toggle, hands
 * `undefined` to `providerOf` (`model.toLowerCase()` → TypeError).
 *
 * The point still carries real usage, so it is folded under an explicit label
 * rather than dropped — the same landing spot By-provider already gives an
 * unrecognized model through `providerOf`'s "Other".
 */
const UNATTRIBUTED_MODEL = "Unattributed";

/**
 * The series key for `point`: its trimmed model name, or {@link
 * UNATTRIBUTED_MODEL} when the producer omitted it or sent a non-string.
 */
function modelKeyOf(point: TokenTrendPoint): string {
  return declaredModelKey(point.model);
}

/**
 * The series key for one wire-supplied model name, or `null` when it names no
 * model.
 *
 * Split out from {@link modelKeyOf} because the response carries the same
 * untrusted string in TWO places — `point.model` and the `models[]` convenience
 * list — and only the first was being sanitized. A `null` or blank ELEMENT
 * inside `models[]` reached the legend verbatim, which is the same TypeError
 * (`providerOf` → `model.toLowerCase()`) the point-level guard exists to
 * prevent, just entered from the other side.
 */
function modelKeyOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** {@link modelKeyOrNull}, folding an unusable name onto the explicit label. */
function declaredModelKey(value: unknown): string {
  return modelKeyOrNull(value) ?? UNATTRIBUTED_MODEL;
}

/**
 * Build the per-model `TimeSeries` for the requested metric: one series per
 * distinct model, one point per day summing that day's per-model metric value.
 * Buckets sorted ascending by day. Returns empty series/points for an absent or
 * empty response so the chart renders its own empty-state.
 */
export function buildTokenTrendSeries(
  data: TokenTrendResponse | undefined,
  metric: UsageMetric
): TimeSeries {
  // Both convenience arrays are wire-supplied, so neither is guaranteed to
  // arrive: a skewed producer that omits `points` would throw on `.length`, and
  // one that omits `models` would throw from `new Set(undefined)` below — either
  // crashing the whole detail page over a field the chart can rebuild itself.
  const sourcePoints = data && Array.isArray(data.points) ? data.points : [];
  if (!data || sourcePoints.length === 0) {
    return { series: [], points: [] };
  }
  // ISS-4802: the legend is the union of the server's `models` and the models
  // actually present on the points, NOT `data.models` alone. Bucketed values are
  // keyed off the point's model, so a point whose model the server omitted from
  // `models` wrote a value under a key with no matching series — real usage
  // silently absent from the plot, and, if it were the only usage, a chart with
  // points but nothing drawn. Deriving the legend from the data it must describe
  // makes that unrepresentable. `data.models` still leads so the server's
  // ordering is preserved for the models it did declare.
  // Each DECLARED name is sanitized too, not just the array around it: a `null`
  // element inside `models[]` is exactly as reachable as an omitted `models[]`,
  // and it lands in the legend as `{ key: null, label: null }` — the literal
  // word in the swatch, and a `providerOf(null)` TypeError on the By-provider
  // toggle. An unusable declared name is dropped rather than folded onto
  // `Unattributed`, because unlike a point it carries no usage to account for;
  // a point that really has no model still adds that key below.
  const modelKeys = new Set<string>();
  for (const declared of Array.isArray(data.models) ? data.models : []) {
    const key = modelKeyOrNull(declared);
    if (key !== null) {
      modelKeys.add(key);
    }
  }
  for (const point of sourcePoints) {
    modelKeys.add(modelKeyOf(point));
  }
  const series = [...modelKeys].map((model) => ({ key: model, label: model }));
  const byDate = new Map<string, Record<string, number>>();
  for (const point of sourcePoints) {
    const value = metricValue(point, metric);
    // A null contribution is "not computable", not zero — writing a 0 here is
    // what fabricated the $0.00 day. Skipping leaves the bucket absent, so an
    // entirely-unattributed metric resolves to the chart's empty state.
    if (value === null) {
      continue;
    }
    const date = bucketDay(point.sessionStartedAt);
    const model = modelKeyOf(point);
    const values = byDate.get(date) ?? {};
    values[model] = (values[model] ?? 0) + value;
    byDate.set(date, values);
  }
  const points = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, values }));
  return { series, points };
}

/**
 * A single session's version attribution — the join key between the token-trend
 * points (which carry `sessionId` + `sessionStartedAt`) and the version history.
 */
export type UsageSessionVersion = {
  sessionId: string;
  versionHash?: string | null;
};

/**
 * Earliest session start day per version hash, joining the usage-session→version
 * map against the token-trend points' per-session start timestamps. This is the
 * "first used" signal a version-created marker can't give on its own.
 */
function firstUsedDayByHash(
  usageSessions: readonly UsageSessionVersion[],
  points: readonly TokenTrendPoint[]
): Map<string, string> {
  const hashBySession = new Map<string, string>();
  for (const usage of usageSessions) {
    const hash = coerceHash(usage.versionHash);
    if (hash) {
      hashBySession.set(usage.sessionId, hash);
    }
  }
  const firstDay = new Map<string, string>();
  for (const point of points) {
    const hash = hashBySession.get(point.sessionId);
    if (!hash) {
      continue;
    }
    const day = bucketDay(point.sessionStartedAt);
    if (day === "unknown") {
      continue;
    }
    const prior = firstDay.get(hash);
    if (!prior || day < prior) {
      firstDay.set(hash, day);
    }
  }
  return firstDay;
}

/**
 * Build the vertical version-lifecycle markers for the token-trend chart: for
 * each revision, a "created" marker on the day its content was first observed,
 * and — when the join yields one — a "first used" marker on the earliest day a
 * session ran against that revision. Both carry an accessible description so the
 * decorative reference line has a screen-reader name.
 *
 * Markers are keyed to the version's *hash* identity, deduped to one created and
 * one first-used marker per hash. A version's full identity is
 * `(component, source, hash)`, so the detail producer can return two revision
 * rows with the same content hash under different sources; but the usage join
 * only carries `versionHash` — a session cannot say which source ran — so the
 * first-used day it resolves is hash-level, not source-level. Emitting a marker
 * per raw revision row would paint the same hash-level day twice (once per
 * source) under identical labels. We collapse to the first revision seen per
 * hash so the marker set stays honest about what the join can actually
 * attribute (wongk review, #3756).
 *
 * The chart itself only draws markers landing on a rendered bucket, so an
 * off-window created/used day is filtered there; this builder emits the honest
 * full set.
 */
export function buildVersionMarkers(
  versions: readonly ComponentVersion[],
  usageSessions: readonly UsageSessionVersion[],
  data: TokenTrendResponse | undefined
): TimeSeriesMarker[] {
  if (versions.length === 0) {
    return [];
  }
  const firstUsed = firstUsedDayByHash(usageSessions, data?.points ?? []);
  const markers: TimeSeriesMarker[] = [];
  const seenHashes = new Set<string>();
  for (const version of versions) {
    const hash = coerceHash(version.hash);
    if (hash && seenHashes.has(hash)) {
      continue;
    }
    if (hash) {
      seenHashes.add(hash);
    }
    const label = versionLabelForHash(version.hash, versions) ?? "revision";
    const createdDay = bucketDay(version.createdAt);
    if (createdDay !== "unknown") {
      markers.push({
        date: createdDay,
        label,
        description: `${label} created ${createdDay}`,
      });
    }
    const usedDay = firstUsed.get(hash);
    if (usedDay) {
      markers.push({
        date: usedDay,
        label: `${label} used`,
        description: `${label} first used ${usedDay}`,
      });
    }
  }
  return markers;
}
