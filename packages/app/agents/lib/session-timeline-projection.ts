import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { ActivityMarker } from "@repo/app/agents/components/detail/session-timeline-axis";
import {
  clampTimelineWindowStart,
  resolveTimelineScaleGeometry,
  resolveTimelineWindowEdges,
  TIMELINE_VISIBLE_COLUMNS,
  type TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { formatTime } from "@repo/app/shared/lib/date-utils";

/**
 * ISS-5819 — re-bin the Session Timeline's bars onto the clock window.
 *
 * WHY A RE-PROJECTION RATHER THAN A RE-DERIVATION. The priced, per-model bars
 * this screen draws are produced upstream, not here: the desktop collector bins
 * the session's token events into up to 40 uniform bins over the real activity
 * extent and syncs the RESULT (`session.activityBuckets`), and the web-side
 * synthesizer builds the same shape from turn items when no persisted strip
 * exists. Neither the raw token events nor their timestamps reach this component,
 * so the honest move is to redistribute the bins we have onto the columns we
 * want, not to pretend we can re-derive from source.
 *
 * WHICH CLOCK THE BINS WERE MEASURED ON IS THE PRODUCER'S TO SAY (ISS-5819
 * review, whitlockk). Every bin span below is read off the bin's OWN
 * `binStartMs`/`binEndMs`, never off some window this layer happened to have.
 * The two are genuinely different clocks: the collector bins over the session's
 * real activity extent, while the detail page's axis window is resolved from
 * transcript / phase / lifecycle bounds. Spreading the collector's bins across
 * that second window moves measured cost into clock intervals the producer never
 * established — a bar under the 14:00 tick claiming spend that happened at
 * 09:00. A strip whose bins do not all carry bounds therefore cannot be
 * projected at all; {@link hasProducerBinBounds} is the gate, and the caller
 * keeps such a strip on its ordinal bars instead.
 *
 * WHAT THE REDISTRIBUTION ASSUMES, STATED PLAINLY. A source bin is spread across
 * the columns it overlaps in proportion to the overlap duration. That is a
 * uniform-density assumption INSIDE a source bin — and it is exactly the
 * assumption the strip already makes when it draws that bin as one flat
 * rectangle. So the projection adds no claim the current strip does not already
 * make; it only re-slices it. It is nonetheless lossy when the target column is
 * NARROWER than the source bin, which is why {@link ProjectedTimeline} reports
 * {@link ProjectedTimeline.subColumnSource} so the caller can tell the reader the
 * bars are interpolated rather than let them read as newly measured resolution.
 *
 * AND THE BINS DO NOT TILE THE RENDERED WINDOW (ISS-5850). Placing each bin from
 * its own bounds fixes WHERE the money goes; it does not fix what the columns
 * the bins never reached are allowed to say. The collector bins over the
 * session's real activity extent while the axis window spans the whole run, and
 * the two routinely disagree by a lot (`session-timeline-source-extent-flag.ts`
 * carries the measurement). Every column beyond that coverage is emitted with
 * all fields at zero — which the strip and its tooltip then render as observed
 * quiet, a measured claim about an interval nobody measured.
 * {@link ProjectedTimeline.columnCoverage} is where that difference is carried,
 * from the extent the producer now states on `SessionSpan`.
 *
 * CONSERVATION IS THE CONTRACT. Every cost that falls inside the visible window
 * is preserved exactly; cost outside it is dropped, because it is outside the
 * window the reader asked for. Nothing is invented and nothing is double-counted
 * — `session-timeline-projection.test.ts` pins both directions.
 */

/**
 * A source strip, plus the window the strip's MARKERS were positioned over.
 *
 * `startMs`/`endMs` are deliberately NOT used to place the bars: those come off
 * each bin's own `binStartMs`/`binEndMs`. This window is the one a marker's
 * ordinal `x` was derived against, and it is used only to turn such an `x` back
 * into an instant — see {@link resolveMarkerMs}.
 */
export type TimelineSourceStrip = {
  readonly buckets: readonly ActivityBucket[];
  readonly endMs: number;
  /**
   * ISS-5850: the extent the producer's bins actually TILE, or `null` when the
   * producer did not say.
   *
   * Deliberately separate from `startMs`/`endMs` above, which are the RENDERED
   * window. The two are different clocks and routinely disagree — see
   * {@link resolveColumnCoverage}.
   */
  readonly extent: TimelineSourceExtent | null;
  readonly startMs: number;
};

/** The wall-clock interval a strip's bins were measured across. */
export type TimelineSourceExtent = {
  readonly endMs: number;
  readonly startMs: number;
};

/**
 * ISS-5850 — what a rendered column's value is BACKED BY.
 *
 * Three genuinely different answers, kept as one closed union so no consumer can
 * collapse two of them into a single "is it zero" test. The precedent is
 * ISS-5566's `costUnmeasured`, which drew the same line for synthesized money.
 */
export const TimelineColumnCoverage = {
  /** The source extent covers some of this column; its value is measured. */
  Measured: "measured",
  /** The producer stated an extent, and this column lies wholly outside it. */
  Unmeasured: "unmeasured",
  /** The producer stated no extent, so coverage cannot be established. */
  Unknown: "unknown",
} as const;

export type TimelineColumnCoverage =
  (typeof TimelineColumnCoverage)[keyof typeof TimelineColumnCoverage];

/** One bin's producer-measured wall-clock bounds. */
type ProducerBinBounds = {
  readonly endMs: number;
  readonly startMs: number;
};

export type ProjectedTimeline = {
  /**
   * Exactly {@link TIMELINE_VISIBLE_COLUMNS} bars, in the same `ActivityBucket`
   * shape the strip already renders — so every downstream unit (the bar row, the
   * label rail, the tooltip, the accessible names) keeps working unchanged.
   */
  readonly buckets: ActivityBucket[];
  /**
   * ISS-5850: per column, what its value is backed by. Parallel to `buckets`.
   *
   * The projection places every bin from the bin's own bounds, so the bars it
   * draws are correct — but it draws {@link TIMELINE_VISIBLE_COLUMNS} of them
   * across a window the source may only partly cover, and a column outside that
   * coverage is emitted with every field at zero. Zero is indistinguishable from
   * an observed quiet stretch, so without this array the strip reports "nothing
   * was spent here" for an interval the producer never looked at. The caller owes
   * the reader that difference.
   */
  readonly columnCoverage: readonly TimelineColumnCoverage[];
  readonly limitDotEvents: ActivityMarker[];
  readonly markers: ActivityMarker[];
  /**
   * `true` when a target column is narrower than a source bin, so the bars are
   * interpolated within a bin rather than separately measured. The caller owes
   * the reader this fact.
   */
  readonly subColumnSource: boolean;
  readonly windowEndMs: number;
  readonly windowStart: number;
  readonly windowStartMs: number;
} & Pick<
  ReturnType<typeof resolveTimelineScaleGeometry>,
  "columnMs" | "maxWindowStart" | "originMs" | "totalColumns"
>;

export function projectSessionTimeline({
  limitDotEvents,
  markers,
  scale,
  source,
  windowStart,
}: {
  limitDotEvents: readonly ActivityMarker[];
  markers: readonly ActivityMarker[];
  scale: TimelineScale;
  source: TimelineSourceStrip;
  windowStart: number;
}): ProjectedTimeline {
  const geometry = resolveTimelineScaleGeometry({
    endMs: source.endMs,
    scale,
    startMs: source.startMs,
  });
  const safeWindowStart = clampTimelineWindowStart(
    windowStart,
    geometry.maxWindowStart
  );
  /*
   * ISS-5844 (AC5): the window's real boundaries, not `start + n x columnMs`.
   * At `12h` a column containing a DST transition is genuinely 11 or 13 hours
   * wide, so every span below is read off these edges rather than multiplied.
   */
  const edges = resolveTimelineWindowEdges({
    originMs: geometry.originMs,
    scale,
    windowStart: safeWindowStart,
  });
  const windowStartMs = edges[0] ?? geometry.originMs;
  const windowEndMs = edges[TIMELINE_VISIBLE_COLUMNS] ?? windowStartMs;
  const buckets = createEmptyColumns(edges, scale);
  let widestBinMs = 0;

  for (const bucket of source.buckets) {
    const bounds = resolveProducerBinBounds(bucket);
    /*
     * Unreachable through the caller, which gates on {@link hasProducerBinBounds}
     * before it projects at all. Kept because the alternative — assuming uniform
     * tiling for a bin that never said where it was — is the exact fabrication
     * this module now refuses to make, and a bin without bounds contributing
     * nothing is the only other honest answer.
     */
    if (bounds == null) {
      continue;
    }
    widestBinMs = Math.max(widestBinMs, bounds.endMs - bounds.startMs);
    accumulateSourceBin({
      binEndMs: bounds.endMs,
      binStartMs: bounds.startMs,
      bucket,
      columns: buckets,
      edges,
    });
  }
  apportionColumnCounts(buckets);

  return {
    buckets,
    columnCoverage: resolveColumnCoverage({
      buckets,
      edges,
      extent: source.extent,
    }),
    columnMs: geometry.columnMs,
    limitDotEvents: projectMarkers({
      edges,
      markers: limitDotEvents,
      source,
      windowEndMs,
      windowStartMs,
    }),
    markers: projectMarkers({
      edges,
      markers,
      source,
      windowEndMs,
      windowStartMs,
    }),
    maxWindowStart: geometry.maxWindowStart,
    originMs: geometry.originMs,
    subColumnSource: widestBinMs > geometry.columnMs,
    totalColumns: geometry.totalColumns,
    windowEndMs,
    windowStart: safeWindowStart,
    windowStartMs,
  };
}

function createEmptyColumns(
  edges: readonly number[],
  scale: TimelineScale
): ActivityBucket[] {
  return Array.from({ length: TIMELINE_VISIBLE_COLUMNS }, (_, index) => {
    const columnStartMs = edges[index] ?? 0;
    return {
      byModel: emptyStringKeyedRecord(),
      cCache: 0,
      cIn: 0,
      cOut: 0,
      // Scale-qualified so React cannot reconcile a `5m` column onto the `1h`
      // column that happens to start at the same instant and keep its height.
      key: `${scale}-${columnStartMs}`,
      label: formatTime(new Date(columnStartMs)),
      tl0: null,
      toolStart: 0,
      total: 0,
    } satisfies ActivityBucket;
  });
}

function accumulateSourceBin({
  binEndMs,
  binStartMs,
  bucket,
  columns,
  edges,
}: {
  binEndMs: number;
  binStartMs: number;
  bucket: ActivityBucket;
  columns: ActivityBucket[];
  edges: readonly number[];
}): void {
  const binMs = binEndMs - binStartMs;
  /*
   * NOT `Math.max(1, …)`. Clamping the divisor independently of the bin width
   * the caller computed silently deletes money: on a degenerate window (every
   * turn item on one timestamp, 40 persisted bins) the real bin is 0.025ms, the
   * clamp makes the divisor 1, and every share becomes 2.5% — the strip and its
   * tooltip then print a fortieth of the session's real cost with no signal that
   * anything was dropped. A non-positive bin contributes nothing instead.
   */
  if (!(binMs > 0)) {
    return;
  }
  /*
   * A scan over the 24 known column spans rather than the division this
   * replaced (ISS-5844). Division needs every column to be `columnMs` wide,
   * which is precisely what a DST transition falsifies at `12h`, and it was
   * also what forced the old clamp: unclamped bounds derived from the SOURCE
   * span meant a corrupt far-future `lastActivityAt` — `buildWindow` checks
   * finiteness and ordering but not magnitude — could spin the renderer through
   * millions of iterations the `columns[index]` guard then discarded. Bounding
   * the loop by the columns that can possibly receive anything removes that
   * failure mode by construction, and 24 iterations over at most 40 source bins
   * is nothing.
   */
  for (const [index, column] of columns.entries()) {
    const columnStartMs = edges[index];
    const columnEndMs = edges[index + 1];
    if (columnStartMs == null || columnEndMs == null) {
      continue;
    }
    const overlapMs =
      Math.min(binEndMs, columnEndMs) - Math.max(binStartMs, columnStartMs);
    if (overlapMs <= 0) {
      continue;
    }
    const share = overlapMs / binMs;
    column.cIn += bucket.cIn * share;
    column.cOut += bucket.cOut * share;
    column.cCache += bucket.cCache * share;
    column.total += bucket.total * share;
    column.toolStart += bucket.toolStart * share;
    for (const [model, costs] of Object.entries(bucket.byModel)) {
      const target = column.byModel[model] ?? { cCache: 0, cIn: 0, cOut: 0 };
      target.cIn += costs.cIn * share;
      target.cOut += costs.cOut * share;
      target.cCache += costs.cCache * share;
      column.byModel[model] = target;
    }
    /*
     * The jump target is the EARLIEST transcript row any overlapping source bin
     * carries, never a shared-out fraction: a row index is an identity, not a
     * quantity. Taking the minimum keeps a click on a column landing at the top
     * of what that column covers, which is what the bar's own tooltip promises.
     */
    if (bucket.tl0 != null && (column.tl0 == null || bucket.tl0 < column.tl0)) {
      column.tl0 = bucket.tl0;
    }
  }
}

/** The two `ActivityBucket` fields that are COUNTS rather than money. */
const COUNT_FIELDS = ["toolStart", "total"] as const;

/**
 * `total` and `toolStart` are COUNTS. Sharing them out proportionally leaves
 * fractions, and a tooltip reading "2.4 events" is not a thing that happened, so
 * they have to become integers — but INDEPENDENTLY rounding each column is how a
 * chart invents or deletes data (#4753 review, whitlockk + codex).
 *
 * Independent rounding is wrong in BOTH directions, and neither is exotic. One
 * event spread across twelve `5m` columns gives every column `0.083`, which
 * rounds to `0` twelve times: the tooltip row for a column that genuinely holds
 * the session's only event reads "0 events", and the event is gone from the
 * whole strip. One event split evenly across two columns gives each `0.5`, which
 * rounds UP twice: one event becomes two.
 *
 * So the rounding is APPORTIONED (largest-remainder / Hamilton) rather than
 * per-column: floor every column, then hand the integer shortfall to the columns
 * with the largest discarded fractions. The visible counts then sum to the
 * rounded total of what actually landed in the window, which is the same
 * conservation promise the money side of this module already makes.
 *
 * Conservation is over the WINDOW, not the session — counts belonging to bins
 * outside the visible window were never accumulated, exactly as their cost was
 * not. `subColumnSource` remains how the reader is told a column narrower than
 * its source bin is interpolated rather than separately measured.
 */
function apportionColumnCounts(columns: ActivityBucket[]): void {
  for (const field of COUNT_FIELDS) {
    const apportioned = apportionLargestRemainder(
      columns.map((column) => column[field])
    );
    for (const [index, column] of columns.entries()) {
      column[field] = apportioned[index] ?? 0;
    }
  }
}

/**
 * Round a list of non-negative fractional counts to integers that still sum to
 * the rounded total of the input.
 */
function apportionLargestRemainder(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  /*
   * A non-finite total means a non-finite contribution reached the accumulator,
   * and there is no honest integer split of `NaN`. Zero the counts rather than
   * render `NaN events`; the money fields are guarded at their own boundary and
   * the column still draws.
   */
  if (!Number.isFinite(total)) {
    return values.map(() => 0);
  }
  const floors = values.map((value) => Math.floor(value));
  const apportioned = [...floors];
  let remaining =
    Math.round(total) - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = values
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index
    );
  for (const entry of byRemainder) {
    if (remaining <= 0) {
      break;
    }
    apportioned[entry.index] += 1;
    remaining -= 1;
  }
  return apportioned;
}

