import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { projectSessionTimeline } from "@repo/app/agents/lib/session-timeline-projection";
import {
  resolveTimelineScaleGeometry,
  TIMELINE_SCALE_OPTIONS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  costedBins,
  HOUR_MS,
  MINUTE_MS,
  SESSION_START_MS,
} from "./session-timeline-geometry-fixtures";

/**
 * ISS-8771 — the invariants the Session trace and the Branch trace now BOTH
 * hold, pinned here on the Session side and in
 * `branches/lib/__tests__/branch-timeline-canonical-window.test.ts` on the
 * other, against the same contract module.
 *
 * The existing suites pin 24 columns one scale at a time; nothing asserted the
 * invariant ACROSS the four the toggle offers, so a scale added to
 * `TIMELINE_SCALE_OPTIONS` with a geometry that does not honour the window
 * would ship green. `24` is written as a literal rather than imported from
 * `TIMELINE_VISIBLE_COLUMNS` — a case that reads its expectation from the
 * constant it guards cannot fail when that constant moves.
 *
 * Asia/Kolkata (+05:30) is pinned for the whole file for the reason the sibling
 * suites pin it: CI runs UTC, where local IS UTC and every wall-clock assertion
 * passes identically against the epoch arithmetic it is meant to rule out.
 */

const TEST_TIMEZONE = "Asia/Kolkata";
const originalTimezone = process.env.TZ;

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

function projectAcross({
  binCount,
  scale,
  spanMs,
  windowStart = 0,
}: {
  binCount: number;
  scale: TimelineScale;
  spanMs: number;
  windowStart?: number;
}) {
  const window = {
    endMs: SESSION_START_MS + spanMs,
    startMs: SESSION_START_MS,
  };
  return projectSessionTimeline({
    limitDotEvents: [],
    markers: [],
    scale,
    source: {
      buckets: withProducerBinBounds(costedBins(binCount), window),
      endMs: window.endMs,
      extent: null,
      startMs: window.startMs,
    },
    windowStart,
  });
}

describe("every scale the toggle offers renders exactly 24 buckets", () => {
  for (const scale of TIMELINE_SCALE_OPTIONS) {
    it(`renders 24 buckets at ${scale}`, () => {
      const projected = projectAcross({
        binCount: 40,
        scale,
        // 40 days: wider than 24 columns at every scale, including `12h`.
        spanMs: 40 * 24 * HOUR_MS,
      });

      expect(projected.buckets).toHaveLength(24);
      expect(projected.columnCoverage).toHaveLength(24);
      expect(projected.totalColumns).toBeGreaterThan(24);
    });
  }

  it("still renders 24 for a session far SHORTER than one window", () => {
    // The Session strip pads: the producer states the extent its bins tile, so
    // a column beyond it is reported through `columnCoverage` rather than drawn
    // as observed quiet. That is what makes padding honest here.
    const projected = projectAcross({
      binCount: 8,
      scale: TimelineScale.TwelveHours,
      spanMs: 3 * MINUTE_MS,
    });

    expect(projected.buckets).toHaveLength(24);
    expect(projected.maxWindowStart).toBe(0);
  });

  it("still renders 24 for an awkward span that ends mid-column", () => {
    const projected = projectAcross({
      binCount: 40,
      scale: TimelineScale.FifteenMinutes,
      // 6h 07m 30s from an origin that is itself floored to :00 local.
      spanMs: 6 * HOUR_MS + 7 * MINUTE_MS + 30_000,
    });

    expect(projected.buckets).toHaveLength(24);
  });

  it("starts every 1h column on the local hour in a half-hour-offset zone", () => {
    const projected = projectAcross({
      binCount: 12,
      scale: TimelineScale.OneHour,
      spanMs: 5 * HOUR_MS,
    });

    // UTC flooring lands the origin on :30 local in +05:30 and keeps it there.
    expect(new Date(projected.originMs).getMinutes()).toBe(0);
    expect(new Date(projected.windowStartMs).getMinutes()).toBe(0);
  });
});

/** Money is exact under re-projection; the count fields are apportioned. */
function costOf(bucket: { cCache: number; cIn: number; cOut: number }): number {
  return bucket.cCache + bucket.cIn + bucket.cOut;
}

/**
 * Every column of the whole span, gathered by scrubbing one column at a time and
 * keyed by column so an overlap cannot be counted twice. A double count would
 * let a projection that DROPPED a column still reconcile against the source.
 */
function pageAcrossWholeSpan({
  binCount,
  scale,
  spanMs,
}: {
  binCount: number;
  scale: TimelineScale;
  spanMs: number;
}): Map<string, number> {
  const geometry = resolveTimelineScaleGeometry({
    endMs: SESSION_START_MS + spanMs,
    scale,
    startMs: SESSION_START_MS,
  });
  const reached = new Map<string, number>();
  for (let start = 0; start <= geometry.maxWindowStart; start += 1) {
    for (const [index, bucket] of projectAcross({
      binCount,
      scale,
      spanMs,
      windowStart: start,
    }).buckets.entries()) {
      /*
       * `ActivityBucket.key` is optional on the wire contract, so the ABSOLUTE
       * column index is the identity here. It is also the stronger key: it is
       * what a dropped column would change, whereas a `key` collision between
       * two columns would silently merge them and hide exactly the truncation
       * this case exists to catch.
       */
      reached.set(String(start + index), costOf(bucket));
    }
  }
  return reached;
}

describe("the projection never truncates the source population", () => {
  it("keeps every source dollar reachable by scrubbing the whole span", () => {
    const binCount = 40;
    const spanMs = 40 * HOUR_MS;
    const reached = pageAcrossWholeSpan({
      binCount,
      scale: TimelineScale.OneHour,
      spanMs,
    });

    expect(reached.size).toBe(
      resolveTimelineScaleGeometry({
        endMs: SESSION_START_MS + spanMs,
        scale: TimelineScale.OneHour,
        startMs: SESSION_START_MS,
      }).totalColumns
    );
    // `costedBins` deposits 2.0 per bin across cIn/cOut/cCache.
    expect(
      [...reached.values()].reduce((sum, cost) => sum + cost, 0)
    ).toBeCloseTo(binCount * 2, 6);
  });

  it("keeps every source dollar reachable at a scale FINER than the bins", () => {
    // The lossy direction: a `5m` column is narrower than a bin of a 6h/40-bin
    // strip, so each bin is interpolated across columns. Interpolation may not
    // become deletion.
    const binCount = 40;
    const reached = pageAcrossWholeSpan({
      binCount,
      scale: TimelineScale.FiveMinutes,
      spanMs: 6 * HOUR_MS,
    });

    expect(
      [...reached.values()].reduce((sum, cost) => sum + cost, 0)
    ).toBeCloseTo(binCount * 2, 6);
  });

  it("keeps the whole EVENT population when one window covers the span", () => {
    // The counts are apportioned by largest remainder rather than carried
    // exactly, so they are pinned where the question is answerable: a window
    // that covers the entire strip must show every event the producer counted.
    const binCount = 12;
    const projected = projectAcross({
      binCount,
      scale: TimelineScale.OneHour,
      spanMs: 6 * HOUR_MS,
    });

    expect(
      projected.buckets.reduce((sum, bucket) => sum + bucket.total, 0)
    ).toBe(binCount * 2);
    expect(
      projected.buckets.reduce((sum, bucket) => sum + bucket.toolStart, 0)
    ).toBe(binCount);
  });
});
