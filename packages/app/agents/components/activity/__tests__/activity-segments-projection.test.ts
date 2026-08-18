import {
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  type SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { ActivitySegmentKind } from "../activity-segment-kind";
import {
  ActivitySegmentsState,
  projectActivitySegments,
} from "../activity-segments-projection";

function row(
  overrides: Partial<SyncedActivitySegmentRow> = {}
): SyncedActivitySegmentRow {
  return {
    phase: "implement",
    startMs: 1000,
    endMs: 2000,
    confidence: 0.9,
    evidenceLayers: ["declared"],
    version: 1,
    ...overrides,
  };
}

describe("projectActivitySegments", () => {
  it("returns the unavailable state when no rows are present", () => {
    for (const rows of [undefined, null, []] as const) {
      const projection = projectActivitySegments(rows);
      expect(projection.state).toBe(ActivitySegmentsState.Unavailable);
      expect(projection.segments).toEqual([]);
      expect(projection.spanStartMs).toBeNull();
    }
  });

  it("positions active segments across the projected span", () => {
    const projection = projectActivitySegments([
      row({ startMs: 0, endMs: 1000, phase: "plan" }),
      row({ startMs: 1000, endMs: 2000, phase: "implement" }),
    ]);
    expect(projection.state).toBe(ActivitySegmentsState.Ready);
    expect(projection.spanStartMs).toBe(0);
    expect(projection.spanEndMs).toBe(2000);
    expect(projection.segments).toHaveLength(2);
    expect(projection.segments[0]).toMatchObject({
      phase: "plan",
      kind: ActivitySegmentKind.Active,
      leftPercent: 0,
    });
    expect(projection.segments[1].leftPercent).toBeCloseTo(50);
    expect(projection.segments[1].widthPercent).toBeCloseTo(50);
  });

  it("classifies idle spans distinctly and never as active work", () => {
    const projection = projectActivitySegments([
      row({ phase: "idle", evidenceLayers: [], startMs: 0, endMs: 500 }),
    ]);
    expect(projection.segments[0].kind).toBe(ActivitySegmentKind.Idle);
  });

  it("classifies evidence-free other/unknown spans as unavailable", () => {
    const projection = projectActivitySegments([
      row({ phase: "other", evidenceLayers: [], startMs: 0, endMs: 500 }),
      row({ phase: "unknown", evidenceLayers: [], startMs: 500, endMs: 900 }),
      // `other` WITH evidence stays active — the classifier had a signal.
      row({
        phase: "other",
        evidenceLayers: ["structural"],
        startMs: 900,
        endMs: 1200,
      }),
    ]);
    expect(projection.segments[0].kind).toBe(ActivitySegmentKind.Unavailable);
    expect(projection.segments[1].kind).toBe(ActivitySegmentKind.Unavailable);
    expect(projection.segments[2].kind).toBe(ActivitySegmentKind.Active);
  });

  it("drops malformed rows and reports the empty state when none survive", () => {
    const projection = projectActivitySegments([
      row({ startMs: 100, endMs: 100 }), // zero-span
      row({ startMs: 500, endMs: 200 }), // reversed
      row({ startMs: Number.NaN, endMs: 300 }), // non-finite
    ]);
    expect(projection.state).toBe(ActivitySegmentsState.Empty);
    expect(projection.malformedCount).toBe(3);
    expect(projection.segments).toEqual([]);
  });

  it("keeps valid rows while counting malformed ones alongside them", () => {
    const projection = projectActivitySegments([
      row({ startMs: 0, endMs: 1000 }),
      row({ startMs: 100, endMs: 100 }), // malformed
    ]);
    expect(projection.state).toBe(ActivitySegmentsState.Ready);
    expect(projection.segments).toHaveLength(1);
    expect(projection.malformedCount).toBe(1);
  });

  it("flags truncation when the row set hits the wire cap", () => {
    const rows = Array.from(
      { length: MAX_SYNCED_ACTIVITY_SEGMENTS },
      (_, index) => row({ startMs: index * 10, endMs: index * 10 + 5 })
    );
    const projection = projectActivitySegments(rows);
    expect(projection.truncated).toBe(true);
    expect(projection.state).toBe(ActivitySegmentsState.Ready);
  });

  it("floors width and clamps confidence for degenerate but valid spans", () => {
    const projection = projectActivitySegments([
      row({ startMs: 0, endMs: 100_000 }),
      // A 1ms sliver over a 100s span rounds to ~0 width; it must stay visible.
      row({ startMs: 50_000, endMs: 50_001, confidence: 5 }),
    ]);
    const sliver = projection.segments[1];
    expect(sliver.widthPercent).toBeGreaterThanOrEqual(0.75);
    expect(sliver.leftPercent + sliver.widthPercent).toBeLessThanOrEqual(100);
    expect(sliver.confidence).toBe(1);
  });

  it("normalizes non-string evidence-layer entries defensively", () => {
    const projection = projectActivitySegments([
      row({
        evidenceLayers: ["declared", 42, null] as unknown as string[],
        startMs: 0,
        endMs: 1000,
      }),
    ]);
    expect(projection.segments[0].evidenceLayers).toEqual(["declared"]);
  });

  // FEA-4238: idle-dominance signal that folds a near-empty phase strip.
  it("flags idleDominant for a mostly-idle span and reports the idle share", () => {
    // A 66h span with a single ~30min active stretch: the agent slept through
    // essentially the whole run, so the strip is ~98% empty hatch.
    const sixtySixHoursMs = 66 * 60 * 60 * 1000;
    const projection = projectActivitySegments([
      row({ phase: "idle", startMs: 0, endMs: sixtySixHoursMs }),
      row({
        phase: "implement",
        startMs: sixtySixHoursMs,
        endMs: sixtySixHoursMs + 30 * 60 * 1000,
      }),
    ]);
    expect(projection.state).toBe(ActivitySegmentsState.Ready);
    expect(projection.idleDominant).toBe(true);
    // Idle covers essentially the whole span.
    expect(projection.idleDurationShare).toBeGreaterThan(0.98);
  });

  it("does not flag idleDominant when the working stretch is meaningful", () => {
    // Half idle, half active — well above the 5% non-idle floor.
    const projection = projectActivitySegments([
      row({ phase: "idle", startMs: 0, endMs: 1000 }),
      row({ phase: "implement", startMs: 1000, endMs: 2000 }),
    ]);
    expect(projection.idleDominant).toBe(false);
    expect(projection.idleDurationShare).toBeCloseTo(0.5, 5);
  });

  it("treats unattributed (non-idle) coverage as non-idle for the dominance guard", () => {
    // A long unattributed span plus a short idle one: unattributed is not idle,
    // so the strip is NOT idle-dominant even though little is classified active.
    const projection = projectActivitySegments([
      row({
        phase: "unknown",
        evidenceLayers: [],
        startMs: 0,
        endMs: 10_000,
      }),
      row({ phase: "idle", startMs: 10_000, endMs: 10_100 }),
    ]);
    expect(projection.segments[0].kind).toBe(ActivitySegmentKind.Unavailable);
    expect(projection.idleDominant).toBe(false);
  });

  it("never flags idleDominant when the byte-truncation signal is set", () => {
    // FEA-3779: the same ~98%-idle prefix, but flagged truncated. A start-ordered
    // prefix can be all-idle at the front while the dropped tail held the real
    // work, so folding it as "mostly idle" would lie about a partial input. It
    // must stay inline (and report truncated) instead.
    const sixtySixHoursMs = 66 * 60 * 60 * 1000;
    const rows = [
      row({ phase: "idle", startMs: 0, endMs: sixtySixHoursMs }),
      row({
        phase: "implement",
        startMs: sixtySixHoursMs,
        endMs: sixtySixHoursMs + 30 * 60 * 1000,
      }),
    ];
    const complete = projectActivitySegments(rows);
    expect(complete.idleDominant).toBe(true);

    const truncated = projectActivitySegments(rows, { rowsTruncated: true });
    expect(truncated.truncated).toBe(true);
    expect(truncated.idleDominant).toBe(false);
    // The idle share is still reported (it is a raw measure), but the fold does
    // not engage on a partial tiling.
    expect(truncated.idleDurationShare).toBeGreaterThan(0.98);
  });

  it("treats a null/omitted truncation flag as complete", () => {
    const rows = [row({ phase: "idle", startMs: 0, endMs: 100_000 })];
    for (const rowsTruncated of [null, undefined, false] as const) {
      const projection = projectActivitySegments(rows, { rowsTruncated });
      // rows.length is under the cap, so a falsy flag means complete.
      expect(projection.truncated).toBe(false);
    }
  });
});