/**
 * Re-anchor a marker onto the visible window, dropping the ones that fall
 * outside it.
 *
 * Dropping rather than clamping is deliberate: a clamped marker would pile every
 * off-window commit onto the window's first or last column and claim events
 * happened at a time they did not.
 */
function projectMarkers({
  edges,
  markers,
  source,
  windowEndMs,
  windowStartMs,
}: {
  edges: readonly number[];
  markers: readonly ActivityMarker[];
  source: TimelineSourceStrip;
  windowEndMs: number;
  windowStartMs: number;
}): ActivityMarker[] {
  const sourceSpanMs = Math.max(1, source.endMs - source.startMs);
  /*
   * #4753 review (whitlockk + codex): the window's END is EXCLUSIVE, except at the
   * end of the run. A producer legitimately emits `x === 100` for the session's
   * terminal commit/failure/limit, and when the session fills the selected
   * window that lands exactly on `windowEndMs` — an exclusive test then DROPS
   * the final dot, which the bucket mapper this projection replaces clamps into
   * the last cell. Exclusivity still holds everywhere it is doing real work: on
   * a window with more session after it, a marker on the boundary belongs to the
   * NEXT window's first column, and admitting it here would draw it twice as the
   * reader pans across.
   */
  const includeEndBoundary = windowEndMs >= source.endMs;
  const projected: ActivityMarker[] = [];
  for (const marker of markers) {
    const markerMs = resolveMarkerMs(marker, source, sourceSpanMs);
    // `NaN` fails every comparison, so a non-finite instant would slip past the
    // window test below and render `left: NaN%`. Named explicitly.
    if (!Number.isFinite(markerMs)) {
      continue;
    }
    if (markerMs < windowStartMs || markerMs > windowEndMs) {
      continue;
    }
    if (markerMs === windowEndMs && !includeEndBoundary) {
      continue;
    }
    projected.push({
      ...marker,
      x: markerColumnPercent(markerMs, edges),
    });
  }
  return projected;
}

