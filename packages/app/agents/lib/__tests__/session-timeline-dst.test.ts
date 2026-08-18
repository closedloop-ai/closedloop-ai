import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import {
  projectSessionTimeline,
  type TimelineSourceStrip,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  resolveTimelineColumnIndex,
  resolveTimelineScaleGeometry,
  resolveTimelineWindowEdges,
  SCALE_MINUTES,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ISS-5844 (AC5 + AC4) — the wall-clock axis across a DST transition, and the
 * timezone the axis is anchored to.
 *
 * WHY THESE DATES. `America/New_York` shifts on the second Sunday of March and
 * the first Sunday of November, so in 2026 the spring-forward day is 8 March
 * (02:00 does not exist, the day is 23 hours) and the fall-back day is 1
 * November (01:00 happens twice, the day is 25 hours). Both are pinned as
 * explicit local calendar dates rather than derived from the wall clock, so
 * these assertions mean the same thing whenever they are run.
 *
 * WHAT WOULD HAVE FAILED BEFORE. Every "genuinely N hours" assertion below is
 * the counterfactual: the previous model advanced each column by a fixed
 * `columnMs`, so a `12h` column crossing a transition measured 12 hours of real
 * time and put the following boundary on 11:00 or 13:00 instead of the local
 * half-day it labels.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const EASTERN = "America/New_York";
/** +05:30 — a half-hour offset, which is why it is the useful contrast zone. */
const KOLKATA = "Asia/Kolkata";
/**
 * +10:30 / +11:00 — the zone whose DST shift is HALF an hour (#4869 review).
 *
 * The whole-hour zones above cannot tell "handles DST" apart from "handles
 * whole-hour DST": a 60-minute shift divides a `1h` column exactly, so fixed
 * millisecond stepping keeps landing on the local hour by luck. Lord Howe moves
 * 30 minutes and breaks that, which makes it the only zone in tzdata that
 * exercises the snap at all.
 */
const LORD_HOWE = "Australia/Lord_Howe";

const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = EASTERN;
});

afterAll(() => {
  restoreTimezone();
});

