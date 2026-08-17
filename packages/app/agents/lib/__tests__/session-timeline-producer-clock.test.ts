import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { projectSessionTimeline } from "@repo/app/agents/lib/session-timeline-projection";
import {
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { describe, expect, it } from "vitest";
import {
  costedBins,
  HOUR_MS,
  MINUTE_MS,
  SESSION_START_MS,
} from "./session-timeline-geometry-fixtures";

/**
 * #4949 review (wongk) — a bin is placed by ITS OWN clock, not by dividing the
 * page's window.
 *
 * ITS OWN FILE because the rest of `session-timeline-projection.test.ts` cannot
 * make this case. That suite's `project` helper stamps its bins uniformly over
 * the very window it then hands over as `source`, so the producer's clock and the
 * page's axis window COINCIDE — and where they coincide, reading a bin's own
 * bounds and dividing the window by the bin count give the same answer. Every
 * expectation there therefore survives the window-derived placement this change
 * deleted, which is precisely why it needed a suite of its own rather than one
 * more case in a file whose shared fixture defines the defect away.
 *
 * Here the two clocks genuinely differ, which is the ordinary production case:
 * the desktop collector bins over the session's real ACTIVITY extent (below, a
 * 20-minute burst at 09:00), while the detail page's axis window is resolved
 * from transcript / phase / lifecycle bounds and spans the six hours 08:00-14:00.
 * Dividing that window by the four bins makes each bin 90 minutes wide starting
 * at 08:00, smearing the burst's money across the whole afternoon — "a bar under
 * the 14:00 tick claiming spend that happened at 09:00", in the module
 * docstring's own words. Every expectation below fails under that placement.
 *
 * NO TIMEZONE PIN, unlike the sibling suite: nothing here reads a formatted local
 * time. Column identity is asserted through `key`, which carries the column's
 * epoch start, and the `5m` grid these instants fall on is invariant under every
 * real UTC offset (all whole multiples of 15 minutes).
 */

/** The burst the producer actually measured: 09:00-09:20. */
const BURST_START_MS = SESSION_START_MS;
const BURST_END_MS = SESSION_START_MS + 20 * MINUTE_MS;
/** The page's axis window, a different clock entirely: 08:00-14:00. */
const PAGE_WINDOW_START_MS = SESSION_START_MS - HOUR_MS;
const PAGE_WINDOW_END_MS = SESSION_START_MS + 5 * HOUR_MS;
/** The four `5m` columns the burst's own bounds fall in. */
const BURST_COLUMNS = [12, 13, 14, 15];
/** `cIn + cOut + cCache` of one {@link costedBins} bin. */
const BIN_COST = 2;

describe("a bin is placed by its own clock, not by dividing the page's window", () => {
  it("puts each bin's money in the columns its own bounds cover", () => {
    const projected = projectBurst();

    // Anchors the indices to the CLOCK rather than to a magic number: the first
    // burst column is the one starting at the burst's own first instant.
    expect(projected.buckets[BURST_COLUMNS[0]].key).toBe(
      `${TimelineScale.FiveMinutes}-${BURST_START_MS}`
    );
    // Each 5-minute bin lands whole in one 5-minute column, undivided.
    for (const index of BURST_COLUMNS) {
      expect(columnCost(projected.buckets[index])).toBeCloseTo(BIN_COST, 6);
    }
  });

  it("leaves the columns the bins never covered empty", () => {
    const projected = projectBurst();

    // 08:00-09:00 is before the strip's first bin and 09:20-10:00 is after its
    // last, so both stretches hold nothing. Window-derived placement starts bin 0
    // at 08:00 and runs it to 09:30, putting a share of the burst in every one of
    // these columns — money under a tick the producer never measured it at.
    for (const [index, column] of projected.buckets.entries()) {
      if (BURST_COLUMNS.includes(index)) {
        continue;
      }
      expect(columnCost(column)).toBe(0);
    }
  });

  it("keeps the whole strip's money, and does not claim the bars are interpolated", () => {
    const projected = projectBurst();

    // Every bin is inside the visible window because its OWN bounds put it there,
    // so conservation is exact. Dividing the six-hour window by four instead
    // pushes bins 2 and 3 — half the session's spend — past the window's 10:00
    // edge, where they are dropped as out-of-window.
    const total = projected.buckets.reduce(
      (sum, column) => sum + columnCost(column),
      0
    );
    expect(total).toBeCloseTo(BURST_COLUMNS.length * BIN_COST, 6);
    // A 5-minute bin in a 5-minute column is separately measured, not
    // interpolated. A 90-minute window-derived bin would be wider than its
    // column, and the strip would tell the reader its bars were interpolated.
    expect(projected.subColumnSource).toBe(false);
  });

  it("renders the window's full column count regardless", () => {
    // Guards the indices above: they are positions in a 24-column strip, so a
    // change to the visible count has to be reckoned with here rather than
    // silently shifting which column the assertions read.
    expect(projectBurst().buckets).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
  });
});

function projectBurst() {
  return projectSessionTimeline({
    limitDotEvents: [],
    markers: [],
    scale: TimelineScale.FiveMinutes,
    segmentRows: [],
    source: {
      buckets: withProducerBinBounds(costedBins(BURST_COLUMNS.length), {
        endMs: BURST_END_MS,
        startMs: BURST_START_MS,
      }),
      // Deliberately NOT the span the bins were stamped over.
      endMs: PAGE_WINDOW_END_MS,
      startMs: PAGE_WINDOW_START_MS,
    },
    windowStart: 0,
  });
}

function columnCost(column: ActivityBucket): number {
  return column.cIn + column.cOut + column.cCache;
}