/**
 * A marker's position as a percentage of the WINDOW'S WIDTH, measured in
 * columns rather than in elapsed time (ISS-5844).
 *
 * The strip draws 24 columns of equal PIXEL width, so a dot's offset has to be
 * proportional to the columns it sits past, not to the milliseconds. Those two
 * answers are identical while every column is the same duration — which is why
 * the time-linear form this replaced was correct until now — and they diverge
 * exactly where a `12h` column absorbs a DST transition: a time-linear dot
 * inside a 13-hour column drifts toward the wrong bar. Interpolating within the
 * containing column keeps a dot over the bar whose tooltip claims it.
 */
function markerColumnPercent(
  markerMs: number,
  edges: readonly number[]
): number {
  for (let index = 0; index < TIMELINE_VISIBLE_COLUMNS; index += 1) {
    const columnStartMs = edges[index];
    const columnEndMs = edges[index + 1];
    if (columnStartMs == null || columnEndMs == null) {
      continue;
    }
    if (markerMs >= columnEndMs) {
      continue;
    }
    const columnMs = columnEndMs - columnStartMs;
    const withinColumn =
      columnMs > 0 ? (markerMs - columnStartMs) / columnMs : 0;
    return ((index + withinColumn) / TIMELINE_VISIBLE_COLUMNS) * 100;
  }
  // The end-of-run marker admitted on the window's closing boundary.
  return 100;
}

