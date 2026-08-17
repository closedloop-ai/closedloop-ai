/**
 * ISS-5819 — the Session Timeline's CLOCK WINDOW.
 *
 * The strip used to have no window at all. Its column count was derived from the
 * session's duration by whoever produced the bars — up to
 * `SESSION_TRACE_BUCKET_TARGET` (40) uniform bins from the desktop collector, or
 * 48 / 32 / `min(16, max(4, rowCount))` from the web-side synthesizer — so two
 * sessions of different lengths drew different numbers of bars, each bar meaning
 * a different amount of time, with no control anywhere to say what a bar should
 * mean. A reader could not compare two sessions, and could not zoom.
 *
 * This module is the missing model: a fixed {@link TIMELINE_VISIBLE_COLUMNS}
 * -column window whose columns are aligned to a chosen wall-clock
 * {@link TimelineScale}, panned by a window start. The scale toggle picks the
 * column width, the window start picks which stretch of the session those 24
 * columns cover, and the bar count stops moving.
 *
 * Mirrors the prototype's `apps/prototypes/app/p/sessions/timeline-model.ts`,
 * which is the source of truth for this screen. It is re-declared rather than
 * imported because `apps/prototypes` is a presentational sandbox that production
 * must not depend on; the four scale values, the 24-column constant and the
 * `defaultTimelineScale` thresholds are held byte-identical to it on purpose.
 */

/**
 * The four column widths the scale toggle offers, keyed by the label the control
 * prints. The VALUE is the printed label — the prototype's toggle renders the
 * option string directly, so a separate display map would be a second source of
 * truth for four strings.
 */
export const TimelineScale = {
  FiveMinutes: "5m",
  FifteenMinutes: "15m",
  OneHour: "1h",
  TwelveHours: "12h",
} as const;

export type TimelineScale = (typeof TimelineScale)[keyof typeof TimelineScale];

/** Toggle order, coarsening left to right. */
export const TIMELINE_SCALE_OPTIONS: readonly TimelineScale[] = [
  TimelineScale.FiveMinutes,
  TimelineScale.FifteenMinutes,
  TimelineScale.OneHour,
  TimelineScale.TwelveHours,
];

export const SCALE_MINUTES: Record<TimelineScale, number> = {
  [TimelineScale.FiveMinutes]: 5,
  [TimelineScale.FifteenMinutes]: 15,
  [TimelineScale.OneHour]: 60,
  [TimelineScale.TwelveHours]: 12 * 60,
};

/**
 * The window is always this many columns wide, at every scale and on every
 * session. That invariant is the whole point: it is what makes a bar's width
 * mean a fixed amount of time, and it is what the scrubber pans.
 */
export const TIMELINE_VISIBLE_COLUMNS = 24;

const MS_PER_MINUTE = 60_000;

/**
 * The scale a session opens on: the finest one whose 24 columns still cover the
 * whole run, so a session that fits needs no scrubbing to see all of it.
 *
 * ASKED OF THE GEOMETRY, NOT OF THE DURATION (#4753 review, wongk). The
 * prototype's thresholds (`2h`, `6h`, `24h`) are exactly `24 x` each column
 * width, which is the right answer only if column 0 starts when the session
 * does. It does not: {@link resolveTimelineScaleGeometry} FLOORS the origin to a
 * clock boundary, so a run that begins mid-column spends part of its first
 * column on time before it started and needs one more column than its duration
 * implies. A two-hour session starting at 09:01 needs 25 five-minute columns,
 * not 24 — so the duration test opened it at `5m` with its last minute off-window
 * and a scrubber on screen, breaking the very contract the default exists to
 * keep. Resolving each candidate's real geometry and taking the first that fits
 * cannot drift from that contract, because it IS the contract: `maxWindowStart
 * === 0` is also what hides the scrubber.
 *
 * A run too long for 24 x 12h opens at `12h` and is scrubbed.
 *
 * This is where the module deliberately stops mirroring the prototype's
 * `timeline-model.ts` byte for byte: the prototype has the same latent bug, and
 * copying it a second time is not fidelity.
 */