describe("12h columns across a DST transition", () => {
  it("puts the boundary after a spring-forward column on local noon, 11 real hours on", () => {
    const startMs = new Date(2026, 2, 8, 0, 30).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + 3 * DAY_MS,
      scale: TimelineScale.TwelveHours,
      startMs,
    });

    expect(new Date(geometry.originMs).getHours()).toBe(0);

    const nextBoundaryMs = timelineColumnStartMs({
      columnIndex: 1,
      originMs: geometry.originMs,
      scale: TimelineScale.TwelveHours,
    });

    expect(new Date(nextBoundaryMs).getHours()).toBe(12);
    // The column that swallowed the missing 02:00 hour is genuinely 11 hours
    // wide. A fixed `columnMs` made it 12 and landed the label on 11:00.
    expect(nextBoundaryMs - geometry.originMs).toBe(11 * HOUR_MS);
  });

  it("puts the boundary after a fall-back column on local noon, 13 real hours on", () => {
    const startMs = new Date(2026, 10, 1, 0, 30).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + 3 * DAY_MS,
      scale: TimelineScale.TwelveHours,
      startMs,
    });

    const nextBoundaryMs = timelineColumnStartMs({
      columnIndex: 1,
      originMs: geometry.originMs,
      scale: TimelineScale.TwelveHours,
    });

    expect(new Date(nextBoundaryMs).getHours()).toBe(12);
    expect(nextBoundaryMs - geometry.originMs).toBe(13 * HOUR_MS);
  });

  it("keeps every visible boundary on a local half-day across the transition", () => {
    const startMs = new Date(2026, 2, 6, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + 12 * DAY_MS,
      scale: TimelineScale.TwelveHours,
      startMs,
    });
    const edges = resolveTimelineWindowEdges({
      originMs: geometry.originMs,
      scale: TimelineScale.TwelveHours,
      windowStart: 0,
    });

    expect(edges).toHaveLength(TIMELINE_VISIBLE_COLUMNS + 1);
    for (const edgeMs of edges) {
      const local = new Date(edgeMs);
      expect([0, 12]).toContain(local.getHours());
      expect(local.getMinutes()).toBe(0);
    }
    // The window spans the transition, so it is a half-hour short of 12 whole
    // days — proof the columns really did vary rather than all measuring 12h.
    expect(edges.at(-1)).toBeDefined();
    expect((edges.at(-1) as number) - edges[0]).toBe(12 * DAY_MS - HOUR_MS);
  });

  it("counts the columns a DST-crossing session needs by the clock, not by division", () => {
    const startMs = new Date(2026, 2, 8, 0, 0).getTime();
    // Exactly two local half-days: 00:00 -> 12:00 -> 00:00. Only 23 real hours
    // on this date, so dividing elapsed time by 12h under-counts.
    const endMs = new Date(2026, 2, 9, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs,
      scale: TimelineScale.TwelveHours,
      startMs,
    });

    expect(endMs - startMs).toBe(23 * HOUR_MS);
    expect(geometry.totalColumns).toBe(2);
  });

  it("round-trips an instant inside the short column back to its own column", () => {
    const startMs = new Date(2026, 2, 8, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + 4 * DAY_MS,
      scale: TimelineScale.TwelveHours,
      startMs,
    });

    for (const columnIndex of [0, 1, 2, 3, 4]) {
      const columnStartMs = timelineColumnStartMs({
        columnIndex,
        originMs: geometry.originMs,
        scale: TimelineScale.TwelveHours,
      });
      expect(
        resolveTimelineColumnIndex({
          instantMs: columnStartMs,
          originMs: geometry.originMs,
          scale: TimelineScale.TwelveHours,
        })
      ).toBe(columnIndex);
      // One minute in still belongs to the same column.
      expect(
        resolveTimelineColumnIndex({
          instantMs: columnStartMs + 60_000,
          originMs: geometry.originMs,
          scale: TimelineScale.TwelveHours,
        })
      ).toBe(columnIndex);
    }
  });
});

describe("the 12h estimate walk survives spans and inputs it cannot reconcile", () => {
  /*
   * #review: `MAX_COLUMN_INDEX_CORRECTION` is a small constant, but
   * `countColumnsToCover` runs over a WHOLE SESSION, not one window, and
   * `defaultTimelineScale` calls it on spans this module cannot bound. These
   * cover the two things that has to survive: a span crossing many transitions,
   * and input the walk can never reconcile at all.
   */
  it("stays exact over a decade, because offset drift does not accumulate", () => {
    const startMs = new Date(2020, 0, 1, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: new Date(2030, 0, 1, 0, 0).getTime(),
      scale: TimelineScale.TwelveHours,
      startMs,
    });

    // Ten years of alternating transitions, and the boundary is still exactly
    // on the local half-day — the drift cancels annually rather than summing.
    for (const columnIndex of [0, 7300, geometry.totalColumns - 1]) {
      const boundaryMs = timelineColumnStartMs({
        columnIndex,
        originMs: geometry.originMs,
        scale: TimelineScale.TwelveHours,
      });
      expect([0, 12]).toContain(new Date(boundaryMs).getHours());
      expect(
        resolveTimelineColumnIndex({
          instantMs: boundaryMs,
          originMs: geometry.originMs,
          scale: TimelineScale.TwelveHours,
        })
      ).toBe(columnIndex);
    }
  });

  it("returns a usable column rather than hanging on non-finite input", () => {
    const originMs = new Date(2026, 2, 8, 0, 0).getTime();
    for (const instantMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const index = resolveTimelineColumnIndex({
        instantMs,
        originMs,
        scale: TimelineScale.TwelveHours,
      });
      // Not asserted to be any particular column — there is no right answer for
      // an instant that is not one. What matters is that it terminates and
      // yields a number the caller's own clamp can use.
      expect(Number.isNaN(index)).toBe(false);
      expect(typeof index).toBe("number");
    }
  });

  it("still draws one column for a non-finite session end", () => {
    const startMs = new Date(2026, 2, 8, 0, 0).getTime();
    for (const endMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const geometry = resolveTimelineScaleGeometry({
        endMs,
        scale: TimelineScale.TwelveHours,
        startMs,
      });
      // An empty strip reads as "no activity", which would be a lie about a
      // session we simply cannot bound.
      expect(geometry.totalColumns).toBeGreaterThanOrEqual(1);
      expect(Number.isNaN(geometry.totalColumns)).toBe(false);
    }
  });
});

