import { describe, expect, it } from "vitest";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "./activity-attribution";

function span(startMs: number, endMs: number): ActivitySegmentSpan {
  return { phase: "build", startMs, endMs, confidence: 1 };
}

function event(tMs: number, inputTokens: number): ActivitySpendEvent {
  return { tMs, costUsd: null, inputTokens, outputTokens: 0 };
}

describe("attributeBranchSessionActivity — ordered span cursor", () => {
  it("drops turns past the last span and still places a later turn that rewinds into the tiling", () => {
    const result = attributeBranchSessionActivity(
      [span(0, 10), span(10, 20)],
      [event(25, 1), event(30, 2), event(15, 4)]
    );
    expect(result.map((segment) => segment.inputTokens)).toEqual([0, 4]);
  });

  it("binary-searches forward past earlier spans when a turn rewinds behind the cursor", () => {
    const result = attributeBranchSessionActivity(
      [span(0, 10), span(10, 20), span(20, 30), span(30, 40)],
      [event(35, 1), event(25, 2)]
    );
    expect(result.map((segment) => segment.inputTokens)).toEqual([0, 0, 2, 1]);
  });
});