export function defaultTimelineScale({
  endMs,
  startMs,
}: {
  endMs: number;
  startMs: number;
}): TimelineScale {
  for (const scale of TIMELINE_SCALE_OPTIONS) {
    const geometry = resolveTimelineScaleGeometry({ endMs, scale, startMs });
    if (geometry.maxWindowStart <= 0) {
      return scale;
    }
  }
  return TimelineScale.TwelveHours;
}

/**
 * The geometry a session + scale imply, before any panning.
 *
 * `originMs` is the session start floored to a scale boundary, so a `1h` column
 * starts on the hour rather than on whatever minute the session happened to
 * begin. That alignment is why the columns are readable as clock time at all —
 * unaligned columns would print `9:07`, `10:07`, `11:07`.
 */
export type TimelineScaleGeometry = {
  /** Clock-aligned instant column 0 of the WHOLE timeline starts at. */
  readonly originMs: number;
  /** Column width in ms. */
  readonly columnMs: number;
  /** Columns needed to cover the session from `originMs`. Always >= 1. */
  readonly totalColumns: number;
  /**
   * Largest legal window start. `0` when the session fits in one window — which
   * is also the prototype's condition for hiding the scrubber, so the scrubber's
   * visibility and the window's pannability are one answer, not two.
   */
  readonly maxWindowStart: number;
};

export function resolveTimelineScaleGeometry({
  endMs,
  scale,
  startMs,
}: {
  endMs: number;
  scale: TimelineScale;
  startMs: number;
}): TimelineScaleGeometry {
  const columnMs = SCALE_MINUTES[scale] * MS_PER_MINUTE;
  const originMs = floorToLocalColumnBoundary(startMs, scale);
  // `max(1, …)`: a zero-length or clock-skewed span still draws one column
  // rather than an empty strip that reads as "no activity".
  const totalColumns = Math.max(
    1,
    countColumnsToCover({ endMs, originMs, scale })
  );
  return {
    columnMs,
    maxWindowStart: Math.max(0, totalColumns - TIMELINE_VISIBLE_COLUMNS),
    originMs,
    totalColumns,
  };
}

/** Clamp a requested window start into `[0, maxWindowStart]`. */
export function clampTimelineWindowStart(
  windowStart: number,
  maxWindowStart: number
): number {
  if (!Number.isFinite(windowStart)) {
    return 0;
  }
  return Math.max(0, Math.min(maxWindowStart, Math.round(windowStart)));
}

/**
 * The window start that keeps `activeColumn` in view, panning by the minimum
 * needed. Mirrors the prototype's `timelineWindowStart`.
 */
export function followTimelineWindowStart({
  activeColumn,
  currentWindowStart,
  maxWindowStart,
}: {
  activeColumn: number;
  currentWindowStart: number;
  maxWindowStart: number;
}): number {
  if (activeColumn < currentWindowStart) {
    return clampTimelineWindowStart(activeColumn, maxWindowStart);
  }
  if (activeColumn >= currentWindowStart + TIMELINE_VISIBLE_COLUMNS) {
    return clampTimelineWindowStart(
      activeColumn - TIMELINE_VISIBLE_COLUMNS + 1,
      maxWindowStart
    );
  }
  return clampTimelineWindowStart(currentWindowStart, maxWindowStart);
}

/**
 * Re-centre the window on the instant it was already centred on, after a scale
 * change. Without this, changing `12h` to `5m` would snap the reader back to the
 * start of the session and lose the stretch they were looking at.
 */
export function recentreWindowStartForScale({
  endMs,
  nextScale,
  startMs,
  visibleMidpointMs,
}: {
  endMs: number;
  nextScale: TimelineScale;
  startMs: number;
  visibleMidpointMs: number;
}): number {
  const geometry = resolveTimelineScaleGeometry({
    endMs,
    scale: nextScale,
    startMs,
  });
  // ISS-5844: the column the instant is really IN, not the one the division
  // implies — those differ once a `12h` window has absorbed a DST transition.
  const centredStart =
    resolveTimelineColumnIndex({
      instantMs: visibleMidpointMs,
      originMs: geometry.originMs,
      scale: nextScale,
    }) -
    TIMELINE_VISIBLE_COLUMNS / 2;
  return clampTimelineWindowStart(centredStart, geometry.maxWindowStart);
}

