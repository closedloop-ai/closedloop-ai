import type {
  ActivityBucket,
  SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import type { ActivityMarker } from "@repo/app/agents/components/detail/session-timeline-axis";
import {
  hasProducerBinBounds,
  projectSessionTimeline,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  defaultTimelineScale,
  followTimelineWindowStart,
  resolveTimelineScaleGeometry,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import {
  buildTimelineModelColors,
  buildTimelineStacks,
  TimelineStackGrouping,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { UNATTRIBUTED_KEY } from "@repo/lib/branches/activity-rollup";
import { IDLE_PHASE_KEY } from "@repo/lib/sessions/activity-segment-aggregation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  costedBins,
  HOUR_MS,
  MINUTE_MS,
  SESSION_START_MS,
} from "./session-timeline-geometry-fixtures";

/**
 * ISS-5819 — the Session Timeline's clock window, its re-projection, and the
 * four "Group by" cuts.
 *
 * These assert BEHAVIOUR, not presence: that changing the scale changes which
 * stretch of time the columns cover, that each grouping re-cuts the same bar
 * differently while keeping its height, that the scrubber's own condition
 * (`maxWindowStart > 0`) tracks whether the session actually exceeds the window.
 * A presence assertion would stay green against a control wired to nothing,
 * which is the exact failure this ticket exists to prevent.
 *
 * The counterfactual is stated per-block: each expectation below is one the
 * pre-ISS-5819 strip could not satisfy, because it had no window at all — its
 * column count came from the producer (40) or the synthesizer (48/32/16).
 */

/*
 * H4: a HALF-HOUR-OFFSET zone, pinned for the whole file.
 *
 * The wall-clock assertions read LOCAL time, and CI runners are UTC — where
 * local is UTC and the assertions pass identically against the old
 * `epochMs % columnMs` flooring, i.e. they are a no-op on exactly the drift they
 * name. Asia/Kolkata is UTC+05:30, so a UTC-anchored `1h` origin lands on :30
 * local and the assertions fail. That is what makes them evidence.
 */
const TEST_TIMEZONE = "Asia/Kolkata";
const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = TEST_TIMEZONE;
});

