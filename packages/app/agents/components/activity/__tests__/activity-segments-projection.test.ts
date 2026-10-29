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

  // ISS-7779 (whitlockk, #6094): reaching MAX_SYNCED_ACTIVITY_SEGMENTS once flagged
  // the projection truncated, from when 5000 was the desktop's ASSEMBLY cap.
  // ISS-4578 made it the PER-CHUNK wire bound (the desktop paginates a larger
  // tiling across parts and the cloud merges them), so a COMPLETE tiling of
  // >=5000 rows is ordinary. Row count says nothing about completeness, and the
  // projection carries no truncation output at all (ISS-9858): the read-side
  // flag is disclosed by the Session Timeline legend straight off the detail.
  it("projects a complete tiling at or past the per-chunk wire cap as ready, in full", () => {
    const rows = Array.from(
      { length: MAX_SYNCED_ACTIVITY_SEGMENTS + 1 },
      (_, index) => row({ startMs: index * 10, endMs: index * 10 + 5 })
    );
    const projection = projectActivitySegments(rows);
    expect(projection.state).toBe(ActivitySegmentsState.Ready);
    expect(projection.segments).toHaveLength(MAX_SYNCED_ACTIVITY_SEGMENTS + 1);
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

  it("classifies an unattributed span as unavailable, not idle", () => {
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
    expect(projection.segments[1].kind).toBe(ActivitySegmentKind.Idle);
  });
});