describe("1h columns across a DST transition", () => {
  it("keeps every boundary on the local hour and strictly increasing", () => {
    const startMs = new Date(2026, 2, 8, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + DAY_MS,
      scale: TimelineScale.OneHour,
      startMs,
    });
    const edges = resolveTimelineWindowEdges({
      originMs: geometry.originMs,
      scale: TimelineScale.OneHour,
      windowStart: 0,
    });

    for (const [index, edgeMs] of edges.entries()) {
      expect(new Date(edgeMs).getMinutes()).toBe(0);
      const previousMs = edges[index - 1];
      if (previousMs != null) {
        /*
         * Strictly increasing is the assertion that would fail had `1h` been
         * moved onto calendar advance too: 02:00 does not exist on this date,
         * so `setHours(2)` and `setHours(3)` both normalise to 03:00 and two
         * adjacent columns would collapse onto one instant.
         */
        expect(edgeMs).toBeGreaterThan(previousMs);
        expect(edgeMs - previousMs).toBe(HOUR_MS);
      }
    }
    // The local hour genuinely skips 02:00 on this date.
    const localHours = edges.map((edgeMs) => new Date(edgeMs).getHours());
    expect(localHours).toContain(1);
    expect(localHours).toContain(3);
    expect(localHours.slice(0, 4)).toEqual([0, 1, 3, 4]);
  });
});

describe("the projected strip across a DST transition", () => {
  it("labels its columns on the local half-day and conserves in-window cost", () => {
    const startMs = new Date(2026, 2, 7, 0, 0).getTime();
    const endMs = startMs + 4 * DAY_MS;
    const source: TimelineSourceStrip = {
      buckets: withProducerBinBounds(
        Array.from({ length: 8 }, () => createSourceBucket(1)),
        { endMs, startMs }
      ),
      endMs,
      startMs,
    };

    const projection = projectSessionTimeline({
      limitDotEvents: [],
      markers: [],
      scale: TimelineScale.TwelveHours,
      segmentRows: [],
      source,
      windowStart: 0,
    });

    expect(projection.buckets).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
    const edges = resolveTimelineWindowEdges({
      originMs: projection.originMs,
      scale: TimelineScale.TwelveHours,
      windowStart: projection.windowStart,
    });
    for (const [index, bucket] of projection.buckets.entries()) {
      const columnStartMs = edges[index] as number;
      // Every column is keyed and labelled by its own real start instant, which
      // is a local half-day boundary — never an 11:00 or 13:00 drifted one.
      expect(bucket.key).toBe(`${TimelineScale.TwelveHours}-${columnStartMs}`);
      expect([0, 12]).toContain(new Date(columnStartMs).getHours());
    }

    const projectedCost = projection.buckets.reduce(
      (sum, bucket) => sum + bucket.cIn + bucket.cOut + bucket.cCache,
      0
    );
    // The whole session fits inside one 12-day window, so conservation is total.
    expect(projectedCost).toBeCloseTo(8 * 3, 6);
  });
});

