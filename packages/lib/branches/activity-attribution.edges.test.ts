/**
 * Edge-case coverage for attributeBranchSessionActivity's sourceId / costEvents paths.
 * Lines 161-174: if (event.sourceId) + if (costUsd non-null and ≥ 0) → costEvents.push
 * Lines 200-209: ...(sourceEventIds.length > 0 ? { sourceEventIds } : {})
 *                ...(costEvents.length > 0 ? { costEvents: [...].sort() } : {})
 */
import { describe, expect, it } from "vitest";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "./activity-attribution";

const SPAN: ActivitySegmentSpan = {
  phase: "build",
  startMs: 0,
  endMs: 1000,
  confidence: 0.9,
};

function ev(
  tMs: number,
  costUsd: number | null,
  sourceId: string | undefined,
  inputTokens: number
): ActivitySpendEvent {
  const base: ActivitySpendEvent = {
    tMs,
    costUsd,
    inputTokens,
    outputTokens: 0,
  };
  if (sourceId !== undefined) {
    base.sourceId = sourceId;
  }
  return base;
}

describe("attributeBranchSessionActivity — sourceId / costEvents paths", () => {
  it("populates sourceEventIds and costEvents when event has sourceId and positive cost", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(100, 0.5, "src-1", 10)]
    );
    expect(result[0].sourceEventIds).toEqual(["src-1"]);
    expect(result[0].costEvents).toHaveLength(1);
    expect(result[0].costEvents?.[0]).toEqual({
      sourceEventId: "src-1",
      occurredAtMs: 100,
      costUsd: 0.5,
    });
  });

  it("populates sourceEventIds but NOT costEvents when event has sourceId and null cost", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(100, null, "src-null-cost", 10)]
    );
    expect(result[0].sourceEventIds).toEqual(["src-null-cost"]);
    // null costUsd → no costEvent pushed
    expect(result[0].costEvents).toBeUndefined();
  });

  it("populates sourceEventIds but NOT costEvents when cost is zero (treated as unpriced)", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(100, 0, "src-zero", 10)]
    );
    expect(result[0].sourceEventIds).toEqual(["src-zero"]);
    // cost = 0 — costUsd >= 0 so costEvent IS pushed but anyPriced stays false
    expect(result[0].costEvents).toHaveLength(1);
    expect(result[0].costEvents?.[0].costUsd).toBe(0);
    // span is still null-cost (0 is "unpriced" for the anyPriced signal)
    expect(result[0].costUsd).toBeNull();
  });

  it("sorts costEvents by occurredAtMs ascending when two events have sourceIds", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(800, 0.3, "src-late", 5), ev(200, 0.1, "src-early", 5)]
    );
    const events = result[0].costEvents;
    expect(events).toHaveLength(2);
    expect(events?.[0].occurredAtMs).toBe(200);
    expect(events?.[1].occurredAtMs).toBe(800);
  });

  it("sorts costEvents by sourceEventId via localeCompare when occurredAtMs is identical", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(500, 0.4, "src-zzz", 5), ev(500, 0.2, "src-aaa", 5)]
    );
    const events = result[0].costEvents;
    expect(events).toHaveLength(2);
    // Same tMs → localeCompare arm: "src-aaa" < "src-zzz"
    expect(events?.[0].sourceEventId).toBe("src-aaa");
    expect(events?.[1].sourceEventId).toBe("src-zzz");
  });

  it("omits sourceEventIds and costEvents from output when no events have sourceId", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [{ tMs: 100, costUsd: 0.5, inputTokens: 5, outputTokens: 0 }]
    );
    expect(result[0].sourceEventIds).toBeUndefined();
    expect(result[0].costEvents).toBeUndefined();
  });

  it("deduplicates sourceEventIds via Set when the same id appears twice", () => {
    const result = attributeBranchSessionActivity(
      [SPAN],
      [ev(100, 0.1, "src-dup", 5), ev(200, 0.2, "src-dup", 5)]
    );
    // sourceEventIds deduped by Set → only one entry
    expect(result[0].sourceEventIds).toEqual(["src-dup"]);
    // Both costEvents are still recorded
    expect(result[0].costEvents).toHaveLength(2);
  });
});