afterAll(() => {
  if (originalTimezone === undefined) {
    // Assigning `undefined` would store the STRING "undefined" in `process.env`.
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("the clock window replaces duration-derived bucketing", () => {
  it("renders exactly 24 columns whatever the source strip's bin count is", () => {
    // The defect, stated as a test: the sampled session drew 40 bars because the
    // producer emitted 40 bins. The window is what makes the count stop moving.
    for (const binCount of [3, 16, 40, 48]) {
      const projected = project({
        buckets: costedBins(binCount),
        scale: TimelineScale.OneHour,
      });
      expect(projected.buckets).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
    }
  });

  it("changes the window the columns cover when the scale changes", () => {
    const buckets = costedBins(24);
    const fiveMinutes = project({ buckets, scale: TimelineScale.FiveMinutes });
    const oneHour = project({ buckets, scale: TimelineScale.OneHour });

    // 24 columns x 5m is two hours of clock; 24 x 1h is a day. Same bars, same
    // window start, genuinely different stretch of time on screen.
    expect(fiveMinutes.windowEndMs - fiveMinutes.windowStartMs).toBe(
      2 * HOUR_MS
    );
    expect(oneHour.windowEndMs - oneHour.windowStartMs).toBe(24 * HOUR_MS);
    expect(oneHour.columnMs).toBeGreaterThan(fiveMinutes.columnMs);
  });

  it("frames columns on the wall clock, not on elapsed time from the session start", () => {
    /*
     * ISS-5844's model, and the reason a 5h38m run drew 40 bars: production
     * framed the strip as T+0 -> T+duration, so no bucket edge was a time of
     * day. The prototype frames it on the clock — a `5m` column starts at :00,
     * :05, :10, and its tooltip reads "9:35 AM-9:40 AM".
     *
     * Asserted in LOCAL time, because local is the anchor the module chose (see
     * `floorToLocalColumnBoundary`) and local is what `formatTime` prints. An
     * epoch-modulo assertion would be a UTC assertion in disguise and would pass
     * against the very drift this closes for a half-hour-offset viewer.
     */
    const startMs = SESSION_START_MS + 37 * MINUTE_MS;
    const hourly = project({
      buckets: costedBins(6),
      scale: TimelineScale.OneHour,
      startMs,
    });
    const hourlyOrigin = new Date(hourly.originMs);
    expect(hourlyOrigin.getMinutes()).toBe(0);
    expect(hourlyOrigin.getSeconds()).toBe(0);
    // Not the session's own start instant — that is the elapsed frame.
    expect(hourly.originMs).toBeLessThan(startMs);

    const fiveMinutes = project({
      buckets: costedBins(6),
      scale: TimelineScale.FiveMinutes,
      startMs,
    });
    // :35, a real 5-minute boundary on the clock.
    expect(new Date(fiveMinutes.originMs).getMinutes() % 5).toBe(0);
    expect(new Date(fiveMinutes.originMs).getSeconds()).toBe(0);
  });

  it("anchors the 12h scale to local midnight or noon", () => {
    const projected = project({
      buckets: costedBins(6),
      endMs: SESSION_START_MS + 5 * 24 * HOUR_MS,
      scale: TimelineScale.TwelveHours,
      startMs: SESSION_START_MS + 37 * MINUTE_MS,
    });
    const origin = new Date(projected.originMs);
    expect([0, 12]).toContain(origin.getHours());
    expect(origin.getMinutes()).toBe(0);
  });

  it("conserves every in-window dollar and invents none", () => {
    const buckets = costedBins(12);
    const sourceTotal = totalCost(buckets);
    const projected = project({ buckets, scale: TimelineScale.OneHour });
    // The whole 12-bin, 6h session fits inside a 24h window, so nothing is
    // outside it and the totals must match to the cent.
    expect(totalCost(projected.buckets)).toBeCloseTo(sourceTotal, 8);
  });

  it("drops out-of-window cost rather than piling it on the edge column", () => {
    const buckets = costedBins(48);
    const projected = project({
      buckets,
      scale: TimelineScale.FiveMinutes,
      endMs: SESSION_START_MS + 24 * HOUR_MS,
    });
    // A 2h window over a 24h session sees a twelfth of it. The point is the
    // strict inequality: a clamping projection would show the full total.
    expect(totalCost(projected.buckets)).toBeLessThan(totalCost(buckets));
    expect(totalCost(projected.buckets)).toBeGreaterThan(0);
  });
});

describe("the scrubber's condition tracks whether the session exceeds the window", () => {
  it("reports no pannable window for a session that fits", () => {
    const projected = project({
      buckets: costedBins(6),
      endMs: SESSION_START_MS + HOUR_MS,
      scale: TimelineScale.FiveMinutes,
    });
    // 1h at 5m is 12 columns — inside 24. `maxWindowStart === 0` is exactly the
    // prototype's condition for rendering NO scrubber.
    expect(projected.maxWindowStart).toBe(0);
  });

  it("reports a pannable window for a session that does not fit", () => {
    const projected = project({
      buckets: costedBins(40),
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
    });
    // 8h at 5m is 96 columns; 96 - 24 leaves 72 positions to scrub through.
    expect(projected.totalColumns).toBe(96);
    expect(projected.maxWindowStart).toBe(72);
  });

  it("moves the visible stretch when the window start moves", () => {
    const buckets = costedBins(40);
    const atStart = project({
      buckets,
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
    });
    const panned = project({
      buckets,
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
      windowStart: 24,
    });
    expect(panned.windowStartMs).toBe(atStart.windowEndMs);
  });

  it("clamps a window start past the end instead of rendering past the session", () => {
    const projected = project({
      buckets: costedBins(40),
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
      windowStart: 9999,
    });
    expect(projected.windowStart).toBe(72);
  });
});

describe("the window follows the reader's position", () => {
  it("pans by the minimum needed to bring an off-window position into view", () => {
    // The one model the scrubber thumb and the `.tl-here` marker share: a
    // position past the right edge pulls the window along rather than leaving
    // the marker stranded.
    expect(
      followTimelineWindowStart({
        activeColumn: 30,
        currentWindowStart: 0,
        maxWindowStart: 72,
      })
    ).toBe(7);
    expect(
      followTimelineWindowStart({
        activeColumn: 2,
        currentWindowStart: 40,
        maxWindowStart: 72,
      })
    ).toBe(2);
  });

  it("leaves the window alone when the position is already visible", () => {
    expect(
      followTimelineWindowStart({
        activeColumn: 45,
        currentWindowStart: 40,
        maxWindowStart: 72,
      })
    ).toBe(40);
  });
});

describe("the default scale is the finest that still shows the whole run", () => {
  it("opens a session on a scale whose 24 columns cover it", () => {
    for (const [durationMinutes, expected] of [
      [30, TimelineScale.FiveMinutes],
      [120, TimelineScale.FiveMinutes],
      [121, TimelineScale.FifteenMinutes],
      [360, TimelineScale.FifteenMinutes],
      [361, TimelineScale.OneHour],
      [1440, TimelineScale.OneHour],
      [1441, TimelineScale.TwelveHours],
    ] as const) {
      /*
       * From a `12h` boundary — local midnight or noon — which is the one
       * instant that is simultaneously on a `5m`, `15m`, `1h` AND `12h`
       * boundary. That isolates the DURATION thresholds: with no boundary floor
       * to absorb, the geometry answer and the old threshold table agree, and
       * the block below is the one that moves the start off a boundary.
       *
       * A `5m` boundary is NOT enough, and the failure is the ticket in
       * miniature: from 14:30, a 24-hour run needs 25 HOURLY columns (the origin
       * floors back to 14:00), so `1h` is genuinely the wrong default for it —
       * the very case the duration table got wrong.
       */
      const startMs = boundaryStartMs(TimelineScale.TwelveHours);
      expect(
        defaultTimelineScale({
          endMs: startMs + durationMinutes * MINUTE_MS,
          startMs,
        })
      ).toBe(expected);
    }
  });

  it("needs no scrubber at the scale it opened on, for a session that fits", () => {
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const endMs = startMs + 300 * MINUTE_MS;
    const geometry = resolveTimelineScaleGeometry({
      endMs,
      scale: defaultTimelineScale({ endMs, startMs }),
      startMs,
    });
    expect(geometry.maxWindowStart).toBe(0);
  });

  /*
   * #4753 review (wongk). The default's whole contract is "a session that fits
   * needs no scrubbing", and the duration thresholds could not keep it, because
   * the GEOMETRY floors the origin to a clock boundary while the thresholds
   * measured raw elapsed time. A run that starts mid-column spends part of its
   * first column on time before it began and needs one more column than its
   * duration implies.
   *
   * A start on the boundary is the case that always worked, and it is here so a
   * "fix" that just coarsens everything by one step fails too.
   */
  it("accounts for the clock-boundary floor for a run that starts mid-column", () => {
    const onBoundaryMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const justPastBoundaryMs = onBoundaryMs + MINUTE_MS;

    expect(
      defaultTimelineScale({
        endMs: onBoundaryMs + 2 * HOUR_MS,
        startMs: onBoundaryMs,
      })
    ).toBe(TimelineScale.FiveMinutes);

    // The same two-hour run, begun at 09:01 rather than 09:00. 24 five-minute
    // columns from the 09:00 origin end at 11:00 and hide its last minute, so
    // `5m` is the wrong answer even though the duration is unchanged.
    expect(
      resolveTimelineScaleGeometry({
        endMs: justPastBoundaryMs + 2 * HOUR_MS,
        scale: TimelineScale.FiveMinutes,
        startMs: justPastBoundaryMs,
      }).totalColumns
    ).toBe(TIMELINE_VISIBLE_COLUMNS + 1);

    const chosen = defaultTimelineScale({
      endMs: justPastBoundaryMs + 2 * HOUR_MS,
      startMs: justPastBoundaryMs,
    });
    expect(chosen).toBe(TimelineScale.FifteenMinutes);
    // The contract itself, not just the label: no scrubber, because it fits.
    expect(
      resolveTimelineScaleGeometry({
        endMs: justPastBoundaryMs + 2 * HOUR_MS,
        scale: chosen,
        startMs: justPastBoundaryMs,
      }).maxWindowStart
    ).toBe(0);
  });
});

/**
 * #4753 review — the four ways this arithmetic could print a number the session
 * never produced. Each block is built from the input that EXPOSES the defect,
 * not from a tidy hour-aligned one: overlapping phase spans, a count spread thin
 * enough to round away, a marker exactly on the end boundary, and a segment row
 * that came off the wire malformed.
 */
describe("the projection cannot invent, delete, or misplace what it re-bins", () => {
  it("reconciles overlapping phase segments to the column's own cost", () => {
    /*
     * wongk's case verbatim: 40m `implement` and 40m `review` overlapping for
     * 30m inside one 60m column. `covered` was the UNION (50m) while the weights
     * summed each phase in FULL (40 + 40), so the emitted segments came to
     * 40 + 40 + 10 over a 60m denominator — 150% of the column's cost. The bar
     * overflowed and the tooltip billed spend that never happened.
     */
    const startMs = boundaryStartMs(TimelineScale.OneHour);
    const projected = project({
      buckets: [oneHourBin()],
      endMs: startMs + HOUR_MS,
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow("implement", startMs, startMs + 40 * MINUTE_MS),
        segmentRow(
          "review",
          startMs + 10 * MINUTE_MS,
          startMs + 50 * MINUTE_MS
        ),
      ],
      startMs,
    });

    const column = projected.buckets[0];
    const columnCost = column.cIn + column.cOut + column.cCache;
    expect(columnCost).toBeGreaterThan(0);

    const phases = projected.phaseCosts()[0];
    const attributed = Object.values(phases).reduce(
      (sum, value) => sum + value,
      0
    );
    // The reconciliation itself. Pre-fix this was 1.5x the column's cost.
    expect(attributed).toBeCloseTo(columnCost, 10);

    /*
     * And the attribution rule, so a "fix" that reconciles by throwing the
     * overlap away also fails: the shared 30m is split evenly, giving each phase
     * 10 + 15 = 25 of the 60m column, and the 10m nothing covers stays
     * unattributed rather than being folded into a neighbour.
     */
    expect(phases.implement).toBeCloseTo((columnCost * 25) / 60, 10);
    expect(phases.review).toBeCloseTo((columnCost * 25) / 60, 10);
    expect(phases[UNATTRIBUTED_KEY]).toBeCloseTo((columnCost * 10) / 60, 10);
  });

  it("conserves event counts when one event is spread across many columns", () => {
    /*
     * wongk's case verbatim: ONE event, one source bin an hour wide, projected
     * onto twelve 5m columns. Each column gets 1/12 of an event; rounding each
     * independently rounds every one of them to zero, and the session's only
     * event vanishes from every tooltip on the strip.
     */
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const projected = project({
      buckets: [countedBin({ toolStart: 1, total: 1 })],
      endMs: startMs + HOUR_MS,
      scale: TimelineScale.FiveMinutes,
      startMs,
    });

    expect(sumCounts(projected.buckets, "total")).toBe(1);
    expect(sumCounts(projected.buckets, "toolStart")).toBe(1);
    // Conserved AND integral — no column may report a fraction of an event.
    for (const column of projected.buckets) {
      expect(Number.isInteger(column.total)).toBe(true);
      expect(Number.isInteger(column.toolStart)).toBe(true);
    }
  });

  it("does not duplicate a count that lands evenly on a column edge", () => {
    /*
     * The OTHER direction, which the same defect produced: one event split
     * exactly in half across two columns rounded UP twice, so one event became
     * two. A fix that only floors would pass the test above and fail this one.
     */
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const projected = project({
      buckets: [countedBin({ toolStart: 3, total: 1 })],
      endMs: startMs + 10 * MINUTE_MS,
      scale: TimelineScale.FiveMinutes,
      startMs,
    });

    expect(sumCounts(projected.buckets, "total")).toBe(1);
    expect(sumCounts(projected.buckets, "toolStart")).toBe(3);
  });

  it("keeps a marker sitting exactly on the session's end boundary", () => {
    /*
     * `x === 100` is a value the producer really emits, for the run's terminal
     * commit/failure/limit. When the session exactly fills the window that lands
     * on `windowEndMs`, and the exclusive test dropped it — while the bucket
     * mapper this projection replaces clamps it into the last cell.
     */
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const projected = project({
      buckets: costedBins(4),
      endMs: startMs + 2 * HOUR_MS,
      markers: [marker(0), marker(100)],
      scale: TimelineScale.FiveMinutes,
      startMs,
    });

    expect(projected.windowEndMs).toBe(startMs + 2 * HOUR_MS);
    expect(projected.markers).toHaveLength(2);
    expect(projected.markers.at(-1)?.x).toBeCloseTo(100, 10);
  });

  it("still drops a boundary marker that belongs to the next window", () => {
    /*
     * The exclusivity the fix must NOT throw away. This session is twice the
     * window, so the instant at `windowEndMs` is the FIRST column of the next
     * window — admitting it here would draw the same dot twice as the reader
     * pans across.
     */
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const projected = project({
      buckets: costedBins(4),
      endMs: startMs + 4 * HOUR_MS,
      markers: [marker(50)],
      scale: TimelineScale.FiveMinutes,
      startMs,
    });

    expect(projected.windowEndMs).toBe(startMs + 2 * HOUR_MS);
    expect(projected.markers).toEqual([]);
  });

  it("plots a marker at its own instant rather than at its ordinal rank", () => {
    /*
     * `buildTurnMarker` derives `x` from `index / (total - 1)` — a rank, not a
     * time — whenever a session carries no persisted markers. Read as a clock
     * fraction, the second of three turns on a two-hour run plots at the
     * midpoint no matter when it actually fired. `atMs` is the producer handing
     * over the instant instead.
     */
    const startMs = boundaryStartMs(TimelineScale.FiveMinutes);
    const oneMinuteIn = startMs + MINUTE_MS;
    const projected = project({
      buckets: costedBins(4),
      endMs: startMs + 2 * HOUR_MS,
      markers: [{ ...marker(50), atMs: oneMinuteIn }],
      scale: TimelineScale.FiveMinutes,
      startMs,
    });

    // One minute into a two-hour window is 1/120 of it, not the 50% its rank
    // claims.
    expect(projected.markers[0]?.x).toBeCloseTo((1 / 120) * 100, 10);
  });

  it("refuses a segment row whose bounds came off the wire malformed", () => {
    /*
     * `SyncedActivitySegmentRow` crosses the sync wire out of SQLite, so its
     * bounds are parse-boundary input. A non-finite bound survived the clipping
     * guard — `NaN <= NaN` is FALSE — and put `NaN` into both the weights and
     * the denominator, so a column that really cost money rendered every segment
     * zero-width: a priced Activity bar showing nothing.
     */
    const startMs = boundaryStartMs(TimelineScale.OneHour);
    const projected = project({
      buckets: [oneHourBin()],
      endMs: startMs + HOUR_MS,
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow("implement", Number.NaN, startMs + 30 * MINUTE_MS),
        segmentRow(
          "review",
          startMs + 30 * MINUTE_MS,
          Number.POSITIVE_INFINITY
        ),
      ],
      startMs,
    });

    const column = projected.buckets[0];
    const columnCost = column.cIn + column.cOut + column.cCache;
    const phases = projected.phaseCosts()[0];
    for (const value of Object.values(phases)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    /*
     * Both rows are unusable, so the column's whole cost is UNATTRIBUTED — the
     * honest reading of a classification we cannot use, and the same answer an
     * absent row gets. The bar still draws its full height; it just does not
     * claim a phase.
     */
    expect(phases[UNATTRIBUTED_KEY]).toBeCloseTo(columnCost, 10);
    expect(phases.implement).toBeUndefined();
    expect(phases.review).toBeUndefined();
  });
});

describe("each Group by dimension re-cuts the same bar", () => {
  const buckets = multiModelBins();
  const projected = project({
    buckets,
    scale: TimelineScale.OneHour,
    segmentRows: phaseTiling(),
  });
  const modelColors = buildTimelineModelColors(buckets);
  const stacksFor = (grouping: TimelineStackGrouping) =>
    buildTimelineStacks({
      buckets: projected.buckets,
      grouping,
      modelColors,
      ownerLabel: "Ada Lovelace",
      phaseCosts: projected.phaseCosts,
    });

  it("keeps every column's total identical across all four groupings", () => {
    /*
     * The invariant that makes the control a VIEW control: re-cutting a bar must
     * never change how tall it is. A grouping that dropped or double-counted a
     * segment would look like the control was changing the data.
     */
    const byGrouping = Object.values(TimelineStackGrouping).map((grouping) =>
      stacksFor(grouping).map(sumSegments)
    );
    const columnTotals = projected.buckets.map(
      (bucket) => bucket.cIn + bucket.cOut + bucket.cCache
    );
    /*
     * Most columns are empty (8 bins over 4h projected into 24 hourly columns),
     * so without this the loop below is mostly `0 === 0` and would stay green if
     * the fixture stopped pricing anything at all.
     */
    expect(columnTotals.filter((total) => total > 0).length).toBeGreaterThan(0);
    for (const totals of byGrouping) {
      for (const [index, total] of totals.entries()) {
        expect(total).toBeCloseTo(columnTotals[index], 8);
      }
    }
  });

  it("cuts by token type into cache, output and input", () => {
    const priced = firstPricedStack(stacksFor(TimelineStackGrouping.TokenType));
    expect(priced.map((segment) => segment.key)).toEqual([
      "cache",
      "output",
      "input",
    ]);
  });

  it("cuts by model into one segment per model that spent", () => {
    const priced = firstPricedStack(stacksFor(TimelineStackGrouping.Model));
    expect(priced.map((segment) => segment.label)).toEqual([
      "claude-opus-5",
      "gpt-5.5",
    ]);
    // Distinct colours, or the cut conveys nothing the token-type cut did not.
    expect(new Set(priced.map((segment) => segment.colorVar)).size).toBe(2);
  });

  it("cuts by activity phase using the classifier's own tiling", () => {
    /*
     * Across the strip, not within one column: the tiling puts `explore` on the
     * first hour and `implement` on the next three, so the phase a column
     * carries depends on WHEN it is — which is the whole point of cutting by
     * phase, and an assertion pinned to one column would hide it.
     */
    const stacks = stacksFor(TimelineStackGrouping.ActivityPhase);
    const keys = new Set(
      stacks.flatMap((segments) => segments.map((segment) => segment.key))
    );
    expect(keys).toContain("explore");
    expect(keys).toContain("implement");
    const labels = new Set(
      stacks.flatMap((segments) => segments.map((segment) => segment.label))
    );
    expect(labels).toContain("Implement");
  });

  it("cuts by owner into one segment carrying the whole column", () => {
    const priced = firstPricedStack(stacksFor(TimelineStackGrouping.Owner));
    expect(priced).toHaveLength(1);
    expect(priced[0].label).toBe("Ada Lovelace");
  });

  it("produces genuinely different cuts, not the same list relabelled", () => {
    // Guards the whole block: without this, every assertion above could be
    // satisfied by a stacker that ignored `grouping` and returned token types.
    const keysByGrouping = Object.values(TimelineStackGrouping).map(
      (grouping) =>
        firstPricedStack(stacksFor(grouping))
          .map((segment) => segment.key)
          .join("|")
    );
    expect(new Set(keysByGrouping).size).toBe(keysByGrouping.length);
  });
});

describe("phase attribution stays honest about what it does not know", () => {
  /*
   * ISS-6054: deferring the split must not turn one derivation into one PER
   * ASK. The reader can toggle back to the phase cut as often as they like, and
   * each toggle re-enters `buildTimelineStacks` — an unmemoized thunk would
   * rescan every classifier span, per column, every time. Identity is the
   * assertion because a re-derivation returns an equal-but-new array.
   */
  it("derives the split once per projection, however often it is asked for", () => {
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow(
          "implement",
          SESSION_START_MS,
          SESSION_START_MS + 40 * MINUTE_MS
        ),
      ],
    });

    const first = projected.phaseCosts();
    expect(
      Object.keys(first.find((costs) => Object.keys(costs).length > 0) ?? {})
        .length
    ).toBeGreaterThan(0);
    expect(projected.phaseCosts()).toBe(first);
  });

  it("reports an untiled session's cost as unattributed, never as a phase", () => {
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      segmentRows: [],
    });
    const priced = projected
      .phaseCosts()
      .filter((costs) => Object.keys(costs).length > 0);
    expect(priced.length).toBeGreaterThan(0);
    for (const costs of priced) {
      expect(Object.keys(costs)).toEqual([UNATTRIBUTED_KEY]);
    }
  });

  it("keeps the uncovered remainder of a partly-tiled column unattributed", () => {
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      // Covers only the first half hour of the first column.
      segmentRows: [
        segmentRow(
          "implement",
          SESSION_START_MS,
          SESSION_START_MS + 30 * MINUTE_MS
        ),
      ],
    });
    const firstPriced = projected
      .phaseCosts()
      .find((costs) => Object.keys(costs).length > 0);
    expect(firstPriced).toBeDefined();
    expect(firstPriced?.[UNATTRIBUTED_KEY]).toBeGreaterThan(0);
    expect(firstPriced?.implement).toBeGreaterThan(0);
  });
});