/**
 * The wall-clock instant a marker is plotted at.
 *
 * `atMs` WINS over `x` when the producer supplied one (#4753 review, whitlockk).
 * `x` is only a wall-clock fraction on the PERSISTED marker path, where
 * `resolvePersistedMarkerPercent` derives it against this same session window.
 * The fallback path — `buildTurnMarker`, used whenever a session has no
 * persisted markers — derives `x` from the turn's ORDINAL (`index / (total-1)`),
 * so on a two-hour run whose second of three turns fires one minute in, reading
 * that `50` as a clock fraction plots the dot an hour late, at a time nothing
 * happened. The bucket strip this replaced never noticed, because it consumed
 * the same ordinal geometry the value was produced in; a clock window does not
 * have that luxury, so the producer hands over the instant instead.
 *
 * An unparseable timestamp yields `NaN`, which falls back to `x` rather than
 * dropping the marker — the ordinal position is a worse answer than the clock,
 * but it is a better answer than no dot at all.
 */
function resolveMarkerMs(
  marker: ActivityMarker,
  source: TimelineSourceStrip,
  sourceSpanMs: number
): number {
  if (marker.atMs != null && Number.isFinite(marker.atMs)) {
    return marker.atMs;
  }
  return source.startMs + (marker.x / 100) * sourceSpanMs;
}

