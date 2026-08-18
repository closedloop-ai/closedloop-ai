import { describe, expect, it } from "vitest";
import { buildCapabilityGapCandidates } from "../agent-coaching-capability-gap";
import {
  type AgentCoachingCandidate,
  rankCandidatePool,
} from "../agent-coaching-scoring";
import type {
  AgentCoachingFeedbackEvent,
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
} from "../agent-coaching-types";
import { makeGroundedMetrics } from "./grounded-metrics-factory";

const INPUT: AgentCoachingInput = {
  analytics: null,
  feedback: [],
  generatedAt: new Date("2026-07-24T12:00:00.000Z"),
  recentEvents: [],
  skills: [],
  workflow: null,
};

function makeMetrics(
  overrides: Partial<AgentCoachingGroundedMetrics>
): AgentCoachingGroundedMetrics {
  return makeGroundedMetrics({
    sessionsAnalyzed: 20,
    eventsAnalyzed: 200,
    // Default: capabilities are fully adopted so no gap surfaces unless a test
    // deliberately introduces one.
    unwrappedShellCommandRatio: 0,
    shellCommandsSampled: 50,
    totalSkillInvocations: 50,
    planModeRatio: 1,
    ...overrides,
  });
}

function winner(
  candidates: AgentCoachingCandidate[]
): AgentCoachingCandidate | undefined {
  return [...candidates].sort((a, b) => b.impactScore - a.impactScore)[0];
}

