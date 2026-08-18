import { describe, expect, it } from "vitest";
import {
  buildCostCandidate,
  buildWallTimeCandidate,
} from "../agent-coaching-dimensions";
import { emptyFeedbackInsights } from "../agent-coaching-scoring";
import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
} from "../agent-coaching-types";

const INPUT: AgentCoachingInput = {
  analytics: null,
  feedback: [],
  generatedAt: new Date("2026-06-18T12:00:00.000Z"),
  recentEvents: [],
  skills: [],
  workflow: null,
};

function makeMetrics(
  overrides: Partial<AgentCoachingGroundedMetrics>
): AgentCoachingGroundedMetrics {
  return {
    lookbackDays: 30,
    sessionsAnalyzed: 10,
    eventsAnalyzed: 100,
    eventsAnalyzedIsAllTime: true,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    avgSessionDurationSec: null,
    unwrappedShellCommandRatio: null,
    shellCommandsSampled: 0,
    repeatedCommandFamilies: [],
    totalSkillInvocations: 0,
    peakFrustration: null,
    modelMix: null,
    planModeRatio: null,
    topPrompts: null,
    sessionCadence: null,
    ...overrides,
  };
}

describe("buildCostCandidate (stage/codex review)", () => {
  it("suppresses the tip when the dollar estimate is under the spend floor", () => {
    // 50k tokens clears the token floor but the estimate is sub-$5 — a
    // "cut spend" tip must not open with a trivial dollar figure.
    const candidate = buildCostCandidate(
      INPUT,
      makeMetrics({ totalTokens: 60_000, estimatedCostUsd: 0.31 }),
      emptyFeedbackInsights()
    );
    expect(candidate).toBeNull();
  });

  it("does not fabricate model concentration when attribution is missing", () => {
    const candidate = buildCostCandidate(
      INPUT,
      makeMetrics({
        totalTokens: 2_000_000,
        estimatedCostUsd: 120,
        modelMix: null,
      }),
      emptyFeedbackInsights()
    );
    const prose = [
      candidate?.tip.body ?? "",
      candidate?.tip.detail.whyThisRecommendation ?? "",
      ...(candidate?.tip.evidence ?? []),
    ].join("\n");

    expect(candidate).not.toBeNull();
    // The fabricated placeholder must never appear.
    expect(prose).not.toContain("one model dominates");
    // Evidence is measured facts only: no invented model row.
    expect(candidate?.tip.evidence).not.toContain("one model dominates");
  });

  it("formats the estimated dollars with a thousands separator", () => {
    const candidate = buildCostCandidate(
      INPUT,
      makeMetrics({ totalTokens: 5_000_000, estimatedCostUsd: 1234.56 }),
      emptyFeedbackInsights()
    );
    expect(candidate?.tip.body).toContain("$1,234.56");
    expect(candidate?.tip.body).not.toContain("$1234.56");
  });

  it("keeps the measured model row when attribution exists", () => {
    const candidate = buildCostCandidate(
      INPUT,
      makeMetrics({
        totalTokens: 2_000_000,
        estimatedCostUsd: 120,
        modelMix: [
          { model: "opus", tokens: 1_600_000, share: 0.8, sessions: 8 },
        ],
      }),
      emptyFeedbackInsights()
    );
    expect(
      candidate?.tip.evidence.some((line) => line.includes("opus carries 80%"))
    ).toBe(true);
  });
});

describe("buildWallTimeCandidate (stage review)", () => {
  it("does not splice the cadence clause into the body", () => {
    const candidate = buildWallTimeCandidate(
      INPUT,
      makeMetrics({
        avgSessionDurationSec: 2820,
        sessionCadence: {
          byHour: [],
          byWeekday: [],
          nightOwlRatio: 0.42,
          label: "night owl: 42% of activity after midnight",
        },
      }),
      emptyFeedbackInsights()
    );
    // The body carries only the wall-time fact, not the cadence clause.
    expect(candidate?.tip.body).toContain("min of wall-clock time.");
    expect(candidate?.tip.body).not.toContain("night owl");
    // Cadence lives in evidence as a standalone clause — no "cadence:" prefix.
    expect(candidate?.tip.evidence).toContain(
      "night owl: 42% of activity after midnight"
    );
    expect(
      candidate?.tip.evidence.some((line) => line.startsWith("cadence:"))
    ).toBe(false);
  });

  it("drops the cadence evidence row when cadence is absent", () => {
    const candidate = buildWallTimeCandidate(
      INPUT,
      makeMetrics({ avgSessionDurationSec: 2820, sessionCadence: null }),
      emptyFeedbackInsights()
    );
    expect(
      candidate?.tip.evidence.some((line) => line.includes("your usual hours"))
    ).toBe(false);
  });
});
