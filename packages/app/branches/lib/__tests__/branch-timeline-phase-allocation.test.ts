import type { BranchActivitySegment } from "@repo/api/src/types/branch";
import {
  BRANCH_ACTIVITY_ORDER,
  UNATTRIBUTED_KEY,
} from "@repo/lib/branches/activity-rollup";
import { compactBranchDetailPayload } from "@repo/lib/branches/branch-detail-payload";
import { describe, expect, it } from "vitest";
import { NON_WORK_PHASE_GREY } from "../../../shared/lib/non-work-phase-colors";
import { makeBranchSession } from "../../__tests__/branch-fixtures";
import { phaseAllocationsForWindow } from "../branch-timeline-phase-allocation";

describe("phaseAllocationsForWindow", () => {
  it("preserves activity cost and token allocations after payload compaction", () => {
    const raw = {
      sessions: [
        makeBranchSession({
          activitySegments: [
            segment({
              costUsd: 3,
              sourceEventIds: ["event-1"],
              costEvents: [
                { sourceEventId: "event-1", occurredAtMs: 500, costUsd: 3 },
              ],
            }),
            segment({
              phase: "review",
              startMs: 1000,
              endMs: 2000,
              costUsd: 5,
            }),
          ],
        }),
      ],
    };
    const compact = compactBranchDetailPayload(raw);
    for (const [start, end] of [
      [0, 2000],
      [500, 1500],
      [1000, 2000],
    ]) {
      expect(
        phaseAllocationsForWindow(
          compact.sessions[0]?.activitySegments,
          start!,
          end!
        )
      ).toEqual(
        phaseAllocationsForWindow(
          raw.sessions[0]?.activitySegments,
          start!,
          end!
        )
      );
    }
  });

  it("returns a single fully-unattributed allocation when segments is undefined", () => {
    const result = phaseAllocationsForWindow(undefined, 0, 1000);

    expect(result).toEqual([
      {
        key: `phase:${UNATTRIBUTED_KEY}`,
        phase: UNATTRIBUTED_KEY,
        label: "Unattributed",
        color: NON_WORK_PHASE_GREY.unattributed,
        cacheWeight: 1,
        costWeight: 1,
        inputWeight: 1,
        outputWeight: 1,
        sortRank: BRANCH_ACTIVITY_ORDER.length + 1,
      },
    ]);
  });

  it("returns the same fully-unattributed allocation for an empty segment list", () => {
    expect(phaseAllocationsForWindow([], 0, 1000)).toEqual(
      phaseAllocationsForWindow(undefined, 0, 1000)
    );
  });

  it("attributes full weight to a single phase covering the whole window", () => {
    const result = phaseAllocationsForWindow([segment()], 0, 1000);

    expect(result).toEqual([
      {
        key: "phase:implement",
        phase: "implement",
        label: "Implement",
        color: "var(--chart-3)",
        cacheWeight: 1,
        costWeight: 1,
        inputWeight: 1,
        outputWeight: 1,
        sortRank: BRANCH_ACTIVITY_ORDER.indexOf("implement"),
      },
    ]);
  });

  it("splits weight proportionally across phases and orders by taxonomy rank", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({
          phase: "review",
          startMs: 500,
          endMs: 1000,
          costUsd: 10,
          inputTokens: 50,
          outputTokens: 50,
        }),
        segment({
          phase: "implement",
          startMs: 0,
          endMs: 500,
          costUsd: 10,
          inputTokens: 50,
          outputTokens: 50,
        }),
      ],
      0,
      1000
    );

    expect(result.map((allocation) => allocation.phase)).toEqual([
      "implement",
      "review",
    ]);
    expect(result[0]?.costWeight).toBeCloseTo(0.5);
    expect(result[1]?.costWeight).toBeCloseTo(0.5);
  });

  it("excludes a segment with no overlap in the requested window", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({ phase: "implement", startMs: 0, endMs: 500 }),
        segment({ phase: "rework", startMs: 2000, endMs: 3000 }),
      ],
      0,
      1000
    );

    expect(result.map((allocation) => allocation.phase)).toEqual(["implement"]);
  });

  it("falls back to time-based weights, including the unattributed remainder, when a phase has no priced or token evidence", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({
          phase: "implement",
          startMs: 0,
          endMs: 500,
          costUsd: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ],
      0,
      1000
    );

    const implementAllocation = result.find((a) => a.phase === "implement");
    const unattributedAllocation = result.find(
      (a) => a.phase === UNATTRIBUTED_KEY
    );
    expect(result.map((a) => a.phase).sort()).toEqual(
      ["implement", UNATTRIBUTED_KEY].sort()
    );
    expect(implementAllocation?.costWeight).toBeCloseTo(0.5);
    expect(unattributedAllocation?.costWeight).toBeCloseTo(0.5);
    expect(implementAllocation?.inputWeight).toBeCloseTo(0.5);
    expect(unattributedAllocation?.inputWeight).toBeCloseTo(0.5);
  });

  it("normalizes phase casing and surrounding whitespace to the canonical key", () => {
    const result = phaseAllocationsForWindow(
      [segment({ phase: "  Implement  " })],
      0,
      1000
    );

    expect(result.map((a) => a.phase)).toEqual(["implement"]);
  });

  it("treats a blank/whitespace-only phase as 'other'", () => {
    const result = phaseAllocationsForWindow(
      [segment({ phase: "   " })],
      0,
      1000
    );

    expect(result.map((a) => a.phase)).toEqual(["other"]);
  });

  it("sorts unranked phases alphabetically when their taxonomy rank ties", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({ phase: "zzz-custom", startMs: 0, endMs: 500 }),
        segment({ phase: "aaa-custom", startMs: 500, endMs: 1000 }),
      ],
      0,
      1000
    );

    expect(result.map((a) => a.phase)).toEqual(["aaa-custom", "zzz-custom"]);
    expect(result[0]?.label).toBe("Aaa Custom");
    expect(result[0]?.color).toBe(NON_WORK_PHASE_GREY.other);
    expect(result[0]?.sortRank).toBe(BRANCH_ACTIVITY_ORDER.length);
  });

  it("floors a zero/negative-width window to 1ms and still resolves to the fully-unattributed allocation", () => {
    const result = phaseAllocationsForWindow(
      [segment({ phase: "implement", startMs: 400, endMs: 401 })],
      500,
      500
    );

    expect(result).toEqual(phaseAllocationsForWindow(undefined, 0, 1000));
  });

  it("drops a phase with zero cost/token evidence when another phase in the same window has real evidence", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({
          phase: "implement",
          startMs: 0,
          endMs: 500,
          costUsd: 10,
          inputTokens: 50,
          outputTokens: 50,
        }),
        segment({
          phase: "review",
          startMs: 500,
          endMs: 1000,
          costUsd: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ],
      0,
      1000
    );

    expect(result.map((allocation) => allocation.phase)).toEqual(["implement"]);
  });

  it("sums cache read and write tokens into one cache-weight evidence stream", () => {
    const result = phaseAllocationsForWindow(
      [
        segment({
          phase: "implement",
          startMs: 0,
          endMs: 500,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
        }),
        segment({
          phase: "review",
          startMs: 500,
          endMs: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 10,
        }),
      ],
      0,
      1000
    );

    const implementAllocation = result.find((a) => a.phase === "implement");
    const reviewAllocation = result.find((a) => a.phase === "review");
    expect(implementAllocation?.cacheWeight).toBeCloseTo(0.75);
    expect(reviewAllocation?.cacheWeight).toBeCloseTo(0.25);
  });
});

function segment(
  overrides: Partial<BranchActivitySegment> = {}
): BranchActivitySegment {
  return {
    phase: "implement",
    startMs: 0,
    endMs: 1000,
    costUsd: 10,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 5,
    cacheWriteTokens: 5,
    confidence: 1,
    ...overrides,
  };
}
