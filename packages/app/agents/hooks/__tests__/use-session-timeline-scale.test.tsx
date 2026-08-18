import type {
  ActivityBucket,
  SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { useSessionTimelineScale } from "@repo/app/agents/hooks/use-session-timeline-scale";
import {
  recentreWindowStartForScale,
  resolveTimelineScaleGeometry,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { TimelineStackGrouping } from "@repo/app/agents/lib/session-timeline-stacks";
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
        activityPhasesEnabled: true,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        segmentRows: [],
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
        activityPhasesEnabled: true,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        segmentRows: [],
        sourceWindow: { endMs: SESSION_END_MS, startMs: SESSION_START_MS },
      })
    );
    expect(result.current.columns).not.toBe(buckets);
    expect(result.current.controls).not.toBeNull();
    expect(result.current.stacks).not.toBeNull();
  });

  it("stays on the ordinal strip when the bins carry no producer bounds", () => {
    /*
     * ISS-5819 review (wongk). A persisted strip is binned by the producer over
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
        activityPhasesEnabled: true,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        segmentRows: [],
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
        activityPhasesEnabled: true,
        buckets,
        limitDotEvents: [],
        markers: [],
        ownerLabel: "Ada Lovelace",
        segmentRows: [],
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

/**
 * ISS-6054 — the activity-phase split is derived only when it is drawn.
 *
 * Watched at the input it is expensive in: the derivation is the only thing on
 * this path that reads `segmentRows`, rescanning them once per visible column,
 * so an unread array is proof the work did not happen. Asserted this way rather
 * than on output because the rendered bars are identical either way — every
 * grouping sums to the same per-column total, and a discarded phase split
 * changes nothing a reader or a DOM assertion can see.
 */
describe("the phase split is derived only for the cut that draws it", () => {
  it("leaves the classifier spans unread while the reader is on another cut", () => {
    const spans = watchedSegmentRows();
    const { result } = renderHook(() =>
      useTimelineScale({ segmentRows: spans.rows })
    );

    expect(result.current.controls?.grouping).toBe(
      TimelineStackGrouping.TokenType
    );
    // A scale change re-projects, which is where the cost used to be re-paid.
    act(() => result.current.scrubber?.onPositionChange(6));
    act(() => result.current.controls?.setScale(TimelineScale.OneHour));
    expect(spans.reads).toBe(0);

    act(() =>
      result.current.controls?.setGrouping(TimelineStackGrouping.ActivityPhase)
    );
    // ...and the phase cut still gets its split, so "unread" is not "removed".
    expect(spans.reads).toBeGreaterThan(0);
  });

  it("leaves them unread under the phase cut while the phase flag is closed", () => {
    // ISS-5841 forces the effective cut back to Token Type, so a flag flipping
    // off mid-session must stop paying for the split as well as stop drawing it.
    const spans = watchedSegmentRows();
    const { result } = renderHook(() =>
      useTimelineScale({
        activityPhasesEnabled: false,
        segmentRows: spans.rows,
      })
    );

    act(() =>
      result.current.controls?.setGrouping(TimelineStackGrouping.ActivityPhase)
    );

    expect(result.current.controls?.grouping).toBe(
      TimelineStackGrouping.TokenType
    );
    expect(spans.reads).toBe(0);
  });
});

/**
 * A segment-row array that counts how many times something iterated it.
 *
 * A `Proxy` rather than a spy on the derivation: it observes the rescan itself
 * at the boundary the cost is real, and stays stable across renders so the
 * hook's projection memo is not invalidated by the instrumentation.
 */
function watchedSegmentRows(): {
  reads: number;
  rows: readonly SyncedActivitySegmentRow[];
} {
  const rows: SyncedActivitySegmentRow[] = [
    {
      confidence: 1,
      endMs: SESSION_START_MS + 10 * 24 * HOUR_MS,
      evidenceLayers: ["declared"],
      phase: "implement",
      startMs: SESSION_START_MS,
      version: 1,
    },
  ];
  const watched = {
    reads: 0,
    rows: new Proxy(rows, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          watched.reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  return watched;
}

function useTimelineScale({
  activityPhasesEnabled = true,
  endMs = SESSION_END_MS,
  segmentRows = EMPTY_SEGMENT_ROWS,
}: {
  activityPhasesEnabled?: boolean;
  endMs?: number;
  segmentRows?: readonly SyncedActivitySegmentRow[];
} = {}) {
  return useSessionTimelineScale({
    activeRow: null,
    activityPhasesEnabled,
    buckets: costedBins(40, endMs),
    limitDotEvents: [],
    markers: [],
    ownerLabel: "Ada Lovelace",
    segmentRows,
    sourceWindow: { endMs, startMs: SESSION_START_MS },
  });
}

const EMPTY_SEGMENT_ROWS: readonly SyncedActivitySegmentRow[] = [];

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