/**
 * Floor an instant to the previous column boundary IN THE VIEWER'S TIMEZONE.
 *
 * TIMEZONE — the choice, stated because a wall-clock axis forces one. The window
 * is anchored to the VIEWER'S local clock, not UTC and not the session's origin
 * machine. Two reasons, and they point the same way: the axis ticks, the column
 * labels and the bucket tooltips are all formatted by `formatTime`, which
 * renders local — so a UTC-anchored boundary would print a "9:30–10:30" column
 * to anyone on a half-hour offset (IST, NPT, Chatham), an axis visibly not on
 * the hour it claims. And the session's own timezone is not on the read
 * contract at all: `AgentSessionDetail` carries instants, never a zone, so
 * anchoring to the origin machine is not something this module could do
 * honestly even if it were the better answer.
 *
 * `epochMs % columnMs` — the arithmetic this replaced — is UTC flooring wearing
 * a disguise, since the epoch's own zero is UTC midnight.
 *
 * DST — ISS-5844 (AC5). Every column boundary, not just the origin, is now a
 * LOCAL CLOCK boundary; see {@link timelineColumnStartMs}, which is the single
 * place a column's start instant is computed and the reason a transition can no
 * longer drift the axis.
 */
function floorToLocalColumnBoundary(
  startMs: number,
  scale: TimelineScale
): number {
  const anchored = new Date(startMs);
  if (scale === TimelineScale.TwelveHours) {
    // The two halves of the local day: midnight and noon.
    anchored.setHours(anchored.getHours() < 12 ? 0 : 12, 0, 0, 0);
    return anchored.getTime();
  }
  const columnMinutes = SCALE_MINUTES[scale];
  if (columnMinutes >= 60) {
    anchored.setMinutes(0, 0, 0);
    return anchored.getTime();
  }
  anchored.setMinutes(
    Math.floor(anchored.getMinutes() / columnMinutes) * columnMinutes,
    0,
    0
  );
  return anchored.getTime();
}

/**
 * ISS-5844 (AC5) — the instant column `columnIndex` STARTS at. The single source
 * of truth for a column boundary; every other module asks this rather than
 * multiplying, which is what makes the axis DST-correct everywhere at once.
 *
 * WHY TWO BRANCHES, AND WHY THAT IS NOT AN INCONSISTENCY. A column boundary has
 * to be two things at once: on the viewer's local clock, and monotonic. The two
 * branches are two different ways of buying both, chosen by which one the scale
 * makes affordable.
 *
 * Below `12h` the fixed-width step is kept and the result is SNAPPED back onto
 * the local grid (see {@link localColumnRemainderMs}). Fixed-width alone is not
 * enough — an earlier revision of this comment claimed it was, on the grounds
 * that every UTC-offset shift divides 5, 15 and 60 minutes exactly. That is
 * false for the zones whose DST shift is a HALF hour: `Australia/Lord_Howe`
 * moves 30 minutes, which divides 5 and 15 but NOT 60, so from the transition
 * onward every `1h` boundary sat at :30 past the local hour — 01:00, 02:30,
 * 03:30, 04:30 — and stayed there for the rest of the axis (#4869 review). The
 * snap is a provable no-op in every whole-hour zone, so it corrects that case
 * without touching any other.
 *
 * Calendar arithmetic would be strictly WORSE below `12h`: on a spring-forward
 * day the 02:00 hour does not exist, so `setHours(2)` and `setHours(3)` both
 * normalise to 03:00 and two adjacent columns would collapse onto one instant.
 * Re-deriving the boundary through the wall clock is just as bad in the other
 * direction — flooring an AMBIGUOUS local time (the repeated 01:00 of a
 * fall-back) resolves to the earlier occurrence, collapsing the pair. The snap
 * below avoids both by subtracting a real-millisecond remainder and never
 * round-tripping an instant through a local wall time.
 *
 * At `12h` fixed-width is the branch that breaks. The origin is local midnight
 * or noon, but `origin + n x 12h` of REAL time lands at 11:00 or 13:00 for the
 * rest of a window that crosses a transition, so the axis silently stops being
 * on the half-day it claims. Advancing the local hour instead gives that one
 * column its true 11- or 13-hour width and puts the following boundary back on
 * the local half-day — the variable-width column the previous revision of this
 * module deferred to this ticket.
 */