describe("degenerate and hostile inputs degrade instead of lying", () => {
  it("keeps every dollar on a zero-span window", () => {
    /*
     * A real shape: every turn item on one timestamp, so `resolveSessionTimelineWindow`
     * returns a zero-length window, against 40 persisted bins. Clamping the
     * per-bin divisor to 1ms independently of the 0.025ms bin the caller
     * computed made every share 2.5%, so the strip and its tooltip printed a
     * fortieth of the session's real cost with nothing to say so.
     */
    const buckets = costedBins(40);
    const projected = project({
      buckets,
      endMs: SESSION_START_MS,
      scale: TimelineScale.FiveMinutes,
    });
    expect(totalCost(projected.buckets)).toBeCloseTo(totalCost(buckets), 8);
  });

  it("spreads a single source bin across the columns it covers", () => {
    const buckets = costedBins(1);
    const projected = project({
      buckets,
      endMs: SESSION_START_MS + 2 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
    });
    expect(totalCost(projected.buckets)).toBeCloseTo(totalCost(buckets), 8);
    expect(
      projected.buckets.filter(
        (bucket) => bucket.cIn + bucket.cOut + bucket.cCache > 0
      ).length
    ).toBeGreaterThan(1);
  });

  it("renders an empty window rather than throwing on an empty strip", () => {
    const projected = project({ buckets: [], scale: TimelineScale.OneHour });
    expect(projected.buckets).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
    expect(totalCost(projected.buckets)).toBe(0);
  });

  it("treats a non-finite window start as the beginning", () => {
    const projected = project({
      buckets: costedBins(40),
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      scale: TimelineScale.FiveMinutes,
      windowStart: Number.NaN,
    });
    expect(projected.windowStart).toBe(0);
  });

  it("draws one column for a clock-skewed session instead of an empty strip", () => {
    const geometry = resolveTimelineScaleGeometry({
      endMs: SESSION_START_MS - HOUR_MS,
      scale: TimelineScale.OneHour,
      startMs: SESSION_START_MS,
    });
    expect(geometry.totalColumns).toBe(1);
    expect(geometry.maxWindowStart).toBe(0);
  });

  it("drops a marker whose position is not a finite number", () => {
    const projected = project({
      buckets: costedBins(6),
      markers: [marker(Number.NaN)],
      scale: TimelineScale.OneHour,
    });
    // `NaN` fails every comparison, so an unguarded window test keeps it and the
    // dot renders at `left: NaN%`.
    expect(projected.markers).toHaveLength(0);
  });

  it("counts overlapping phase spans once, so untiled time stays unattributed", () => {
    /*
     * Segment spans genuinely overlap — a subagent span is re-filed alongside
     * the main agent's. Summing them can exceed the column width and drive the
     * uncovered remainder to zero, folding untiled time into the phases.
     */
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow(
          "implement",
          SESSION_START_MS,
          SESSION_START_MS + 40 * MINUTE_MS
        ),
        segmentRow(
          "review",
          SESSION_START_MS + 10 * MINUTE_MS,
          SESSION_START_MS + 50 * MINUTE_MS
        ),
      ],
    });
    const firstPriced = projected
      .phaseCosts()
      .find((costs) => Object.keys(costs).length > 0);
    // 50 of 60 minutes are covered once the two spans are unioned, so a real
    // tenth of the column is still nobody's.
    expect(firstPriced?.[UNATTRIBUTED_KEY]).toBeGreaterThan(0);
  });

  it("never attributes spend to the idle phase", () => {
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow(
          IDLE_PHASE_KEY,
          SESSION_START_MS,
          SESSION_START_MS + 50 * MINUTE_MS
        ),
        segmentRow(
          "implement",
          SESSION_START_MS + 50 * MINUTE_MS,
          SESSION_START_MS + 60 * MINUTE_MS
        ),
      ],
    });
    /*
     * Asserted across the STRIP, not on one column: the window is anchored to
     * the local clock, so which column a given span lands in depends on the
     * viewer's offset. What must hold everywhere is that `idle` never carries a
     * dollar — "Idle: 90% of the spend" is money assigned to a period defined by
     * nothing running — while its time shows up as `unattributed`.
     */
    const keys = new Set(
      projected.phaseCosts().flatMap((costs) => Object.keys(costs))
    );
    expect(keys).not.toContain(IDLE_PHASE_KEY);
    expect(keys).toContain(UNATTRIBUTED_KEY);
    expect(keys).toContain("implement");
  });
});