describe("the axis is anchored to the VIEWER's timezone (AC4)", () => {
  /*
   * ISS-5844's AC4 asks for a test "where session-origin and viewer timezones
   * differ". `AgentSessionDetail` carries INSTANTS and never a zone, so a
   * session-origin zone is not a value this code could read — inventing a field
   * to test against would be testing a fiction. What IS both real and testable
   * is the contract `floorToLocalColumnBoundary` states: the axis follows the
   * VIEWER. Holding the instants fixed and moving only the viewer's zone proves
   * a session recorded elsewhere is framed on the reader's clock, which is the
   * behaviour the acceptance criterion is protecting.
   */
  it("frames the same instants on each viewer's own clock", () => {
    // 14:00 UTC — mid-afternoon in New York, late evening in Kolkata.
    const startMs = Date.UTC(2026, 5, 15, 14, 0);
    const endMs = startMs + 6 * HOUR_MS;

    process.env.TZ = EASTERN;
    const eastern = resolveTimelineScaleGeometry({
      endMs,
      scale: TimelineScale.OneHour,
      startMs,
    });
    const easternHour = new Date(eastern.originMs).getHours();

    process.env.TZ = KOLKATA;
    const kolkata = resolveTimelineScaleGeometry({
      endMs,
      scale: TimelineScale.OneHour,
      startMs,
    });
    const kolkataHour = new Date(kolkata.originMs).getHours();

    process.env.TZ = EASTERN;

    // Same instants, two viewers, two different anchors.
    expect(eastern.originMs).not.toBe(kolkata.originMs);
    expect(easternHour).toBe(10);
    expect(kolkataHour).toBe(19);
    /*
     * The half-hour offset is the point. Kolkata is +05:30, so a UTC-anchored
     * floor would land its `1h` columns on :30 and print an axis visibly not on
     * the hour it claims. Both viewers get a boundary on their own hour.
     */
    expect(new Date(kolkata.originMs).getMinutes()).toBe(30);
    expect(new Date(eastern.originMs).getMinutes()).toBe(0);
  });
});

