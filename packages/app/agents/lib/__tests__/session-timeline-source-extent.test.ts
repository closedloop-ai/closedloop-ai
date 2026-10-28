import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { withProducerBinBounds } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import {
  projectSessionTimeline,
  resolveTimelineSourceExtent,
  TimelineColumnCoverage,
  type TimelineSourceExtent,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import { describe, expect, it } from "vitest";
import {
  costedBins,
  HOUR_MS,
  MINUTE_MS,
  quietBins,
  SESSION_START_MS,
} from "./session-timeline-geometry-fixtures";

/**
 * ISS-5850 — the source bins tile the COLLECTOR's extent, not the rendered
 * window, and the columns beyond that extent must stop claiming a measurement.
 *
 * WHY THE FIXTURE IS SHAPED THIS WAY, because it is the whole test. The
 * pre-ISS-5850 projection is CORRECT BY CONSTRUCTION on a strip whose bins span
 * the full window: every column overlaps the source, so no column can be
 * wrongly reported, and a suite built on that fixture is green against both the
 * fixed and the broken code. Every case below therefore pins an extent
 * NARROWER than the window it is projected onto — which is the real shape (the
 * collector bins `[firstActivity, lastActivity]`, the axis spans the whole run)
 * and the only shape where the bug is visible at all.
 *
 * The counterfactual: delete the `columnCoverage` line from
 * `projectSessionTimeline`, or make `resolveColumnCoverage` return `Measured`
 * unconditionally, and the "withholds" cases below go red while the "does not
 * withhold" cases stay green. Both directions are asserted in the same suite on
 * purpose — a hardcoded `Unmeasured` satisfies the first half alone.
 */

/** A 30-minute collector extent, dropped inside a 2-hour rendered window. */
const EXTENT_START_MS = SESSION_START_MS + 30 * MINUTE_MS;
const EXTENT_END_MS = SESSION_START_MS + HOUR_MS;
const WINDOW_END_MS = SESSION_START_MS + 2 * HOUR_MS;

function project({
  binWindow = { endMs: EXTENT_END_MS, startMs: EXTENT_START_MS },
  bins = costedBins(6),
  extent,
  scale = TimelineScale.FiveMinutes,
  windowStart = 0,
}: {
  binWindow?: { endMs: number; startMs: number };
  bins?: ActivityBucket[];
  extent: TimelineSourceExtent | null;
  scale?: TimelineScale;
  windowStart?: number;
}) {
  /*
   * The bins are laid over the EXTENT, exactly as the collector lays them, while
   * the strip's own window is the wider `[SESSION_START_MS, WINDOW_END_MS]` the
   * axis resolved. That disagreement is the subject under test; building the
   * bins over the window instead would model a producer that does not exist and
   * would make every assertion below vacuous.
   *
   * `bins` and `binWindow` move TOGETHER, and default to the strip the extent
   * constants above describe. A case that states a different extent overrides
   * both, so its payload stays the internally consistent one a well-formed
   * producer sends; a case that means to model a stale, corrupt, or foreign
   * extent overrides only `extent` and says so.
   */
  return projectSessionTimeline({
    limitDotEvents: [],
    markers: [],
    scale,
    source: {
      buckets: withProducerBinBounds(bins, binWindow),
      endMs: WINDOW_END_MS,
      extent,
      startMs: SESSION_START_MS,
    },
    windowStart,
  });
}

const MEASURED_EXTENT: TimelineSourceExtent = {
  endMs: EXTENT_END_MS,
  startMs: EXTENT_START_MS,
};

/**
 * ISS-8110 — 10:30–11:30, which at `1h` straddles the column edge at 11:00 and
 * is CONTAINED IN neither the 10:00–11:00 column nor the 11:00–12:00 one.
 */
const STRADDLING_EXTENT: TimelineSourceExtent = {
  endMs: SESSION_START_MS + 150 * MINUTE_MS,
  startMs: SESSION_START_MS + 90 * MINUTE_MS,
};

describe("ISS-5850 — a column outside the measured extent", () => {
  it("is withheld, while the columns the extent reaches are not", () => {
    /*
     * At `5m` the 24-column window covers 09:00–11:00 in 5-minute columns, and
     * the extent is 09:30–10:00 — columns 6..11. The two expectations are ONE
     * test deliberately: asserting only that something is withheld passes
     * against a projection that withholds everything, which would blank a strip
     * whose source covers it fully.
     */
    const projected = project({ extent: MEASURED_EXTENT });

    expect(projected.columnCoverage).toHaveLength(TIMELINE_VISIBLE_COLUMNS);
    // Inside the extent — measured, and must NOT be withheld.
    expect(projected.columnCoverage[6]).toBe(TimelineColumnCoverage.Measured);
    expect(projected.columnCoverage[11]).toBe(TimelineColumnCoverage.Measured);
    // Outside it on both sides — the collector never looked here.
    expect(projected.columnCoverage[0]).toBe(TimelineColumnCoverage.Unmeasured);
    expect(projected.columnCoverage[5]).toBe(TimelineColumnCoverage.Unmeasured);
    expect(projected.columnCoverage[12]).toBe(
      TimelineColumnCoverage.Unmeasured
    );
    expect(projected.columnCoverage[23]).toBe(
      TimelineColumnCoverage.Unmeasured
    );
  });

  it("is withheld even though its bucket carries a real, spendable zero", () => {
    /*
     * The defect in one assertion. An uncovered column is emitted with every
     * field at zero — structurally identical to a column the collector measured
     * and found quiet — so `cost === 0` cannot be the test for either. Pinning
     * the zero here is what proves `columnCoverage` is carrying information the
     * bucket itself does not.
     */
    const projected = project({ extent: MEASURED_EXTENT });
    const uncovered = projected.buckets[0];

    expect(uncovered?.cIn).toBe(0);
    expect(uncovered?.cOut).toBe(0);
    expect(uncovered?.total).toBe(0);
    expect(projected.columnCoverage[0]).toBe(TimelineColumnCoverage.Unmeasured);
  });

  it("does not exist when the extent covers the whole rendered window", () => {
    /*
     * The pair that stops a hardcoded `Unmeasured` passing the suite. Same
     * window, same bins, extent widened to span it — and now NOTHING may be
     * withheld, because every column really is backed.
     */
    const projected = project({
      extent: { endMs: WINDOW_END_MS, startMs: SESSION_START_MS },
    });

    expect(projected.columnCoverage).not.toContain(
      TimelineColumnCoverage.Unmeasured
    );
    expect(new Set(projected.columnCoverage)).toEqual(
      new Set([TimelineColumnCoverage.Measured])
    );
  });

  it("keeps a column the extent only PARTLY covers", () => {
    /*
     * Overlap, not containment. The extent starts at 09:30, which is a column
     * boundary at `5m`, so this needs a coarser scale to produce a straddling
     * column: at `1h` column 0 is 09:00–10:00 and holds the entire extent while
     * being four times its width. Withholding it would delete a true figure —
     * and on a real session it is the column the run starts in.
     */
    const projected = project({
      extent: MEASURED_EXTENT,
      scale: TimelineScale.OneHour,
    });

    expect(projected.columnCoverage[0]).toBe(TimelineColumnCoverage.Measured);
    expect(projected.buckets[0]?.cIn).toBeGreaterThan(0);
    // The hour AFTER the extent is still withheld, so this is not just "index 0
    // is always measured".
    expect(projected.columnCoverage[1]).toBe(TimelineColumnCoverage.Unmeasured);
  });

  it("keeps an EMPTY column the extent only partly covers", () => {
    /*
     * ISS-8110 — the one shape that separates OVERLAP from CONTAINMENT, and the
     * shape this suite was missing. The straddling column above also holds
     * bins, so `hasDepositedContent` answers for it before the extent
     * arithmetic is ever consulted, and a containment rule swapped into
     * `resolveColumnCoverage` passes the whole file unnoticed.
     *
     * The payload is internally CONSISTENT, which is the point (#6233 review):
     * the bins tile the stated extent, exactly as both producers build them,
     * rather than being a leftover strip only a corrupt producer could pair
     * with this extent. They are quiet because that is the only way this case
     * exists at all — a partly-covered column always contains one of the
     * extent's endpoints, so it can only be EMPTY when every bin over it
     * deposited nothing, which is what the collector emits for an interval
     * inside its measured extent that carried no timeline row and no priced
     * token event.
     */
    const projected = project({
      binWindow: STRADDLING_EXTENT,
      bins: quietBins(4),
      extent: STRADDLING_EXTENT,
      scale: TimelineScale.OneHour,
    });

    // The premise: nothing landed in either straddling column, so coverage
    // cannot be answered by the bins and the extent has to decide it.
    const straddling = projected.buckets[1];
    expect(straddling?.cIn).toBe(0);
    expect(straddling?.cOut).toBe(0);
    expect(straddling?.cCache).toBe(0);
    expect(straddling?.total).toBe(0);
    expect(straddling?.toolStart).toBe(0);
    // Overlapped on the right (10:30–11:00) and on the left (11:00–11:30).
    expect(projected.columnCoverage[1]).toBe(TimelineColumnCoverage.Measured);
    expect(projected.columnCoverage[2]).toBe(TimelineColumnCoverage.Measured);
    // And the pair that stops "everything is measured" satisfying this: an
    // equally empty column the extent does not reach AT ALL is still withheld.
    expect(projected.buckets[0]?.total).toBe(0);
    expect(projected.columnCoverage[0]).toBe(TimelineColumnCoverage.Unmeasured);
  });

  it("reports UNKNOWN, not unmeasured, when the producer stated no extent", () => {
    /*
     * The version-skew direction (AC4/AC5). An older desktop build sends no
     * extent, and the honest answer is that coverage cannot be established —
     * NOT that the columns are unmeasured. Collapsing the two would withhold
     * every column on most of the installed base, deleting the strip for them.
     */
    const projected = project({ extent: null });

    expect(new Set(projected.columnCoverage)).toEqual(
      new Set([TimelineColumnCoverage.Unknown])
    );
    expect(projected.columnCoverage).not.toContain(
      TimelineColumnCoverage.Unmeasured
    );
    expect(projected.columnCoverage).not.toContain(
      TimelineColumnCoverage.Measured
    );
  });

  it("still places the bins correctly, extent or no extent", () => {
    /*
     * The projection's existing contract is untouched by this ticket: bins are
     * placed from their own bounds either way, so the BARS must be byte-equal
     * across the two branches and only the coverage differs. Without this, a
     * regression that silently stopped accumulating uncovered-window bins would
     * read as "the disclosure works".
     */
    const withExtent = project({ extent: MEASURED_EXTENT });
    const withoutExtent = project({ extent: null });

    expect(withExtent.buckets.map((bucket) => bucket.cIn)).toEqual(
      withoutExtent.buckets.map((bucket) => bucket.cIn)
    );
    expect(withExtent.buckets.map((bucket) => bucket.total)).toEqual(
      withoutExtent.buckets.map((bucket) => bucket.total)
    );
  });
});

describe("ISS-5850 — resolveTimelineSourceExtent, at the wire boundary", () => {
  it("accepts a well-formed extent", () => {
    expect(
      resolveTimelineSourceExtent({
        endMs: EXTENT_END_MS,
        startMs: EXTENT_START_MS,
      })
    ).toEqual({ endMs: EXTENT_END_MS, startMs: EXTENT_START_MS });
  });

  it("refuses the shapes a skewed or corrupt producer can send", () => {
    /*
     * Every one of these is REACHABLE at runtime despite the in-process types:
     * `span` crosses a JSON boundary out of the cloud read and a structured
     * clone out of desktop IPC, so absence, half-presence, inversion and
     * non-finiteness are all parse-boundary inputs, not type-forbidden ones.
     *
     * The HALF-STATED case is the one worth naming: pairing a real `startMs`
     * with the window's own end would manufacture a coverage claim out of one
     * measured number and one borrowed one, and it would look exactly like a
     * stated extent to every consumer downstream.
     */
    expect(resolveTimelineSourceExtent(null)).toBeNull();
    expect(resolveTimelineSourceExtent(undefined)).toBeNull();
    expect(resolveTimelineSourceExtent({})).toBeNull();
    expect(
      resolveTimelineSourceExtent({ startMs: EXTENT_START_MS })
    ).toBeNull();
    expect(resolveTimelineSourceExtent({ endMs: EXTENT_END_MS })).toBeNull();
    expect(
      resolveTimelineSourceExtent({
        endMs: Number.NaN,
        startMs: EXTENT_START_MS,
      })
    ).toBeNull();
    // Inverted, and zero-width — a zero-width extent would otherwise withhold
    // every column in the window on a degenerate producer value.
    expect(
      resolveTimelineSourceExtent({
        endMs: EXTENT_START_MS,
        startMs: EXTENT_END_MS,
      })
    ).toBeNull();
    expect(
      resolveTimelineSourceExtent({
        endMs: EXTENT_START_MS,
        startMs: EXTENT_START_MS,
      })
    ).toBeNull();
  });

  it("routes a refused extent to UNKNOWN coverage, not to a withheld strip", () => {
    /*
     * Wires the parser to the consequence. A refusal must land on the same
     * degrade path as an absent field — proving the two agree here is what
     * stops a corrupt row blanking a strip that would otherwise render.
     */
    const projected = project({
      extent: resolveTimelineSourceExtent({ startMs: EXTENT_START_MS }),
    });

    expect(new Set(projected.columnCoverage)).toEqual(
      new Set([TimelineColumnCoverage.Unknown])
    );
  });

  it("never withdraws a column a bin actually deposited into", () => {
    /*
     * ISS-5850 code review. The extent is a CLAIM; a bin landing in a column is
     * an OBSERVATION, and the observation wins. Here the stated extent is a
     * one-minute sliver that reaches none of the columns the bins fell in — a
     * stale, corrupt, or foreign-producer extent — and the strip must still
     * report the columns it is visibly drawing bars in as measured.
     *
     * Without the bins-outrank-the-extent rule this is the silent inversion the
     * review caught: the projection withholds a figure the reader can see.
     */
    const projected = project({
      extent: {
        endMs: SESSION_START_MS + MINUTE_MS,
        startMs: SESSION_START_MS,
      },
    });

    const drawn = projected.buckets
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket }) => bucket.cIn + bucket.cOut + bucket.cCache > 0);

    // The premise: this fixture really does draw bars outside the stated extent.
    expect(drawn.length).toBeGreaterThan(0);
    for (const { index } of drawn) {
      expect(projected.columnCoverage[index]).toBe(
        TimelineColumnCoverage.Measured
      );
    }
    /*
     * And the pair that stops "everything is measured" satisfying this: a column
     * with nothing in it AND no overlap with the extent is still withheld. The
     * last column is both — the sliver sits at the very start of the window, and
     * the bins are 30 minutes in.
     */
    const last = TIMELINE_VISIBLE_COLUMNS - 1;
    const lastBucket = projected.buckets[last];
    expect(
      (lastBucket?.cIn ?? 0) +
        (lastBucket?.cOut ?? 0) +
        (lastBucket?.cCache ?? 0) +
        (lastBucket?.total ?? 0)
    ).toBe(0);
    expect(projected.columnCoverage[last]).toBe(
      TimelineColumnCoverage.Unmeasured
    );
  });
});