/**
 * A prototype-less map for keys that come off the WIRE.
 *
 * A model name is a bounded FREE STRING, not a closed union — it is whatever the
 * producer reported, and nothing validates it against a list. On a plain `{}`, a
 * bucket keyed `__proto__` makes `map[model] ?? 0` resolve to `Object.prototype`
 * rather than `0`, so the accumulator adds a number to an object and the
 * assignment mutates the prototype. `Object.create(null)` removes the whole
 * class of that (see AGENTS.md, "Build event-dispatch tables and handler
 * registries with `Object.create(null)`").
 */
function emptyStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * One bin's producer-measured bounds, or `null` when it did not carry usable
 * ones.
 *
 * `binStartMs`/`binEndMs` are OPTIONAL wire fields off a cross-repo payload, so
 * the in-process types do not constrain them: a version-skewed producer omits
 * them, and a corrupt row can carry `NaN` (a bound that fails every comparison
 * and would otherwise put `NaN` cost into a column). Both are answered the same
 * way — this bin has no clock — rather than repaired into a guess.
 */
export function resolveProducerBinBounds(
  bucket: ActivityBucket
): ProducerBinBounds | null {
  const { binEndMs, binStartMs } = bucket;
  if (binStartMs == null || binEndMs == null) {
    return null;
  }
  if (!(Number.isFinite(binStartMs) && Number.isFinite(binEndMs))) {
    return null;
  }
  /*
   * `!(end > start)` rather than `end < start`, so a ZERO-WIDTH bin is refused
   * too. `accumulateSourceBin` drops a non-positive bin (its `binMs > 0` guard),
   * so admitting one here would let a strip pass the all-or-nothing gate and
   * then silently lose that bin's money on the way to the columns — the exact
   * outcome {@link hasProducerBinBounds} exists to prevent. Unreachable from
   * either current producer (both floor their span at 1ms) but reachable from a
   * corrupt persisted row, which is parse-boundary input the types do not
   * constrain.
   */
  if (!(binEndMs > binStartMs)) {
    return null;
  }
  return { endMs: binEndMs, startMs: binStartMs };
}