export function timelineColumnStartMs({
  columnIndex,
  originMs,
  scale,
}: {
  columnIndex: number;
  originMs: number;
  scale: TimelineScale;
}): number {
  if (scale !== TimelineScale.TwelveHours) {
    const candidateMs =
      originMs + columnIndex * SCALE_MINUTES[scale] * MS_PER_MINUTE;
    return snapToLocalColumnBoundary(candidateMs, scale);
  }
  const anchored = new Date(originMs);
  // `setHours` is LOCAL calendar arithmetic: an hour count past 23 rolls into
  // the following days honouring whatever offset each of them is really on.
  anchored.setHours(
    anchored.getHours() + columnIndex * TWELVE_HOUR_COLUMN,
    0,
    0,
    0
  );
  return anchored.getTime();
}

/**
 * The column an instant falls in — the inverse of {@link timelineColumnStartMs},
 * and the reason no caller has to divide.
 *
 * The division is only ever an ESTIMATE, because a column is not reliably
 * `columnMs` of real time: at `12h` accumulated DST drift unproportions elapsed
 * time and column count, and below `12h` a fractional-offset zone's snap makes
 * the column at a transition narrower than its siblings (#4869 review). The
 * estimate is therefore walked onto the true column AT EVERY SCALE — the walk
 * costs nothing when the estimate is already exact, which is every column in
 * every whole-hour zone, because it exits on its first pass.
 *
 * The walk is bounded by {@link MAX_COLUMN_INDEX_CORRECTION} rather than left
 * open: drift accrues at most about an hour per transition, so a correct answer
 * is always within a step or two of the estimate, and a bound means a corrupt
 * far-future instant cannot spin the renderer.
 */
