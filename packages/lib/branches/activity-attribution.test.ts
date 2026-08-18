import { describe, expect, it } from "vitest";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "./activity-attribution";

function span(
  phase: string,
  startMs: number,
  endMs: number,
  confidence = 0.9
): ActivitySegmentSpan {
  return { phase, startMs, endMs, confidence };
}

function event(
  tMs: number,
  costUsd: number | null,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): ActivitySpendEvent {
  return {
    tMs,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

describe("attributeBranchSessionActivity", () => {
  it("attributes each turn's spend + tokens to the span whose window contains it", () => {
    const spans = [
      span("implement", 0, 100),
      span("review", 100, 200),
      span("validate", 200, 300),
    ];
    const events = [
      event(10, 0.5, 100, 50),
      event(50, 0.25, 40, 20),
      event(150, 1.0, 200, 100),
      event(250, 0.1, 10, 5),
    ];

    const result = attributeBranchSessionActivity(spans, events);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      phase: "implement",
      costUsd: 0.75,
      inputTokens: 140,
      outputTokens: 70,
    });
    expect(result[1]).toMatchObject({ phase: "review", costUsd: 1.0 });
    expect(result[2]).toMatchObject({ phase: "validate", costUsd: 0.1 });
    // Preserves span order + confidence + bounds.
    expect(result[0]).toMatchObject({
      startMs: 0,
      endMs: 100,
      confidence: 0.9,
    });
  });

  it("attributes all token lanes to the covering activity segment", () => {
    const result = attributeBranchSessionActivity(
      [span("implement", 0, 100)],
      [event(10, 0.5, 100, 50, 30, 10), event(20, null, 20, 5, 7, 3)]
    );

    expect(result[0]).toMatchObject({
      inputTokens: 120,
      outputTokens: 55,
      cacheReadTokens: 37,
      cacheWriteTokens: 13,
    });
  });

  it("uses half-open [startMs, endMs): a turn at the boundary lands in the NEXT span", () => {
    const spans = [span("implement", 0, 100), span("review", 100, 200)];
    // t=100 is the exclusive upper bound of implement and inclusive lower of review.
    const result = attributeBranchSessionActivity(spans, [event(100, 0.4)]);
    expect(result[0].costUsd).toBeNull();
    expect(result[1].costUsd).toBe(0.4);
  });

  it("drops spend in a gap (no covering span) — the caller's unattributed residual", () => {
    const spans = [span("implement", 0, 100), span("review", 200, 300)];
    // t=150 falls in the gap between the two spans.
    const result = attributeBranchSessionActivity(spans, [
      event(50, 0.5),
      event(150, 9.99),
      event(250, 0.5),
    ]);
    expect(result[0].costUsd).toBe(0.5);
    expect(result[1].costUsd).toBe(0.5);
    // The $9.99 gap turn is not fabricated into either span.
    const attributed = (result[0].costUsd ?? 0) + (result[1].costUsd ?? 0);
    expect(attributed).toBe(1.0);
  });

  it("keeps cost null (never 0) when every covered turn is unpriced, but still counts tokens", () => {
    const spans = [span("implement", 0, 100)];
    const result = attributeBranchSessionActivity(spans, [
      event(10, null, 100, 50),
      event(20, null, 40, 20),
    ]);
    expect(result[0].costUsd).toBeNull();
    expect(result[0].inputTokens).toBe(140);
    expect(result[0].outputTokens).toBe(70);
  });

  it("treats a 0-cost turn like unpriced (cross-surface symmetric: cloud default-0 == desktop null)", () => {
    const spans = [span("implement", 0, 100)];
    // Cloud emits 0 for an unpriced turn (non-nullable `@default(0)` Decimal),
    // desktop emits null — both must resolve the span to `null`, never `0`.
    const result = attributeBranchSessionActivity(spans, [
      event(10, 0, 100, 50),
      event(20, 0, 40, 20),
    ]);
    expect(result[0].costUsd).toBeNull();
    // Tokens still count (real usage), matching the all-null case.
    expect(result[0].inputTokens).toBe(140);
    expect(result[0].outputTokens).toBe(70);
  });

  it("retains positive-priced presence when compact rounding produces zero", () => {
    const compactEvent = event(10, 0, 3, 2);
    compactEvent.positiveCostSignal = true;

    const result = attributeBranchSessionActivity(
      [span("implement", 0, 100)],
      [compactEvent]
    );

    expect(result[0].costUsd).toBe(0);
    expect(result[0].inputTokens).toBe(3);
    expect(result[0].outputTokens).toBe(2);
  });

  it("mixes priced and unpriced turns: sums the priced ones, marks the span priced", () => {
    const spans = [span("implement", 0, 100)];
    const result = attributeBranchSessionActivity(spans, [
      event(10, null, 10, 5),
      event(20, 0.3, 20, 10),
    ]);
    expect(result[0].costUsd).toBe(0.3);
    expect(result[0].inputTokens).toBe(30);
  });

  it("sums fractional costs exactly via integer micro-cents", () => {
    const spans = [span("implement", 0, 100)];
    // 0.1 + 0.2 in float is 0.30000000000000004; micro-cent summation is exact.
    const result = attributeBranchSessionActivity(spans, [
      event(10, 0.1),
      event(20, 0.2),
    ]);
    expect(result[0].costUsd).toBe(0.3);
  });

  it("drops malformed spans (non-positive duration / non-finite bounds)", () => {
    const spans = [
      span("implement", 0, 100),
      span("bad-zero", 200, 200),
      span("bad-inverted", 400, 300),
      span("bad-nan", Number.NaN, 500),
    ];
    const result = attributeBranchSessionActivity(spans, [event(10, 0.5)]);
    expect(result.map((r) => r.phase)).toEqual(["implement"]);
  });

  it("returns [] for an empty tiling", () => {
    expect(attributeBranchSessionActivity([], [event(10, 0.5)])).toEqual([]);
  });

  it("ignores events with a non-finite instant", () => {
    const spans = [span("implement", 0, 100)];
    const result = attributeBranchSessionActivity(spans, [
      event(Number.NaN, 0.5),
      event(10, 0.25),
    ]);
    expect(result[0].costUsd).toBe(0.25);
  });
});