/**
 * Whether a strip may be projected onto a clock at all.
 *
 * EVERY bin must carry bounds, not merely some: a strip where half the bins know
 * their clock projects half its money onto the window and silently drops the
 * rest, which reads as a session that stopped spending. All-or-nothing keeps the
 * two honest outcomes — the whole strip re-projected, or the whole strip left on
 * its ordinal bars — and nothing in between.
 *
 * An EMPTY strip is not projectable either. There is nothing to place, and
 * `[].every(...)` is vacuously `true`, which would hand the caller a 24-column
 * clock grid built for a session that has no bars at all.
 */
export function hasProducerBinBounds(
  buckets: readonly ActivityBucket[]
): boolean {
  return (
    buckets.length > 0 &&
    buckets.every((bucket) => resolveProducerBinBounds(bucket) != null)
  );
}

/**
 * The instant halfway through one source bin, as the producer measured it, or
 * `null` when it carried no usable bounds.
 *
 * Exported so the one other place that needs "where in the clock is this bin"
 * — resolving the reader's transcript row to a column — asks the SAME bounds the
 * bars are drawn from, rather than re-deriving a bin width by dividing some
 * window by the bin count. Two derivations is how the marker ends up over a
 * different bar than the money.
 */
export function resolveBinMidpointMs(bucket: ActivityBucket): number | null {
  const bounds = resolveProducerBinBounds(bucket);
  if (bounds == null) {
    return null;
  }
  return bounds.startMs + (bounds.endMs - bounds.startMs) / 2;
}