describe("wire-supplied keys cannot poison the projection", () => {
  it("attributes a phase literally named __proto__ without mutating anything", () => {
    /*
     * `SyncedActivitySegmentRow.phase` is documented as a bounded FREE STRING,
     * not a closed union — the desktop stores it as TEXT and the cloud never
     * validates it against a list, so a hostile or merely odd classifier version
     * can put any string here. On a plain `{}` accumulator, `map["__proto__"] ??
     * 0` resolves to `Object.prototype` rather than `0`, and the write mutates
     * the prototype for the whole realm.
     */
    const projected = project({
      buckets: multiModelBins(),
      scale: TimelineScale.OneHour,
      segmentRows: [
        segmentRow(
          "__proto__",
          SESSION_START_MS,
          SESSION_START_MS + 4 * HOUR_MS
        ),
      ],
    });

    const priced = projected
      .phaseCosts()
      .find((costs) => Object.keys(costs).length > 0);
    expect(priced).toBeDefined();
    // Counted as an ordinary phase key, carrying a real number. Read through
    // `Object.keys`/bracket access rather than `.__proto__`, which is the
    // deprecated accessor and would read the prototype instead of the entry.
    expect(Object.keys(priced ?? {})).toContain("__proto__");
    expect(Object.values(priced ?? {})[0]).toBeGreaterThan(0);
    // ...and nothing leaked onto the prototype of a plain object.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps a model literally named __proto__ out of the prototype chain", () => {
    /*
     * Built with `JSON.parse`, deliberately: an object LITERAL written
     * `{ __proto__: … }` sets the prototype instead of creating a key, so a
     * literal fixture would test nothing. `JSON.parse` creates a real own
     * `__proto__` property — which is exactly what the detail read does to this
     * payload, so this is the shape production actually receives.
     */
    const hostile: ActivityBucket[] = [
      {
        byModel: JSON.parse('{"__proto__":{"cCache":0.5,"cIn":1,"cOut":0.5}}'),
        cCache: 0.5,
        cIn: 1,
        cOut: 0.5,
        key: "hostile-0",
        label: "hostile",
        tl0: 0,
        toolStart: 1,
        total: 2,
      },
    ];
    const projected = project({
      buckets: hostile,
      scale: TimelineScale.OneHour,
    });
    const priced = projected.buckets.find(
      (bucket) => bucket.cIn + bucket.cOut + bucket.cCache > 0
    );
    expect(priced).toBeDefined();
    // Carried through as an ordinary model key, not swallowed and not promoted.
    expect(Object.keys(priced?.byModel ?? {})).toContain("__proto__");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("markers are re-anchored to the window, not clamped into it", () => {
  it("drops a marker that falls outside the visible window", () => {
    const projected = project({
      buckets: costedBins(40),
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      // A commit at the very end of an 8h session, with a 2h window at the start.
      markers: [marker(99)],
      scale: TimelineScale.FiveMinutes,
    });
    expect(projected.markers).toHaveLength(0);
  });

  it("re-anchors an in-window marker to its position within the window", () => {
    const projected = project({
      buckets: costedBins(40),
      endMs: SESSION_START_MS + 8 * HOUR_MS,
      // 12.5% of 8h is 1h — the midpoint of a 2h window starting at 0.
      markers: [marker(12.5)],
      scale: TimelineScale.FiveMinutes,
    });
    expect(projected.markers).toHaveLength(1);
    expect(projected.markers[0].x).toBeCloseTo(50, 6);
  });
});

describe("a strip may only be projected when its bins state their own clock", () => {
  const window = {
    endMs: SESSION_START_MS + 20 * HOUR_MS,
    startMs: SESSION_START_MS,
  };

  it("admits a strip whose every bin carries producer bounds", () => {
    expect(
      hasProducerBinBounds(withProducerBinBounds(costedBins(40), window))
    ).toBe(true);
  });

  it("refuses a strip persisted before producers carried bounds", () => {
    expect(hasProducerBinBounds(costedBins(40))).toBe(false);
  });

  it("refuses a strip where only some bins carry bounds", () => {
    const bounded = withProducerBinBounds(costedBins(4), window);
    expect(
      hasProducerBinBounds([...bounded.slice(0, 3), costedBins(1)[0]])
    ).toBe(false);
  });

  it("refuses a bin whose bounds arrived non-finite off the wire", () => {
    // `binStartMs`/`binEndMs` cross a parse boundary, so the in-process types do
    // not constrain them. `NaN` fails every comparison, so an admitted one would
    // put `NaN` cost into a column rather than being caught here.
    const [bin] = withProducerBinBounds(costedBins(1), window);
    expect(hasProducerBinBounds([{ ...bin, binEndMs: Number.NaN }])).toBe(
      false
    );
  });

  it("refuses a bin whose bounds arrived reversed", () => {
    const [bin] = withProducerBinBounds(costedBins(1), window);
    expect(
      hasProducerBinBounds([
        { ...bin, binEndMs: window.startMs, binStartMs: window.endMs },
      ])
    ).toBe(false);
  });

  it("refuses a bin whose bounds arrived zero-width", () => {
    /*
     * #4949 review: a zero-width bin is DROPPED by the accumulator (`binMs > 0`),
     * so admitting it here would pass the all-or-nothing gate and then lose that
     * bin's money anyway — a strip projected minus one bin, which is the partial
     * outcome the gate exists to rule out. Neither producer can emit one (both
     * floor their span at 1ms); a corrupt persisted row can.
     */
    const [bin] = withProducerBinBounds(costedBins(1), window);
    expect(
      hasProducerBinBounds([
        { ...bin, binEndMs: window.startMs, binStartMs: window.startMs },
      ])
    ).toBe(false);
  });

  it("refuses an empty strip rather than answering vacuously", () => {
    // `[].every(...)` is `true`; without the length check this hands the caller a
    // 24-column clock grid built for a session with no bars at all.
    expect(hasProducerBinBounds([])).toBe(false);
  });
});

function project({
  buckets,
  endMs,
  markers = [],
  scale,
  segmentRows = [],
  startMs = SESSION_START_MS,
  windowStart = 0,
}: {
  buckets: ActivityBucket[];
  endMs?: number;
  markers?: ActivityMarker[];
  scale: TimelineScale;
  segmentRows?: SyncedActivitySegmentRow[];
  startMs?: number;
  windowStart?: number;
}) {
  const sourceEndMs = endMs ?? startMs + buckets.length * 30 * MINUTE_MS;
  return projectSessionTimeline({
    limitDotEvents: [],
    markers,
    scale,
    segmentRows,
    source: {
      /*
       * ISS-5819 review (wongk): a bin is placed by ITS OWN producer bounds now,
       * not by dividing this window by the bin count, so every fixture here is
       * stamped the way a real producer emits it. Stamped uniformly over
       * `[startMs, sourceEndMs]`, which is the tiling these cases already
       * assumed — so each existing expectation still describes the same strip.
       */
      buckets: withProducerBinBounds(buckets, { endMs: sourceEndMs, startMs }),
      endMs: sourceEndMs,
      startMs,
    },
    windowStart,
  });
}

/** Two models, so the model cut has something to separate. */
function multiModelBins(): ActivityBucket[] {
  return Array.from({ length: 8 }, (_, index) => ({
    byModel: {
      "claude-opus-5": { cCache: 0.1, cIn: 0.4, cOut: 0.2 },
      "gpt-5.5": { cCache: 0.4, cIn: 0.6, cOut: 0.3 },
    },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: `multi-${index}`,
    label: `multi ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  }));
}

function phaseTiling(): SyncedActivitySegmentRow[] {
  return [
    segmentRow("explore", SESSION_START_MS, SESSION_START_MS + HOUR_MS),
    segmentRow(
      "implement",
      SESSION_START_MS + HOUR_MS,
      SESSION_START_MS + 4 * HOUR_MS
    ),
  ];
}

function segmentRow(
  phase: string,
  startMs: number,
  endMs: number
): SyncedActivitySegmentRow {
  return {
    confidence: 1,
    endMs,
    evidenceLayers: ["declared"],
    phase,
    startMs,
    version: 1,
  };
}

function marker(x: number): ActivityMarker {
  return { kind: "commit", label: "commit", t: "9:00", tl: 0, x };
}

/**
 * An instant on an exact LOCAL boundary for `scale`, asked of the module's own
 * flooring rather than hardcoded.
 *
 * The file pins a half-hour-offset timezone on purpose (see the header), so a
 * literal "09:00" is not on an hour boundary here — and a hardcoded UTC one
 * would quietly make every alignment assertion below a no-op.
 */
function boundaryStartMs(scale: TimelineScale): number {
  return resolveTimelineScaleGeometry({
    endMs: SESSION_START_MS,
    scale,
    startMs: SESSION_START_MS,
  }).originMs;
}

/** One priced bin, for a fixture that wants exactly one source bucket. */
function oneHourBin(): ActivityBucket {
  return {
    byModel: { "gpt-5.5": { cCache: 1, cIn: 1, cOut: 1 } },
    cCache: 1,
    cIn: 1,
    cOut: 1,
    key: "hour-0",
    label: "hour 0",
    tl0: 0,
    toolStart: 0,
    total: 0,
  };
}

/** One bin carrying COUNTS and no cost, so the count apportionment is isolated. */
function countedBin({
  toolStart,
  total,
}: {
  toolStart: number;
  total: number;
}): ActivityBucket {
  return {
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: "counted-0",
    label: "counted 0",
    tl0: 0,
    toolStart,
    total,
  };
}

function sumCounts(
  buckets: readonly ActivityBucket[],
  field: "toolStart" | "total"
): number {
  return buckets.reduce((sum, bucket) => sum + bucket[field], 0);
}

function totalCost(buckets: readonly ActivityBucket[]): number {
  return buckets.reduce(
    (sum, bucket) => sum + bucket.cIn + bucket.cOut + bucket.cCache,
    0
  );
}

function sumSegments(segments: readonly { value: number }[]): number {
  return segments.reduce((sum, segment) => sum + segment.value, 0);
}

/**
 * The first column that actually carries segments.
 *
 * Throws rather than asserting: an assertion in a helper is invisible to the
 * runner (it is not inside an `it`), so a fixture that silently stopped pricing
 * anything would surface as a confusing downstream failure instead of naming
 * itself. The throw fails the calling test with the real reason.
 */
function firstPricedStack<T extends { value: number }>(stacks: T[][]): T[] {
  const priced = stacks.find((segments) => segments.length > 0);
  if (!priced) {
    throw new Error("fixture produced no priced column to stack");
  }
  return priced;
}
