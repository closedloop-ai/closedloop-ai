import { describe, expect, it } from "vitest";
import {
  type AgentCoachingCandidate,
  candidateImpactScore,
  costImpactScore,
  dedupeGeneratedTipsByLever,
  feedbackAdjustment,
  harnessRoutingImpactScore,
  rankCandidatePool,
  resilienceImpactScore,
  reuseSkillImpactScore,
  summarizeFeedback,
  testSequencingImpactScore,
  tipFollowUp,
  wallTimeImpactScore,
} from "../agent-coaching-scoring";
import type {
  AgentCoachingFeedbackEvent,
  AgentCoachingGroundedMetrics,
  AgentCoachingTip,
  AgentCoachingTipCategory,
} from "../agent-coaching-types";

const TODAY = "2026-06-18";

describe("rankCandidatePool (FEA-3265)", () => {
  it("orders surfaced tips most → least impactful (strongest at index 0)", () => {
    const pool = [
      candidate("low", "context_hygiene", "context_management", 10),
      candidate("mid", "reuse", "token_efficiency", 50),
      candidate("high", "cost", "cost", 90),
    ];

    const tips = rankCandidatePool(pool, 5);

    // The deck shows one tip at a time from index 0, so the strongest lever is
    // "Tip 1 of N" — most impactful first, least last.
    expect(tips.map((tip) => tip.id)).toEqual(["high", "mid", "low"]);
  });

  it("keeps at most one tip per lever — the higher-impact one (diversity)", () => {
    const pool = [
      // Two candidates on the SAME lever (reuse): only the stronger survives.
      candidate("reuse-weak", "reuse", "token_efficiency", 20),
      candidate("reuse-strong", "reuse", "speed_of_delivery", 80),
      candidate("cost", "cost", "cost", 60),
    ];

    const tips = rankCandidatePool(pool, 5);
    const ids = tips.map((tip) => tip.id);

    // Only one reuse tip, and it is the higher-impact one.
    expect(ids).toContain("reuse-strong");
    expect(ids).not.toContain("reuse-weak");
    // The surfaced levers are all distinct.
    const levers = tips.map((tip) => tip.category);
    expect(new Set(levers).size).toBe(levers.length);
  });

  it("does NOT force one tip per category / no skill quota", () => {
    // A pool that is ALL reuse (skill/workflow) candidates collapses to ONE
    // surfaced tip under diversity — proving there is no forced 5-slot fill and
    // no guaranteed skill-creation quota.
    const pool = [
      candidate("reuse-a", "reuse", "token_efficiency", 70),
      candidate("reuse-b", "reuse", "speed_of_delivery", 60),
      candidate("reuse-c", "reuse", "token_efficiency", 50),
    ];

    const tips = rankCandidatePool(pool, 5);

    expect(tips).toHaveLength(1);
    expect(tips[0]?.id).toBe("reuse-a");
  });

  it("caps the surfaced set at the limit, taking the top diverse candidates", () => {
    const pool = [
      candidate("a", "context_hygiene", "context_management", 95),
      candidate("b", "reuse", "token_efficiency", 90),
      candidate("c", "cost", "cost", 85),
      candidate("d", "wall_time", "wall_time", 80),
      candidate("e", "resilience", "resilience", 75),
      candidate("f", "harness_routing", "opportunity_analysis", 70),
    ];

    const tips = rankCandidatePool(pool, 5);

    // Top-5 by impact, presented most→least impactful. The weakest of the six
    // (harness_routing @70) is dropped.
    expect(tips).toHaveLength(5);
    expect(tips.map((tip) => tip.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("candidateImpactScore (FEA-3265)", () => {
  it("is grounded in the raw dimension score, nudged by prior feedback", () => {
    const acted: AgentCoachingFeedbackEvent[] = [
      {
        action: "action_clicked",
        category: "cost",
        createdAt: "2026-06-16T10:00:00.000Z",
        tipId: "rebalance-model-spend",
      },
    ];

    const base = candidateImpactScore(40, "cost", [], TODAY);
    const nudged = candidateImpactScore(40, "cost", acted, TODAY);

    expect(base).toBe(40);
    expect(nudged).toBeGreaterThan(base);
  });

  it("floors at 0 even after a dismissal penalty", () => {
    const dismissed: AgentCoachingFeedbackEvent[] = [
      {
        action: "dismissed",
        category: "cost",
        createdAt: "2026-06-16T10:00:00.000Z",
        tipId: "rebalance-model-spend",
      },
    ];

    expect(candidateImpactScore(5, "cost", dismissed, TODAY)).toBe(0);
  });
});

describe("dimension scorers rank non-skill vs skill by evidence (FEA-3265)", () => {
  it("a heavy-cost, thin-repetition profile scores cost above skill-reuse", () => {
    const metrics = makeMetrics({
      totalTokens: 1_800_000,
      estimatedCostUsd: 180,
      unwrappedShellCommandRatio: 0.1,
    });

    const cost = costImpactScore(metrics.totalTokens, metrics.estimatedCostUsd);
    // Thin repetition: only 3 observed calls, modest savings.
    const reuse = reuseSkillImpactScore(3, 35, metrics);

    expect(cost).toBeGreaterThan(reuse);
  });

  it("a heavy-repetition, low-spend profile scores skill-reuse above cost", () => {
    const metrics = makeMetrics({
      totalTokens: 60_000,
      estimatedCostUsd: 4,
      unwrappedShellCommandRatio: 0.9,
    });

    const cost = costImpactScore(metrics.totalTokens, metrics.estimatedCostUsd);
    const reuse = reuseSkillImpactScore(20, 60, metrics);

    expect(reuse).toBeGreaterThan(cost);
  });

  it("wall-time impact rises with average session minutes", () => {
    expect(wallTimeImpactScore(1800)).toBeGreaterThan(wallTimeImpactScore(700));
  });
});

// whitlockk review: the scorers must not manufacture impact from volume/aggregate
// signals that don't actually describe the lever.
describe("scorer correctness guards (whitlockk review, FEA-3265)", () => {
  it("test-sequencing scores 0 for a test-only history despite high volume", () => {
    // 40 test delegations, 0 explore: negative/zero exploration skew. This
    // history already DOES what the tip advises, so volume alone must not lift
    // it above 0.
    expect(testSequencingImpactScore(0, 40)).toBe(0);
    // A balanced mix (skew 0) is also 0 regardless of volume.
    expect(testSequencingImpactScore(20, 20)).toBe(0);
    // A genuine explore skew still scores, and more volume amplifies it.
    expect(testSequencingImpactScore(18, 2)).toBeGreaterThan(
      testSequencingImpactScore(9, 1)
    );
  });

  it("resilience does not double-count nearby errors", () => {
    // The caller passes the TEXT-ONLY frustration score (peak.score −
    // nearbyErrorCount) as intensity; a fixed text score with more nearby
    // errors should rise ONCE (via errorPressure), never twice.
    const fewErrors = resilienceImpactScore(4, 1);
    const manyErrors = resilienceImpactScore(4, 5);
    expect(manyErrors).toBeGreaterThan(fewErrors);
    // With zero text frustration, impact comes only from the error pressure —
    // capped, not inflated by an intensity term that folded the errors in.
    expect(resilienceImpactScore(0, 5)).toBeCloseTo(30);
  });

  it("harness routing scores distinct modes, so 1 mode ranks 0", () => {
    // The builder passes DISTINCT work modes, so a single mode (however many
    // aliased tool rows produced it) is not a routing opportunity.
    expect(harnessRoutingImpactScore(1)).toBeGreaterThan(0);
    expect(harnessRoutingImpactScore(5)).toBeGreaterThan(
      harnessRoutingImpactScore(2)
    );
  });
});

describe("dedupeGeneratedTipsByLever (FEA-3265, codex P1)", () => {
  it("keeps one tip per lever, preserving generator order", () => {
    const tips = [
      // speed_of_delivery and token_efficiency both pull the `reuse` lever.
      makeTip("gen-speed", "speed_of_delivery"),
      makeTip("gen-tokens", "token_efficiency"),
      makeTip("gen-cost", "cost"),
    ];

    const deduped = dedupeGeneratedTipsByLever(tips, 5);
    const ids = deduped.map((tip) => tip.id);

    // Only the FIRST reuse-lever tip survives; order is preserved.
    expect(ids).toEqual(["gen-speed", "gen-cost"]);
  });

  it("caps at the limit", () => {
    const tips = [
      makeTip("a", "context_management"),
      makeTip("b", "cost"),
      makeTip("c", "wall_time"),
    ];
    expect(dedupeGeneratedTipsByLever(tips, 2)).toHaveLength(2);
  });
});

// ISS-10696: the feedback tallies over what the local store actually holds —
// rows written by an older build can carry an action or a category this build
// no longer knows. The category tallies ignore both; the per-tip tally is
// category-blind and still counts the row under its tip.
describe("feedback tallies over persisted rows", () => {
  // Built from LOCAL components: `toDayKey` folds to the local calendar day,
  // and TODAY is a local day key, so a UTC instant would drift a day west.
  const TODAY_AT = new Date(2026, 5, 18, 9).toISOString();
  const YESTERDAY_AT = new Date(2026, 5, 17, 9).toISOString();
  const generatedAt = new Date(TODAY_AT);

  it("phrases a tip as a follow-up from ITS OWN prior engagement, not its category's", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      feedbackEvent("skill-a", "details_opened", YESTERDAY_AT),
      feedbackEvent("skill-b", "action_clicked", YESTERDAY_AT),
      feedbackEvent("skill-c", "dismissed", YESTERDAY_AT),
      // A tip engaged today: not yet a prior engagement.
      feedbackEvent("skill-d", "action_clicked", TODAY_AT),
    ];

    expect(tipFollowUp("skill-a", feedback, generatedAt).prefix).toBe(
      "You opened details on this coaching area before, so here's the next step: "
    );
    expect(tipFollowUp("skill-b", feedback, generatedAt).prefix).toBe(
      "Follow-up from yesterday's action: "
    );
    expect(tipFollowUp("skill-c", feedback, generatedAt).prefix).toBe(
      "Reframed after prior dismissal: "
    );
    expect(tipFollowUp("skill-d", feedback, generatedAt)).toEqual({
      prefix: "",
      why: "",
    });
  });

  it("tallies every prior action into its category bucket", () => {
    const insights = summarizeFeedback(
      [
        feedbackEvent("skill-a", "details_opened", YESTERDAY_AT),
        feedbackEvent("skill-a", "action_clicked", YESTERDAY_AT),
        feedbackEvent("skill-a", "action_clicked", YESTERDAY_AT),
        feedbackEvent("skill-b", "dismissed", YESTERDAY_AT),
        feedbackEvent("skill-b", "dismissed", TODAY_AT),
      ],
      TODAY
    );

    expect(insights.capability_gap).toEqual({
      acted: 2,
      dismissed: 1,
      opened: 1,
    });
    expect(insights.cost).toEqual({ acted: 0, dismissed: 0, opened: 0 });
  });

  it("ignores a persisted row whose action or category this build does not know", () => {
    const stale = [
      {
        ...feedbackEvent("skill-a", "dismissed", YESTERDAY_AT),
        action: "snoozed",
      },
      {
        ...feedbackEvent("skill-b", "dismissed", YESTERDAY_AT),
        category: "retired_category",
      },
    ] as unknown as AgentCoachingFeedbackEvent[];

    expect(feedbackAdjustment("capability_gap", stale, TODAY)).toBe(0);
    expect(tipFollowUp("skill-a", stale, generatedAt)).toEqual({
      prefix: "",
      why: "",
    });
    // The per-tip tally is category-blind: a dismissal under a category this
    // build no longer knows still reframes the tip it was recorded against.
    expect(tipFollowUp("skill-b", stale, generatedAt).prefix).toBe(
      "Reframed after prior dismissal: "
    );
    const insights = summarizeFeedback(stale, TODAY);
    expect(insights.capability_gap).toEqual({
      acted: 0,
      dismissed: 0,
      opened: 0,
    });
    expect(Object.hasOwn(insights, "retired_category")).toBe(false);
  });
});

describe("scorer inputs the corpus can hand over", () => {
  it("scores an empty delegation history as 0 rather than dividing by zero", () => {
    expect(testSequencingImpactScore(0, 0)).toBe(0);
  });

  // pins current behavior (ISS-10703); looks odd because a NaN operand is folded to a
  // confident zero-pressure score rather than refused as unmeasured.
  it("treats a NaN ratio as no pressure at all", () => {
    expect(wallTimeImpactScore(Number.NaN)).toBe(0);
    expect(costImpactScore(Number.NaN, Number.NaN)).toBe(0);
  });
});

function candidate(
  id: string,
  lever: AgentCoachingCandidate["lever"],
  category: AgentCoachingTipCategory,
  impactScore: number
): AgentCoachingCandidate {
  return { tip: makeTip(id, category), lever, impactScore };
}

function makeTip(
  id: string,
  category: AgentCoachingTipCategory
): AgentCoachingTip {
  return {
    id,
    title: id,
    category,
    body: "b",
    whyItMatters: "w",
    evidence: [],
    experiment: "e",
    detail: {
      whatThisMeans: "m",
      howToAct: [],
      whyThisRecommendation: "why",
      autoApply: "a",
    },
    actions: [],
  };
}

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

function feedbackEvent(
  tipId: string,
  action: AgentCoachingFeedbackEvent["action"],
  createdAt: string
): AgentCoachingFeedbackEvent {
  return { action, category: "capability_gap", createdAt, tipId };
}