/**
 * ISS-5850 — the producer's measured extent, off the wire, or `null` when it did
 * not state a usable one.
 *
 * `startMs`/`endMs` are OPTIONAL cross-repo wire fields, so the in-process types
 * do not constrain them at runtime: a version-skewed desktop build omits both, a
 * partially-upgraded one can send a single half, and a corrupt persisted row can
 * carry a non-finite or inverted pair. Every one of those is answered the same
 * way — this producer did not tell us what it measured — rather than repaired
 * into a guess, because a guessed extent is precisely the assumption this field
 * exists to remove.
 *
 * Refusing a HALF-STATED extent is the case worth naming: taking `startMs` alone
 * and pairing it with the rendered window's end would manufacture a coverage
 * claim out of one real number and one borrowed one, which reads to the consumer
 * exactly like a measured extent and is not one.
 */
export function resolveTimelineSourceExtent(
  span: { endMs?: number; startMs?: number } | null | undefined
): TimelineSourceExtent | null {
  if (span == null) {
    return null;
  }
  const { endMs, startMs } = span;
  if (startMs == null || endMs == null) {
    return null;
  }
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) {
    return null;
  }
  /*
   * `!(end > start)` rather than `end < start`, so a ZERO-WIDTH extent is
   * refused too: it would mark every column in the window unmeasured, turning a
   * degenerate producer value into a strip that claims it knows nothing.
   */
  if (!(endMs > startMs)) {
    return null;
  }
  return { endMs, startMs };
}

/**
 * ISS-5850 — what backs each rendered column, resolved once per projection.
 *
 * OVERLAP, NOT CONTAINMENT, is the rule, and the boundary columns are why. A
 * column that straddles the edge of the extent holds real measured cost for the
 * part the producer covered and nothing for the rest; that value is measured,
 * just over less time than the column's full width. Marking it unmeasured would
 * withdraw a true figure, and on a session whose extent begins mid-column that
 * is the very column the run starts in. Any overlap at all therefore reads as
 * measured, and only a column the extent does not reach AT ALL is withdrawn.
 *
 * `Unknown` is not a third flavour of `Unmeasured`: absence of an extent is a
 * fact about the PRODUCER (a build that predates the field), while `Unmeasured`
 * is a fact about the INTERVAL. Folding them together would either withhold
 * every column on every older payload — deleting the strip for most of the
 * installed base — or claim coverage nobody stated. The caller decides what to
 * say for each; this only refuses to conflate them.
 */
function resolveColumnCoverage({
  buckets,
  edges,
  extent,
}: {
  buckets: readonly ActivityBucket[];
  edges: readonly number[];
  extent: TimelineSourceExtent | null;
}): TimelineColumnCoverage[] {
  return Array.from({ length: TIMELINE_VISIBLE_COLUMNS }, (_, index) => {
    if (extent == null) {
      return TimelineColumnCoverage.Unknown;
    }
    /*
     * THE BINS OUTRANK THE STATED EXTENT (code review). A column a bin actually
     * deposited into holds an observation, and no claim about the extent can
     * make that observation go away — so a stale, corrupt, or foreign extent
     * can never withdraw a figure the reader can see. Without this the only
     * input is the extent, and the failure is silent and inverted: the strip
     * withholds a bar it is simultaneously drawing.
     */
    if (hasDepositedContent(buckets[index])) {
      return TimelineColumnCoverage.Measured;
    }
    const columnStartMs = edges[index];
    const columnEndMs = edges[index + 1];
    if (columnStartMs == null || columnEndMs == null) {
      return TimelineColumnCoverage.Unknown;
    }
    const overlapMs =
      Math.min(columnEndMs, extent.endMs) -
      Math.max(columnStartMs, extent.startMs);
    return overlapMs > 0
      ? TimelineColumnCoverage.Measured
      : TimelineColumnCoverage.Unmeasured;
  });
}

/**
 * Whether any source bin landed anything in this column.
 *
 * Deliberately wider than cost: a bin can carry events or tool calls at zero
 * dollars, and that is still an observation of the interval. Only a column with
 * nothing at all on any axis is a candidate for being withdrawn.
 */
function hasDepositedContent(bucket: ActivityBucket | undefined): boolean {
  if (bucket == null) {
    return false;
  }
  return (
    bucket.cIn > 0 ||
    bucket.cOut > 0 ||
    bucket.cCache > 0 ||
    bucket.total > 0 ||
    bucket.toolStart > 0
  );
}
