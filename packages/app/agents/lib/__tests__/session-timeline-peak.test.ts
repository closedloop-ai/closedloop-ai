import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { getBucketCost } from "@repo/app/agents/components/detail/activity-bucket-rendering";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { resolveTimelinePeakColumnCost } from "@repo/app/agents/lib/session-timeline-peak";
import {
  projectSessionTimeline,
  type TimelineSourceStrip,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  resolveTimelineScaleGeometry,
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Wraps the column-boundary function so a test can count the peak's calls and
 * stop an unbounded walk at a budget instead of hanging (#9008 review). The
 * projection and the scale module's own internals bind it locally, so only the
 * peak's direct calls are counted.
 */
const columnStartBudget = vi.hoisted(() => ({
  remaining: Number.POSITIVE_INFINITY,
}));

vi.mock(
  "@repo/app/agents/lib/session-timeline-scale",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/agents/lib/session-timeline-scale")
      >();
    return {
      ...actual,
      timelineColumnStartMs: vi.fn(
        (args: Parameters<typeof actual.timelineColumnStartMs>[0]) => {
          columnStartBudget.remaining -= 1;
          if (columnStartBudget.remaining < 0) {
            throw new Error("column-boundary budget exhausted");
          }
          return actual.timelineColumnStartMs(args);
        }
      ),
    };
  }
);

/**
 * ISS-12665 — the timeline header's peak column is taken across the WHOLE
 * session at the current scale, not off the 24-column window on screen.
 *
 * UTC is pinned so each 12-hour source bin lands on exactly one `12h` column and
 * the expected peaks below are exact rather than split across a local offset.
 */

const originalTimezone = process.env.TZ;
const HOUR_MS = 3_600_000;
const SESSION_START_MS = Date.UTC(2026, 5, 10, 0, 0, 0);
/** 40 twelve-hour bins: 20 days, wider than one 24-column `12h` window. */
const BIN_COUNT = 40;
const SESSION_END_MS = SESSION_START_MS + BIN_COUNT * 12 * HOUR_MS;
/** Day 17.5 — outside the opening window, which covers the first 12 days. */
const LATE_PEAK_INDEX = 35;
const FIVE_MINUTES_MS = 5 * 60_000;
/** Far above the bounded walk's need, far below the 7.8M-column walk. */
const PATHOLOGICAL_CALL_BUDGET = 100_000;
/** 40 bins need about 650 boundary reads, independent of the span. */
const BOUNDED_CALL_CEILING = 1000;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterEach(() => {
  columnStartBudget.remaining = Number.POSITIVE_INFINITY;
  vi.mocked(timelineColumnStartMs).mockClear();
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("resolveTimelinePeakColumnCost", () => {
  it("finds a peak the opening window does not show", () => {
    const source = strip(binCosts({ [LATE_PEAK_INDEX]: 9 }));

    const openingWindowMax = Math.max(
      ...projectSessionTimeline({
        limitDotEvents: [],
        markers: [],
        scale: TimelineScale.TwelveHours,
        source,
        windowStart: 0,
      }).buckets.map(getBucketCost)
    );

    expect(openingWindowMax).toBe(1);
    expect(
      resolveTimelinePeakColumnCost({
        scale: TimelineScale.TwelveHours,
        source,
      })
    ).toBe(9);
  });

  it("equals the tallest bar the projection draws in any window", () => {
    // 37 bins over an odd span, so bins straddle column edges at every scale.
    const endMs = SESSION_START_MS + 37 * 47 * 60_000 + 13_000;
    const buckets = withProducerBinBounds(
      binCosts({ 5: 3.25, 22: 7.5, 23: 7.5, 30: 0.4 }).slice(0, 37),
      { endMs, startMs: SESSION_START_MS }
    );
    const source: TimelineSourceStrip = {
      buckets,
      endMs,
      extent: null,
      startMs: SESSION_START_MS,
    };

    for (const scale of TIMELINE_SCALE_OPTIONS) {
      expect(resolveTimelinePeakColumnCost({ scale, source })).toBeCloseTo(
        tallestProjectedBar(source, scale),
        9
      );
    }
  });

  it("is computed at the scale on screen, so a finer scale splits the bin", () => {
    const source = strip(binCosts({ [LATE_PEAK_INDEX]: 9 }));

    expect(
      resolveTimelinePeakColumnCost({ scale: TimelineScale.OneHour, source })
    ).toBeCloseTo(9 / 12, 10);
  });

  it("states a tied peak once rather than summing the tied columns", () => {
    const source = strip(binCosts({ 3: 5, 30: 5 }));

    expect(
      resolveTimelinePeakColumnCost({
        scale: TimelineScale.TwelveHours,
        source,
      })
    ).toBe(5);
  });

  it("reports a measured all-zero strip as a real zero", () => {
    const source = strip(binCosts({}, 0));

    expect(
      resolveTimelinePeakColumnCost({
        scale: TimelineScale.TwelveHours,
        source,
      })
    ).toBe(0);
  });

  it("prices a far-future span with work bounded by the bins, not the columns", () => {
    // #9008 review (whitlockk): 40 bins from 2026 to 2100 at `5m` is 7.8M columns.
    const endMs = Date.UTC(2100, 0, 1);
    const source: TimelineSourceStrip = {
      buckets: withProducerBinBounds(binCosts({ 7: 9 }), {
        endMs,
        startMs: SESSION_START_MS,
      }),
      endMs,
      extent: null,
      startMs: SESSION_START_MS,
    };
    const binMs = (endMs - SESSION_START_MS) / BIN_COUNT;
    columnStartBudget.remaining = PATHOLOGICAL_CALL_BUDGET;

    const peak = resolveTimelinePeakColumnCost({
      scale: TimelineScale.FiveMinutes,
      source,
    });

    expect(peak).toBeCloseTo((9 * FIVE_MINUTES_MS) / binMs, 15);
    expect(vi.mocked(timelineColumnStartMs).mock.calls.length).toBeLessThan(
      BOUNDED_CALL_CEILING
    );
  });

  describe("across a fall-back transition", () => {
    beforeAll(() => {
      process.env.TZ = "America/New_York";
    });

    afterAll(() => {
      process.env.TZ = "UTC";
    });

    it("finds the 13-hour column inside a long run of 12-hour ones", () => {
      // Four bins over Oct-Dec 2026; New York falls back on 1 November, inside
      // bin 1, so one of its 12h columns is 13 real hours wide.
      const startMs = new Date(2026, 9, 1).getTime();
      const endMs = new Date(2027, 0, 1).getTime();
      const source: TimelineSourceStrip = {
        buckets: withProducerBinBounds(binCosts({ 1: 9 }).slice(0, 4), {
          endMs,
          startMs,
        }),
        endMs,
        extent: null,
        startMs,
      };
      const binMs = (endMs - startMs) / 4;

      const peak = resolveTimelinePeakColumnCost({
        scale: TimelineScale.TwelveHours,
        source,
      });

      expect(peak).toBeCloseTo((9 * 13 * HOUR_MS) / binMs, 12);
      expect(peak).toBeCloseTo(
        tallestProjectedBar(source, TimelineScale.TwelveHours),
        12
      );
    });
  });

  it("returns null rather than a figure when a column's cost is corrupt", () => {
    const source = strip(binCosts({ 7: Number.NaN }));

    expect(
      resolveTimelinePeakColumnCost({
        scale: TimelineScale.TwelveHours,
        source,
      })
    ).toBeNull();
  });
});

function strip(buckets: ActivityBucket[]): TimelineSourceStrip {
  return {
    buckets: withProducerBinBounds(buckets, {
      endMs: SESSION_END_MS,
      startMs: SESSION_START_MS,
    }),
    endMs: SESSION_END_MS,
    extent: null,
    startMs: SESSION_START_MS,
  };
}

/** The brute-force answer: project every window and take the tallest bar. */
function tallestProjectedBar(
  source: TimelineSourceStrip,
  scale: TimelineScale
): number {
  const { maxWindowStart } = resolveTimelineScaleGeometry({
    endMs: source.endMs,
    scale,
    startMs: source.startMs,
  });
  let tallest = 0;
  for (let windowStart = 0; windowStart <= maxWindowStart; windowStart += 1) {
    const projection = projectSessionTimeline({
      limitDotEvents: [],
      markers: [],
      scale,
      source,
      windowStart,
    });
    tallest = Math.max(tallest, ...projection.buckets.map(getBucketCost));
  }
  return tallest;
}

function binCosts(
  overrides: Readonly<Record<number, number>>,
  baseline = 1
): ActivityBucket[] {
  return Array.from({ length: BIN_COUNT }, (_, index) => {
    const cost = overrides[index] ?? baseline;
    return {
      byModel: { "claude-opus-5": { cCache: 0, cIn: cost, cOut: 0 } },
      cCache: 0,
      cIn: cost,
      cOut: 0,
      key: `bin-${index}`,
      label: `bin ${index}`,
      tl0: index,
      toolStart: 0,
      total: 1,
    };
  });
}