describe("1h columns across a FRACTIONAL DST transition", () => {
  /*
   * #4869 review. `Australia/Lord_Howe` shifts by 30 minutes, not 60: on 4
   * October 2026 the clock goes 02:00 -> 02:30, and on 5 April 2026 it goes
   * 02:00 -> 01:30. Thirty minutes divides a `5m` and a `15m` column exactly but
   * NOT a `1h` one, so fixed-millisecond stepping — which every whole-hour zone
   * above cannot distinguish from correct — put every `1h` boundary from the
   * transition onward at :30 past the local hour and left it there.
   */
  beforeAll(() => {
    process.env.TZ = LORD_HOWE;
  });

  afterAll(() => {
    process.env.TZ = EASTERN;
  });

  it("puts every boundary after a half-hour spring-forward back on the local hour", () => {
    const startMs = new Date(2026, 9, 4, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + DAY_MS,
      scale: TimelineScale.OneHour,
      startMs,
    });
    const edges = resolveTimelineWindowEdges({
      originMs: geometry.originMs,
      scale: TimelineScale.OneHour,
      windowStart: 0,
    });

    /*
     * THE COUNTERFACTUAL. Fixed-millisecond stepping emits 01:00, 02:30, 03:30,
     * 04:30 … — one boundary knocked off the grid by the transition and every
     * one after it inheriting the offset. Only the transition's own column may
     * be off the hour now, because 02:00–02:30 does not exist to land on.
     */
    const offGrid = edges.filter(
      (edgeMs) => new Date(edgeMs).getMinutes() !== 0
    );
    expect(offGrid).toHaveLength(1);
    expect(new Date(offGrid[0]).getHours()).toBe(2);
    expect(new Date(offGrid[0]).getMinutes()).toBe(30);
    // The boundary AFTER the transition column is the assertion that fails on
    // the old arithmetic: it read 03:30 and every later one kept the :30.
    const afterTransition = edges.filter((edgeMs) => edgeMs > offGrid[0]);
    expect(afterTransition.length).toBeGreaterThan(0);
    for (const edgeMs of afterTransition) {
      expect(new Date(edgeMs).getMinutes()).toBe(0);
    }
  });

  it("keeps boundaries strictly increasing through both fractional transitions", () => {
    /*
     * The two ways a naive fix breaks, pinned together. Advancing the LOCAL hour
     * instead collapses the spring-forward pair onto one instant (02:00 does not
     * exist, so it normalises to 03:00 twice); re-flooring through the wall
     * clock collapses the fall-back pair (the repeated 01:30 resolves to the
     * earlier occurrence). Either one silently gives a column zero width.
     */
    for (const [year, month, day] of [
      [2026, 9, 4],
      [2026, 3, 5],
    ] as const) {
      const startMs = new Date(year, month, day, 0, 0).getTime();
      const geometry = resolveTimelineScaleGeometry({
        endMs: startMs + DAY_MS,
        scale: TimelineScale.OneHour,
        startMs,
      });
      const edges = resolveTimelineWindowEdges({
        originMs: geometry.originMs,
        scale: TimelineScale.OneHour,
        windowStart: 0,
      });

      for (let index = 1; index < edges.length; index += 1) {
        expect(edges[index]).toBeGreaterThan(edges[index - 1]);
      }
    }
  });

  it("round-trips an instant in the narrowed transition column back to that column", () => {
    const startMs = new Date(2026, 9, 4, 0, 0).getTime();
    const geometry = resolveTimelineScaleGeometry({
      endMs: startMs + DAY_MS,
      scale: TimelineScale.OneHour,
      startMs,
    });

    for (let columnIndex = 0; columnIndex < 6; columnIndex += 1) {
      const columnStartMs = timelineColumnStartMs({
        columnIndex,
        originMs: geometry.originMs,
        scale: TimelineScale.OneHour,
      });
      expect(
        resolveTimelineColumnIndex({
          instantMs: columnStartMs,
          originMs: geometry.originMs,
          scale: TimelineScale.OneHour,
        })
      ).toBe(columnIndex);
      // A minute in still belongs to the same column — the transition column is
      // only 30 minutes wide, so this is the one that catches an inverse still
      // dividing by a fixed `columnMs`.
      expect(
        resolveTimelineColumnIndex({
          instantMs: columnStartMs + 60_000,
          originMs: geometry.originMs,
          scale: TimelineScale.OneHour,
        })
      ).toBe(columnIndex);
    }
  });

  it("leaves the finer scales alone, because 30 minutes divides them exactly", () => {
    const startMs = new Date(2026, 9, 4, 0, 0).getTime();

    for (const scale of [
      TimelineScale.FiveMinutes,
      TimelineScale.FifteenMinutes,
    ]) {
      const geometry = resolveTimelineScaleGeometry({
        endMs: startMs + DAY_MS,
        scale,
        startMs,
      });
      const edges = resolveTimelineWindowEdges({
        originMs: geometry.originMs,
        scale,
        windowStart: 0,
      });

      for (const [offset, edgeMs] of edges.entries()) {
        // Still exactly `columnMs` apart: the snap must be a no-op here, not a
        // second behaviour the finer scales quietly inherited.
        expect(edgeMs).toBe(geometry.originMs + offset * geometry.columnMs);
        expect(new Date(edgeMs).getMinutes() % SCALE_MINUTES[scale]).toBe(0);
      }
    }
  });
});

function createSourceBucket(cost: number): ActivityBucket {
  return {
    byModel: {},
    cCache: cost,
    cIn: cost,
    cOut: cost,
    key: `source-${cost}`,
    label: "",
    tl0: null,
    toolStart: 0,
    total: 0,
  };
}

function restoreTimezone(): void {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
}