describe("buildCapabilityGapCandidates (FEA-4153)", () => {
  it("surfaces a gap when a high-impact capability (plan mode) is missing", () => {
    // planModeRatio: 0 = the harness surfaces plan markers but this user never
    // used them — the exact zero-adoption case this gap targets (a NULL ratio,
    // i.e. undetectable, is a separate case covered below).
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({ planModeRatio: 0, sessionsAnalyzed: 40 })
    );

    const best = winner(candidates);
    expect(best).toBeDefined();
    expect(best?.lever).toBe("capability_gap");
    expect(best?.tip.id).toBe("capability-gap-plan-mode");
    // Grounded in the real usage figure, not a static claim.
    expect(best?.tip.evidence).toContain(
      "Plan mode showed up in 0% of your sessions."
    );
    // A full shortfall on a large corpus ranks meaningfully high.
    expect((best as AgentCoachingCandidate).impactScore).toBeGreaterThan(70);
  });

  it("does NOT surface a gap for a capability the user already uses", () => {
    // Plan mode already well-adopted; rtk routed; skills in use → no gap at all.
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 0.6,
        unwrappedShellCommandRatio: 0.1,
        totalSkillInvocations: 30,
        repeatedCommandFamilies: [
          { family: "git status", count: 5, avgCommandChars: 12 },
        ],
      })
    );

    expect(candidates).toEqual([]);
  });

  it("does not flag a capability whose adoption signal is unavailable", () => {
    // planModeRatio null = undetectable in this harness; rtk null; no repetition.
    // A null signal must never be read as "missing capability".
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: null,
        unwrappedShellCommandRatio: null,
        repeatedCommandFamilies: [],
      })
    );

    expect(candidates).toEqual([]);
  });

  it("does not flag a skills gap when the skills read was unavailable", () => {
    // totalSkillInvocations null = the read failed (see skillsUnavailable). A
    // failed read must never read as "you have no skills".
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 1,
        unwrappedShellCommandRatio: 0,
        totalSkillInvocations: null,
        repeatedCommandFamilies: [
          { family: "git status", count: 5, avgCommandChars: 12 },
          { family: "pnpm test", count: 4, avgCommandChars: 18 },
        ],
      })
    );

    expect(candidates.map((c) => c.tip.id)).not.toContain(
      "capability-gap-skills"
    );
  });

  it("flags a skills gap when there is repetition and genuinely zero skills", () => {
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 1,
        unwrappedShellCommandRatio: 0,
        totalSkillInvocations: 0,
        repeatedCommandFamilies: [
          { family: "git status", count: 5, avgCommandChars: 12 },
          { family: "pnpm test", count: 4, avgCommandChars: 18 },
        ],
      })
    );

    expect(candidates.map((c) => c.tip.id)).toContain("capability-gap-skills");
  });

  it("defers the skills gap to the reuse tip when that tip is already active", () => {
    // Same "make a skill" advice as the token-efficiency reuse tip — when that
    // tip is active, the skills gap must not surface a second, redundant tip.
    const metrics = makeMetrics({
      planModeRatio: 1,
      unwrappedShellCommandRatio: 0,
      totalSkillInvocations: 0,
      repeatedCommandFamilies: [
        { family: "git status", count: 5, avgCommandChars: 12 },
        { family: "pnpm test", count: 4, avgCommandChars: 18 },
      ],
    });

    expect(
      buildCapabilityGapCandidates(INPUT, metrics, {
        reuseTipActive: true,
      }).map((c) => c.tip.id)
    ).not.toContain("capability-gap-skills");
    // With no reuse tip active it still surfaces.
    expect(
      buildCapabilityGapCandidates(INPUT, metrics, {
        reuseTipActive: false,
      }).map((c) => c.tip.id)
    ).toContain("capability-gap-skills");
  });

  it("does not flag an rtk gap from too few sampled shell commands", () => {
    // A single unwrapped shell command on an otherwise-quiet corpus (even a
    // huge lifetime event count) is not a confident gap: the gate reads the
    // SAMPLED shell-command denominator, not the unrelated lifetime event total.
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 1,
        totalSkillInvocations: 50,
        eventsAnalyzed: 5000,
        unwrappedShellCommandRatio: 1,
        shellCommandsSampled: 1,
      })
    );

    expect(candidates.map((c) => c.tip.id)).not.toContain(
      "capability-gap-rtk-routing"
    );
  });

  it("flags an rtk gap once enough shell commands were sampled", () => {
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 1,
        totalSkillInvocations: 50,
        unwrappedShellCommandRatio: 0.8,
        shellCommandsSampled: 30,
      })
    );

    expect(candidates.map((c) => c.tip.id)).toContain(
      "capability-gap-rtk-routing"
    );
  });

  it("returns every detected gap so a dismissed winner does not suppress the dimension", () => {
    // Both plan mode (full shortfall) and rtk (partial) are gaps; both are
    // returned as candidates so the downstream dismiss filter runs before the
    // one-per-lever contest.
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 0,
        sessionsAnalyzed: 40,
        unwrappedShellCommandRatio: 0.8,
        shellCommandsSampled: 40,
      })
    );

    const ids = candidates.map((c) => c.tip.id);
    expect(ids).toContain("capability-gap-plan-mode");
    expect(ids).toContain("capability-gap-rtk-routing");
    // The strongest gap wins the impact ranking.
    expect(winner(candidates)?.tip.id).toBe("capability-gap-plan-mode");
  });

  it("competes in rankCandidatePool with no forced slot", () => {
    // A stronger non-gap lever outranks a weaker capability-gap candidate: the
    // gap does not get a guaranteed slot.
    const gaps = buildCapabilityGapCandidates(
      INPUT,
      // A modest gap: rtk just over the ceiling on a small sample → low score.
      makeMetrics({
        planModeRatio: 1,
        totalSkillInvocations: 10,
        unwrappedShellCommandRatio: 0.35,
        shellCommandsSampled: 6,
      })
    );
    expect(gaps.length).toBeGreaterThan(0);

    const stronger: AgentCoachingCandidate = {
      tip: {
        id: "strong-cost",
        title: "Strong cost lever",
        category: "cost",
        body: "",
        whyItMatters: "",
        evidence: [],
        experiment: "",
        detail: {
          whatThisMeans: "",
          howToAct: [],
          whyThisRecommendation: "",
          autoApply: "",
        },
        actions: [],
      },
      lever: "cost",
      impactScore: 95,
    };

    // limit 1: only the strongest lever survives, and it is NOT the gap.
    const surfaced = rankCandidatePool([stronger, ...gaps], 1);
    expect(surfaced.map((tip) => tip.id)).toEqual(["strong-cost"]);
  });

  it("keeps at most one capability_gap lever in the surfaced deck", () => {
    // Two detected gaps share the capability_gap lever; the diversity guarantee
    // keeps only the higher-impact one even with room in the deck.
    const candidates = buildCapabilityGapCandidates(
      INPUT,
      makeMetrics({
        planModeRatio: 0,
        sessionsAnalyzed: 40,
        unwrappedShellCommandRatio: 0.8,
        shellCommandsSampled: 40,
      })
    );
    expect(candidates.length).toBeGreaterThanOrEqual(2);

    const surfaced = rankCandidatePool(candidates, 5);
    expect(surfaced.length).toBe(1);
    expect(surfaced[0]?.id).toBe("capability-gap-plan-mode");
  });

  it("phrases follow-up per gap id, not across the shared category", () => {
    // Acting on the plan-mode gap yesterday must NOT make the rtk gap read as a
    // follow-up — follow-up prose is keyed on the tip id, not the shared
    // capability_gap category.
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        tipId: "capability-gap-plan-mode",
        category: "capability_gap",
        action: "action_clicked",
        createdAt: "2026-07-23T09:00:00.000Z",
      },
    ];
    const candidates = buildCapabilityGapCandidates(
      { ...INPUT, feedback },
      makeMetrics({
        planModeRatio: 0,
        sessionsAnalyzed: 40,
        unwrappedShellCommandRatio: 0.8,
        shellCommandsSampled: 40,
      })
    );

    const rtk = candidates.find(
      (c) => c.tip.id === "capability-gap-rtk-routing"
    );
    expect(rtk).toBeDefined();
    // The rtk tip carries no follow-up prefix (the plan-mode action was not its).
    expect(rtk?.tip.body).not.toContain("Follow-up from yesterday's action");
  });
});
