import type {
  ActivityBucket,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { useSessionTimelineScale } from "@repo/app/agents/hooks/use-session-timeline-scale";
import {
  alignBucketRowsToTranscript,
  buildTraceRowInstants,
} from "@repo/app/agents/lib/session-timeline-geometry";
import {
  recentreWindowStartForScale,
  resolveTimelineScaleGeometry,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { computeActiveTraceRow } from "@repo/app/shared/lib/active-trace-row";
import { act, renderHook } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ISS-5819 — the timeline's state model, driven directly.
 *
 * The component suite can only observe this hook through the rendered strip, and
 * two of its contracts are invisible from there: that a scale change PRESERVES
 * the instant the reader was centred on (a broken re-centre still changes the
 * axis, so the component assertion passes either way), and that a scrubbed
 * position survives a scale change as a TIME rather than as an index into the
 * old grid.
 *
 * Both were real defects found in review. A scrubbed column 40 of 41 at `12h`
 * became column 40 of 5760 at `5m` — the start of the session — and the reverse
 * handed the range input a value past its own `max`, announcing a column that
 * does not exist and dropping the "you are here" marker entirely.
 */

const TEST_TIMEZONE = "Asia/Kolkata";
const originalTimezone = process.env.TZ;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SESSION_START_MS = Date.UTC(2026, 5, 10, 9, 0, 0);
/** 20 days: long enough not to fit even at `12h`, so the scrubber is live. */
const SESSION_END_MS = SESSION_START_MS + 20 * 24 * HOUR_MS;

beforeAll(() => {
  process.env.TZ = TEST_TIMEZONE;
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("a scrubbed position survives a scale change", () => {
  it("carries the position across as an instant, not as a column index", () => {
    const { result } = renderHook(() => useTimelineScale());

    // Open at `12h`, scrub to the far end of the session.
    const openingTotal = result.current.scrubber?.totalColumns ?? 0;
    expect(openingTotal).toBeGreaterThan(TIMELINE_VISIBLE_COLUMNS);
    act(() => result.current.scrubber?.onPositionChange(openingTotal - 1));
    const scrubbedInstant = instantOf(
      result.current.scrubber?.position ?? 0,
      TimelineScale.TwelveHours
    );

    act(() => result.current.controls?.setScale(TimelineScale.FiveMinutes));

    const nextPosition = result.current.scrubber?.position ?? 0;
    const nextInstant = instantOf(nextPosition, TimelineScale.FiveMinutes);
    // Within one `12h` column of where the reader was — not back at column ~40
    // of 5760, which is the start of a 20-day run.
    expect(Math.abs(nextInstant - scrubbedInstant)).toBeLessThanOrEqual(
      12 * HOUR_MS
    );
    expect(nextPosition).toBeGreaterThan(1000);
  });

  it("never hands the slider a position past its own maximum", () => {
    const { result } = renderHook(() => useTimelineScale());

    act(() => result.current.controls?.setScale(TimelineScale.FiveMinutes));
    const fineTotal = result.current.scrubber?.totalColumns ?? 0;
    act(() => result.current.scrubber?.onPositionChange(fineTotal - 1));
    act(() => result.current.controls?.setScale(TimelineScale.TwelveHours));

    const { position = 0, totalColumns = 0 } = result.current.scrubber ?? {};
    expect(position).toBeLessThanOrEqual(totalColumns - 1);
    expect(position).toBeGreaterThanOrEqual(0);
    // The marker must still be somewhere on screen — the out-of-range case made
    // `getHerePercent` return null and the marker silently vanished.
    expect(result.current.herePercent).not.toBeNull();
  });

  it("keeps the marker and the thumb on the same column", () => {
    const { result } = renderHook(() => useTimelineScale());
    act(() => result.current.scrubber?.onPositionChange(20));

    const position = result.current.scrubber?.position ?? -1;
    expect(position).toBe(20);
    // One position model: the marker's percentage is the thumb's column,
    // expressed against the visible window.
    expect(result.current.herePercent).not.toBeNull();
  });
});

describe("the axis always describes the window that is drawn", () => {
  it("names the window even when the session fits inside it", () => {
    /*
     * The common case, not an edge case: `defaultTimelineScale` picks the
     * coarsest scale whose 24 columns COVER the run, so a session that fits is
     * the norm. Falling back to the session's own ticks there put a right-hand
     * tick days past the last bar.
     */
    const { result } = renderHook(() =>
      useTimelineScale({ endMs: SESSION_START_MS + 3 * HOUR_MS })
    );
    expect(result.current.scrubber).toBeNull();
    expect(result.current.windowedAxis).not.toBeNull();
    expect(result.current.windowedAxis?.span.first).not.toBe("");
    expect(result.current.windowedAxis?.span.last).not.toBe("");
  });
});

describe("the strip passes through when it cannot be honestly projected", () => {
  // ISS-5999 retired the `enabled` gate, so the flag-off arm this describe once
  // pinned no longer exists. Two branches share its outcome and both are
  // reachable: the detail read streams, so `resolveSessionTimelineWindow`
  // returns null until something plottable arrives — and a strip persisted
  // before producers carried bin bounds arrives with no clock of its own.
  it("passes the caller's own bars straight back when no window resolved", () => {
    const buckets = costedBins(40);
    const { result } = renderHook(() =>
      useSessionTimelineScale({
        activeRow: null,
        activeRowMs: null,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        sourceExtent: null,
        sourceWindow: null,
      })
    );
    expect(result.current.columns).toBe(buckets);
    expect(result.current.controls).toBeNull();
    expect(result.current.scrubber).toBeNull();
    expect(result.current.stacks).toBeNull();
    expect(result.current.windowedAxis).toBeNull();
  });

  it("projects onto controls once a window IS available", () => {
    // The counterfactual to the case above, and to the retired gate: the SAME
    // buckets with a resolvable window now yield the controls unconditionally.
    const buckets = costedBins(40);
    const { result } = renderHook(() =>
      useSessionTimelineScale({
        activeRow: null,
        activeRowMs: null,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        sourceExtent: null,
        sourceWindow: { endMs: SESSION_END_MS, startMs: SESSION_START_MS },
      })
    );
    expect(result.current.columns).not.toBe(buckets);
    expect(result.current.controls).not.toBeNull();
    expect(result.current.stacks).not.toBeNull();
  });

  it("stays on the ordinal strip when the bins carry no producer bounds", () => {
    /*
     * ISS-5819 review (whitlockk). A persisted strip is binned by the producer over
     * ITS OWN activity extent, and `sourceWindow` here is this page's axis
     * window — resolved from transcript / phase / lifecycle bounds, a different
     * clock. Spreading such bins across that window would move measured cost
     * into intervals the producer never established, so a strip that cannot say
     * which clock it was measured on is not projected at all.
     *
     * The counterfactual is the case directly above: the SAME bins, the SAME
     * window, differing only in whether the bins carry bounds, do project.
     */
    const buckets = unboundedBins(40);
    const { result } = renderHook(() =>
      useSessionTimelineScale({
        activeRow: null,
        activeRowMs: null,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        sourceExtent: null,
        sourceWindow: { endMs: SESSION_END_MS, startMs: SESSION_START_MS },
      })
    );
    expect(result.current.columns).toBe(buckets);
    expect(result.current.controls).toBeNull();
    expect(result.current.scrubber).toBeNull();
    expect(result.current.stacks).toBeNull();
    expect(result.current.subColumnSource).toBe(false);
  });

  it("refuses the projection when only SOME bins carry bounds", () => {
    // All-or-nothing: projecting the bounded half would put its money on the
    // clock and silently drop the rest, which reads as a run that stopped
    // spending halfway through.
    const bounded = costedBins(40);
    const buckets = bounded.map((bucket, index) =>
      index < 20
        ? bucket
        : { ...bucket, binEndMs: undefined, binStartMs: undefined }
    );
    const { result } = renderHook(() =>
      useSessionTimelineScale({
        activeRow: null,
        activeRowMs: null,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        sourceExtent: null,
        sourceWindow: { endMs: SESSION_END_MS, startMs: SESSION_START_MS },
      })
    );
    expect(result.current.columns).toBe(buckets);
    expect(result.current.controls).toBeNull();
  });
});

describe("the reader is told when a scale is finer than what was measured", () => {
  it("reports interpolation at a scale below the producer's bin width", () => {
    // 40 bins over 20 days is a 12-hour bin; `5m` columns are cut from inside
    // one, so those bars are interpolated rather than separately measured.
    const { result } = renderHook(() => useTimelineScale());
    act(() => result.current.controls?.setScale(TimelineScale.FiveMinutes));

    expect(result.current.subColumnSource).toBe(true);
  });

  it("reports none at a scale at or above the producer's bin width", () => {
    // The counterfactual: same strip, same hook, a scale no finer than the bins
    // it was measured in — nothing is interpolated and nothing is claimed.
    const { result } = renderHook(() => useTimelineScale());
    act(() => result.current.controls?.setScale(TimelineScale.TwelveHours));

    expect(result.current.subColumnSource).toBe(false);
  });
});

describe("re-centring on a scale change preserves the centred instant", () => {
  it("keeps the same stretch of time in view when zooming in", () => {
    const coarse = resolveTimelineScaleGeometry({
      endMs: SESSION_END_MS,
      scale: TimelineScale.TwelveHours,
      startMs: SESSION_START_MS,
    });
    // The middle of a window sitting at coarse column 10.
    const midpointMs =
      coarse.originMs + (10 + TIMELINE_VISIBLE_COLUMNS / 2) * coarse.columnMs;

    const nextStart = recentreWindowStartForScale({
      endMs: SESSION_END_MS,
      nextScale: TimelineScale.OneHour,
      startMs: SESSION_START_MS,
      visibleMidpointMs: midpointMs,
    });

    const fine = resolveTimelineScaleGeometry({
      endMs: SESSION_END_MS,
      scale: TimelineScale.OneHour,
      startMs: SESSION_START_MS,
    });
    const nextMidpointMs =
      fine.originMs +
      (nextStart + TIMELINE_VISIBLE_COLUMNS / 2) * fine.columnMs;
    // Within one fine column of the instant it was centred on. A re-centre that
    // snapped to zero — the regression this guards — would be days away.
    expect(Math.abs(nextMidpointMs - midpointMs)).toBeLessThanOrEqual(
      fine.columnMs
    );
    expect(nextStart).toBeGreaterThan(0);
  });

  it("clamps rather than scrolling past the end of the session", () => {
    const nextStart = recentreWindowStartForScale({
      endMs: SESSION_END_MS,
      nextScale: TimelineScale.TwelveHours,
      startMs: SESSION_START_MS,
      visibleMidpointMs: SESSION_END_MS + 400 * 24 * HOUR_MS,
    });
    const geometry = resolveTimelineScaleGeometry({
      endMs: SESSION_END_MS,
      scale: TimelineScale.TwelveHours,
      startMs: SESSION_START_MS,
    });
    expect(nextStart).toBe(geometry.maxWindowStart);
  });
});

function useTimelineScale({ endMs = SESSION_END_MS }: { endMs?: number } = {}) {
  return useSessionTimelineScale({
    activeRow: null,
    activeRowMs: null,
    buckets: costedBins(40, endMs),
    limitDotEvents: [],
    markers: [],
    ownerLabel: "Ada Lovelace",
    sourceExtent: null,
    sourceWindow: { endMs, startMs: SESSION_START_MS },
  });
}

/** The instant a column index names, at a given scale. */
function instantOf(column: number, scale: TimelineScale): number {
  const geometry = resolveTimelineScaleGeometry({
    endMs: SESSION_END_MS,
    scale,
    startMs: SESSION_START_MS,
  });
  return geometry.originMs + (column + 0.5) * geometry.columnMs;
}

/** A strip as a PRE-bounds producer emitted it: priced bins, no clock on them. */
function unboundedBins(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    byModel: { "gpt-5.5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: `bin-${index}`,
    label: `bin ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  }));
}

/** The same strip as a CURRENT producer emits it — each bin states its clock. */
function costedBins(
  count: number,
  endMs: number = SESSION_END_MS
): ActivityBucket[] {
  return withProducerBinBounds(unboundedBins(count), {
    endMs,
    startMs: SESSION_START_MS,
  });
}

const DAY_MS = 24 * HOUR_MS;
const SESSION_DAYS = 20;
const SUB_SESSION_BIN_COUNT = 40;
/**
 * The `_row` a sub-session turn is minted with:
 * `_row = input.timeline.length + index` in `projectAgentSessionTurnItems`. Far
 * past every root turn's ordinal, on an instant in the middle of the run.
 */
const SUB_SESSION_ROW = 900;
const SUB_SESSION_DAY = 4;
/** Day 4, 13:00 — after that day's root turn and before the next day's. */
const SUB_SESSION_MS =
  SESSION_START_MS + SUB_SESSION_DAY * DAY_MS + 13 * HOUR_MS;
const TRACE_ROW_HEIGHT_PX = 100;
const AGENT_ACTOR = {
  color: "var(--chart-1)",
  human: null,
  name: "gpt-5.5",
  sessionId: "session-7115",
};
const HUMAN_ACTOR = {
  color: "hsl(210 65% 45%)",
  human: "Ada Lovelace",
  name: null,
  sessionId: "session-7115",
};

/**
 * ISS-7115 — scrolling FORWARD must never walk the scrubber backward.
 *
 * The reported defect: on a session with a sub-session, scrolling down the
 * transcript threw the thumb to the far end of the timeline and then snapped it
 * back to the middle. The cause is that `_row` is not a reading-order ordinal —
 * `projectAgentSessionTurnItems` sorts turns by TIME and mints a sub-session
 * turn at `_row = timeline.length + index`, so the transcript renders a high
 * `_row` in the middle of the run — while the position was resolved by
 * comparing `bucket.tl0 <= activeRow`, an ordinal comparison that reads that
 * high `_row` as "the end of the session".
 *
 * The fixture is built by the SAME production helpers the detail view uses
 * (`buildTraceRowInstants`, `alignBucketRowsToTranscript`) rather than by
 * hand-written `tl0` values, so it cannot drift into asserting a bucket shape
 * the repair step does not actually produce.
 */
describe("a forward scroll across a sub-session boundary", () => {
  it("never moves the scrubber thumb backward", () => {
    const turnItems = subSessionTranscript();
    const rows = scrollDownThrough(turnItems.map(getTurnRow));

    // The premise, proven rather than assumed: reading DOWN this transcript
    // walks `_row` non-monotonically. Without this the fixture would pass under
    // the broken code and the test would prove nothing.
    expect(rows).toContain(SUB_SESSION_ROW);
    expect(isAscending(rows)).toBe(false);

    const instants = buildTraceRowInstants(turnItems);
    const buckets = alignBucketRowsToTranscript(
      costedBins(SUB_SESSION_BIN_COUNT),
      { turnItems },
      { endMs: SESSION_END_MS, startMs: SESSION_START_MS }
    );
    // And the second half of the premise: the repair really does hand a bucket
    // the sub-session's out-of-order `_row` as its jump target.
    expect(buckets.map((bucket) => bucket.tl0)).toContain(SUB_SESSION_ROW);

    const { result, rerender } = renderHook(
      ({ row }: { row: number }) =>
        useSessionTimelineScale({
          activeRow: row,
          activeRowMs: instants.get(row) ?? null,
          buckets,
          limitDotEvents: [],
          markers: [],
          ownerLabel: "Ada Lovelace",
          sourceExtent: null,
          sourceWindow: { endMs: SESSION_END_MS, startMs: SESSION_START_MS },
        }),
      { initialProps: { row: rows[0] } }
    );

    const positions: number[] = [];
    for (const row of rows) {
      rerender({ row });
      positions.push(result.current.scrubber?.position ?? -1);
    }

    // `-1` would mean the scrubber went away mid-scroll, which is its own bug.
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    // The whole ticket: monotonic under a forward scroll. Compared against the
    // sorted copy so a failure names the step that went backward.
    expect(positions).toEqual([...positions].sort(byAscending));
    // …and it must actually TRAVEL. A thumb frozen at column 0 satisfies
    // monotonicity while telling the reader nothing.
    expect(positions.at(-1)).toBeGreaterThan(positions[0]);
  });
});

/**
 * A transcript in the order `projectAgentSessionTurnItems` emits it: sorted by
 * TIME, with the sub-session turn sitting mid-run on a far-future `_row`.
 *
 * Sides ALTERNATE, and that is load-bearing rather than decoration.
 * `buildTraceGroups` coalesces consecutive turns sharing a `side` and an
 * `actor.sessionId` into ONE `[data-row]` anchor, so an all-agent-side
 * transcript renders as a single anchor at row 0 and {@link scrollDownThrough}
 * would be walking a DOM the renderer never emits. The sub-session is
 * agent-side, so it is deliberately sandwiched between two HUMAN turns — that
 * is what makes it its own anchor carrying its own out-of-order `_row`, which
 * is the whole mechanism under test. `session-timeline-subsession-scroll.test.tsx`
 * pins the same shape against the real renderer.
 */
function subSessionTranscript(): TurnItem[] {
  const items: TurnItem[] = [];
  for (let day = 0; day < SESSION_DAYS; day += 1) {
    const ms = SESSION_START_MS + day * DAY_MS;
    items.push(isHumanTurnDay(day) ? promptTurn(day, ms) : sayTurn(day, ms));
    if (day === SUB_SESSION_DAY) {
      items.push(subagentTurn(SUB_SESSION_ROW, SUB_SESSION_MS));
    }
  }
  return items;
}

/**
 * Alternating, with the parity flipped after the sub-session so the turns on
 * BOTH sides of it are human — see {@link subSessionTranscript}.
 */
function isHumanTurnDay(day: number): boolean {
  return day <= SUB_SESSION_DAY ? day % 2 === 0 : day % 2 === 1;
}

function promptTurn(row: number, ms: number): TurnItem {
  return {
    actor: HUMAN_ACTOR,
    cum: 0,
    t: new Date(ms).toISOString(),
    text: `turn ${row}`,
    tMs: ms,
    type: "prompt",
    _row: row,
  };
}

function sayTurn(row: number, ms: number): TurnItem {
  return {
    actor: AGENT_ACTOR,
    cum: 0,
    t: new Date(ms).toISOString(),
    text: `turn ${row}`,
    tMs: ms,
    type: "say",
    _row: row,
  };
}

function subagentTurn(row: number, ms: number): TurnItem {
  return {
    actor: AGENT_ACTOR,
    body: [],
    cost: null,
    cum: 0,
    duration: null,
    model: null,
    status: "completed",
    sub: "explore",
    subagentType: "explore",
    t: new Date(ms).toISOString(),
    tMs: ms,
    tokens: null,
    type: "subagent",
    _row: row,
  };
}

function getTurnRow(item: TurnItem): number {
  return "_row" in item ? item._row : -1;
}

/**
 * The `[data-row]` sequence a reader walks through scrolling DOWN, resolved by
 * the SAME `computeActiveTraceRow` the session-detail scroll handler calls — so
 * the row sequence under test is the one a real forward scroll produces, not one
 * this test asserted into existence.
 */
function scrollDownThrough(renderedRows: readonly number[]): number[] {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = rectAt(0);
  const nodes = renderedRows.map((row, index) => {
    const node = document.createElement("div");
    node.setAttribute("data-row", String(row));
    scroller.append(node);
    return { index, node };
  });

  const walked: number[] = [];
  for (let step = 0; step < renderedRows.length; step += 1) {
    const scrollTop = step * TRACE_ROW_HEIGHT_PX;
    for (const { index, node } of nodes) {
      node.getBoundingClientRect = rectAt(
        index * TRACE_ROW_HEIGHT_PX - scrollTop
      );
    }
    const row = computeActiveTraceRow({ scroller });
    if (row != null) {
      walked.push(row);
    }
  }
  return walked;
}

function rectAt(top: number): () => DOMRect {
  return () => new DOMRect(0, top, TRACE_ROW_HEIGHT_PX, TRACE_ROW_HEIGHT_PX);
}

function isAscending(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value >= values[index - 1]
  );
}

function byAscending(left: number, right: number): number {
  return left - right;
}