export function resolveTimelineColumnIndex({
  instantMs,
  originMs,
  scale,
}: {
  instantMs: number;
  originMs: number;
  scale: TimelineScale;
}): number {
  const columnMs = SCALE_MINUTES[scale] * MS_PER_MINUTE;
  const estimate = Math.floor((instantMs - originMs) / columnMs);
  if (!Number.isFinite(estimate)) {
    return 0;
  }
  let index = estimate;
  for (let step = 0; step < MAX_COLUMN_INDEX_CORRECTION; step += 1) {
    if (
      timelineColumnStartMs({ columnIndex: index, originMs, scale }) > instantMs
    ) {
      index -= 1;
      continue;
    }
    if (
      timelineColumnStartMs({ columnIndex: index + 1, originMs, scale }) <=
      instantMs
    ) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * The {@link TIMELINE_VISIBLE_COLUMNS} + 1 boundaries of the window starting at
 * `windowStart`, as instants.
 *
 * EDGES RATHER THAN A WIDTH is the whole point: a consumer handed `columnMs`
 * has to assume every column is that wide, which is exactly the assumption a
 * DST transition falsifies. Handed the edges, a consumer reads each column's
 * real span off the array and cannot make that assumption by accident.
 */
export function resolveTimelineWindowEdges({
  originMs,
  scale,
  windowStart,
}: {
  originMs: number;
  scale: TimelineScale;
  windowStart: number;
}): number[] {
  return Array.from({ length: TIMELINE_VISIBLE_COLUMNS + 1 }, (_, offset) =>
    timelineColumnStartMs({
      columnIndex: windowStart + offset,
      originMs,
      scale,
    })
  );
}

/** Columns needed for the window to reach `endMs`, DST included. */
function countColumnsToCover({
  endMs,
  originMs,
  scale,
}: {
  endMs: number;
  originMs: number;
  scale: TimelineScale;
}): number {
  const columnMs = SCALE_MINUTES[scale] * MS_PER_MINUTE;
  const estimate = Math.ceil(Math.max(0, endMs - originMs) / columnMs);
  if (!Number.isFinite(estimate)) {
    return 1;
  }
  /*
   * Same bounded walk as `resolveTimelineColumnIndex`, in the covering
   * direction: the count is right when the last boundary has reached `endMs`
   * and the one before it has not. Runs at every scale for the same reason the
   * index walk does — a fractional-offset zone's `1h` column at a transition is
   * narrower than `columnMs`, so the ceiling can be one short (#4869 review).
   */
  let columns = Math.max(1, estimate);
  for (let step = 0; step < MAX_COLUMN_INDEX_CORRECTION; step += 1) {
    if (
      timelineColumnStartMs({ columnIndex: columns, originMs, scale }) < endMs
    ) {
      columns += 1;
      continue;
    }
    if (
      columns > 1 &&
      timelineColumnStartMs({ columnIndex: columns - 1, originMs, scale }) >=
        endMs
    ) {
      columns -= 1;
      continue;
    }
    return columns;
  }
  return columns;
}

/** Local hours in a `12h` column. */
const TWELVE_HOUR_COLUMN = 12;

/**
 * How far a `12h` estimate may be walked, shared by
 * {@link resolveTimelineColumnIndex} and {@link countColumnsToCover}.
 *
 * WHY A SMALL CONSTANT SUFFICES EVEN THOUGH THE SPAN IS UNBOUNDED (#review).
 * The two callers have different domains — the index walk is asked about an
 * instant inside a 12-day window, but `countColumnsToCover` runs over a whole
 * session, and `defaultTimelineScale` calls it on spans this module cannot
 * bound. So "two transitions can't fit in one window" is NOT the argument; the
 * argument is that the error being corrected does not ACCUMULATE.
 *
 * The estimate's error is `(real elapsed) - (columns x 12h)`, which is the
 * cumulative UTC-offset change between the origin and the target instant. DST
 * transitions alternate in sign and a zone returns to the same offset every
 * year, so that sum is bounded by ONE transition's size — about an hour,
 * never a running total — no matter how many years apart the two instants are.
 * A session spanning a decade is therefore still one or two steps out, exactly
 * like one spanning a week.
 *
 * The bound is nonetheless a real ceiling and not a formality: a corrupt or
 * far-future instant that no walk could reconcile exits after four steps rather
 * than spinning the renderer. `session-timeline-dst.test.ts` covers both the
 * multi-year case and the non-finite/corrupt case.
 */
const MAX_COLUMN_INDEX_CORRECTION = 4;

/**
 * How far past its own local column boundary `instantMs` sits, in REAL
 * milliseconds (#4869 review).
 *
 * Read off the local calendar fields and returned as a duration — deliberately
 * NOT by flooring the instant through `setMinutes`. That round trip re-derives
 * an instant FROM a local wall time, and a wall time is not always a unique
 * instant: the repeated 01:00 of a fall-back resolves to the earlier
 * occurrence, so flooring the second 01:00 walks it back a whole hour onto the
 * first and two adjacent columns collapse. A remainder is immune to that
 * because it never converts in that direction.
 */
function localColumnRemainderMs(
  instantMs: number,
  scale: TimelineScale
): number {
  const columnMinutes = SCALE_MINUTES[scale];
  const local = new Date(instantMs);
  const minutesIntoColumn =
    columnMinutes >= 60
      ? local.getMinutes()
      : local.getMinutes() % columnMinutes;
  return (
    minutesIntoColumn * MS_PER_MINUTE +
    local.getSeconds() * 1000 +
    local.getMilliseconds()
  );
}

/**
 * `candidateMs` pulled back onto the local column grid, when a boundary is
 * actually there to land on (#4869 review).
 *
 * WHY THE SECOND CHECK. Subtracting the remainder normally lands exactly on the
 * boundary, but on a FRACTIONAL spring-forward the boundary it aims at does not
 * exist: `Australia/Lord_Howe` skips 02:00–02:30, so pulling 02:30 back by 30
 * minutes lands on 01:30 of the previous hour rather than on 02:00. Re-asking
 * for the remainder detects exactly that — a real boundary has none — and the
 * candidate is kept, which is the first instant of that column that exists at
 * all. One transition column is therefore off-grid and every column after it is
 * back on, instead of the whole axis drifting.
 *
 * MONOTONIC BY CONSTRUCTION, which is the property the callers depend on: the
 * remainder is always less than one column, so a snapped boundary can never
 * reach back to its predecessor's candidate, let alone past it.
 */
function snapToLocalColumnBoundary(
  candidateMs: number,
  scale: TimelineScale
): number {
  const remainderMs = localColumnRemainderMs(candidateMs, scale);
  if (remainderMs === 0) {
    return candidateMs;
  }
  const snappedMs = candidateMs - remainderMs;
  return localColumnRemainderMs(snappedMs, scale) === 0
    ? snappedMs
    : candidateMs;
}
