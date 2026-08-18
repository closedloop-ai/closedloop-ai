import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import {
  buildTimelineStacks,
  resolveTimelineStackGrouping,
  TIMELINE_STACK_GROUPINGS,
  TimelineStackGrouping,
  visibleTimelineStackGroupings,
} from "../session-timeline-stacks";

/**
 * ISS-5841 (supersedes FEA-3906): activity phases come off the Session detail
 * page behind a flag. The Group-by control must not offer to re-cut the chart
 * by a phase model the page no longer shows anywhere.
 */
describe("visibleTimelineStackGroupings", () => {
  it("offers every cut while phases are enabled", () => {
    expect(visibleTimelineStackGroupings(true)).toEqual(
      TIMELINE_STACK_GROUPINGS
    );
  });

  it("withholds the activity-phase cut while phases are gated off", () => {
    const values = visibleTimelineStackGroupings(false).map((o) => o.value);
    expect(values).not.toContain(TimelineStackGrouping.ActivityPhase);
  });

  // Withholding phases must not quietly cost a reader the other three cuts.
  it("leaves the other cuts alone", () => {
    const values = visibleTimelineStackGroupings(false).map((o) => o.value);
    expect(values).toEqual([
      TimelineStackGrouping.TokenType,
      TimelineStackGrouping.Model,
      TimelineStackGrouping.Owner,
    ]);
  });

  // Absent, not present-and-disabled: a disabled row still tells the reader a
  // capability exists and is being withheld from them, which is the opposite of
  // what gating this off is for.
  it("removes the option rather than keeping a disabled row", () => {
    expect(visibleTimelineStackGroupings(false)).toHaveLength(
      TIMELINE_STACK_GROUPINGS.length - 1
    );
  });
});

describe("resolveTimelineStackGrouping", () => {
  // The selection is in-memory (useState, not persisted), so a fresh mount can
  // never resurrect a phase cut from storage. This guards the remaining case: a
  // flag flipping OFF mid-session while the phase cut is on screen, which would
  // leave the chart stacked by a dimension its own control no longer lists.
  it("falls back to the default cut when phases are gated off mid-session", () => {
    expect(
      resolveTimelineStackGrouping(TimelineStackGrouping.ActivityPhase, false)
    ).toBe(TimelineStackGrouping.TokenType);
  });

  it("keeps the phase cut while phases are enabled", () => {
    expect(
      resolveTimelineStackGrouping(TimelineStackGrouping.ActivityPhase, true)
    ).toBe(TimelineStackGrouping.ActivityPhase);
  });

  it.each([
    TimelineStackGrouping.TokenType,
    TimelineStackGrouping.Model,
    TimelineStackGrouping.Owner,
  ])("never rewrites the unrelated cut %s", (grouping) => {
    expect(resolveTimelineStackGrouping(grouping, false)).toBe(grouping);
    expect(resolveTimelineStackGrouping(grouping, true)).toBe(grouping);
  });
});

/**
 * ISS-6054: the phase split is DERIVED only for the cut that draws it.
 *
 * Pinned by whether it was asked for, not by what came out: the segments a
 * non-phase cut returns are identical whether the split was derived or not — it
 * was simply discarded — so an output assertion cannot catch this coming back.
 */
describe("buildTimelineStacks derives the phase split only when it is drawn", () => {
  it.each([
    TimelineStackGrouping.TokenType,
    TimelineStackGrouping.Model,
    TimelineStackGrouping.Owner,
  ])("never asks for it under the %s cut", (grouping) => {
    const phaseCosts = vi.fn((): readonly Record<string, number>[] => [
      { implement: 1 },
    ]);

    const stacks = buildTimelineStacks({
      buckets: [pricedColumn(0), pricedColumn(1)],
      grouping,
      modelColors: new Map([["gpt-5.5", "var(--chart-1)"]]),
      ownerLabel: OWNER_LABEL,
      phaseCosts,
    });

    expect(phaseCosts).not.toHaveBeenCalled();
    // The cut still draws — "never asked" must not be bought by dropping bars.
    expect(stacks[0]?.length).toBeGreaterThan(0);
  });

  it("asks for it once for the whole strip under the phase cut", () => {
    const phaseCosts = vi.fn((): readonly Record<string, number>[] => [
      { implement: 1 },
      { review: 2 },
    ]);

    const stacks = buildTimelineStacks({
      buckets: [pricedColumn(0), pricedColumn(1)],
      grouping: TimelineStackGrouping.ActivityPhase,
      modelColors: new Map([["gpt-5.5", "var(--chart-1)"]]),
      ownerLabel: OWNER_LABEL,
      phaseCosts,
    });

    // Once, not once per column — the columns cannot disagree about the split.
    expect(phaseCosts).toHaveBeenCalledTimes(1);
    expect(
      stacks.map((column) => column.map((segment) => segment.key))
    ).toEqual([["implement"], ["review"]]);
  });
});

const OWNER_LABEL = "Ada Lovelace";

function pricedColumn(index: number): ActivityBucket {
  return {
    byModel: { "gpt-5.5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: `column-${index}`,
    label: `column ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  };
}
