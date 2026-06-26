import { describe, expect, it } from "vitest";
import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../../shared/agent-db-contract";
import { parseGeneratedTips } from "../agent-coaching-generate-parse";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "../agent-coaching-llm";
import { summarizeLookback } from "../agent-coaching-lookback";
import type { AgentCoachingInput } from "../agent-coaching-types";

const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");

describe("summarizeLookback", () => {
  it("windows token totals from per-day history and derives grounded metrics", () => {
    const metrics = summarizeLookback(makeInput(), 30);

    expect(metrics.totalInputTokens).toBe(300);
    expect(metrics.totalOutputTokens).toBe(150);
    expect(metrics.totalTokens).toBe(450);
    expect(metrics.estimatedCostUsd).toBeCloseTo(4.5);
    expect(metrics.avgSessionDurationSec).toBe(120);
    expect(metrics.totalSkillInvocations).toBe(4);
  });

  it("measures the share of shell commands not routed through rtk", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          shellEvent("git status"),
          shellEvent("git status"),
          shellEvent("rtk git status"),
          shellEvent("rtk pnpm build"),
        ],
      })
    );

    // 2 of 4 shell commands are unwrapped.
    expect(metrics.unwrappedShellCommandRatio).toBeCloseTo(0.5);
  });

  it("surfaces repeated command families above the threshold", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          shellEvent("gh pr view 1"),
          shellEvent("gh pr view 2"),
          shellEvent("gh pr view 3"),
          shellEvent("ls"),
        ],
      })
    );

    const family = metrics.repeatedCommandFamilies.find(
      (entry) => entry.family === "gh pr"
    );
    expect(family?.count).toBe(3);
    expect(metrics.repeatedCommandFamilies.some((e) => e.family === "ls")).toBe(
      false
    );
  });
});

describe("renderAgentCoachingPrompt", () => {
  it("demands quantified claims and embeds the grounded metrics + exclusions", () => {
    const input = makeInput({
      feedback: [
        {
          action: "dismissed",
          category: "token_efficiency",
          createdAt: "2026-06-10T00:00:00.000Z",
          tipId: "old-tip",
        },
      ],
    });
    const request = buildAgentCoachingLlmRequest(input, []);
    const prompt = renderAgentCoachingPrompt(request);

    expect(prompt).toContain("QUANTIFIED");
    expect(prompt).toContain("rtk");
    expect(prompt).toContain("token_efficiency");
    expect(prompt).toContain("old-tip");
    expect(request.excludeTipIds).toEqual(["old-tip"]);
  });
});

describe("parseGeneratedTips", () => {
  it("extracts and validates tips from a fenced JSON response", () => {
    const raw = [
      "Here are your tips:",
      "```json",
      JSON.stringify([validTip(), { id: "bad" }]),
      "```",
    ].join("\n");

    const tips = parseGeneratedTips(raw);

    // The malformed second entry is dropped; the valid one survives.
    expect(tips).toHaveLength(1);
    expect(tips[0]?.id).toBe("llm-token-tip");
  });

  it("returns an empty array when there is no JSON array", () => {
    expect(parseGeneratedTips("sorry, no tips today")).toEqual([]);
  });
});

function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: [],
    skills: [{ invocationCount: 4 }],
    workflow: makeWorkflow(),
    ...overrides,
  };
}

function makeAnalytics(): AnalyticsData {
  return {
    agentsByStatus: [],
    agentsByType: [],
    dailyEvents: [],
    eventsByType: [],
    sessionsByStatus: [],
    toolUsage: [],
    tokens: {
      byDay: [
        { day: "2026-06-16", inputTokens: 100, outputTokens: 50 },
        { day: "2026-06-17", inputTokens: 200, outputTokens: 100 },
      ],
      byModel: [
        {
          estimatedCostUsd: 4.5,
          inputTokens: 300,
          model: "claude-sonnet-4-5",
          outputTokens: 150,
          sessions: 2,
        },
      ],
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalInputTokens: 300,
      totalOutputTokens: 150,
    },
    totalAgents: 4,
    totalEvents: 40,
    totalSessions: 2,
  };
}

function makeWorkflow(): WorkflowQueryData {
  return {
    cooccurrence: [],
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
      edges: [],
      mainCount: 2,
      outcomes: [],
      sessionCount: 2,
      subagentTypes: [],
    },
    stats: {
      avgCompactions: 0,
      avgDepth: 1,
      avgDurationSec: 120,
      avgSubagents: 1,
      successRate: 0.9,
      topFlow: null,
      totalAgents: 4,
      totalCompactions: 0,
      totalSessions: 2,
      totalSubagents: 2,
    },
    toolFlow: { toolCounts: [], transitions: [] },
  };
}

function shellEvent(summary: string): EventWithSession {
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: `event-${summary}`,
    sessionId: "session-1",
    sessionName: "Session",
    summary,
    toolName: "Bash",
  };
}

function validTip() {
  return {
    actions: [
      {
        id: "draft-skill",
        label: "Draft skill",
        mode: "draft",
        result: "Drafts a skill.",
        safety: "safe",
      },
    ],
    body: "Enabling RTK would save ~35% of token spend over the last 30 days.",
    category: "token_efficiency",
    detail: {
      autoApply: "Draft only until confirmed.",
      howToAct: ["Enable rtk"],
      whatThisMeans: "Wrap shell calls with rtk.",
      whyThisRecommendation: "Most shell calls are unwrapped.",
    },
    evidence: ["70% of shell commands are not routed through rtk"],
    experiment: "Enable rtk for a day and compare token spend.",
    id: "llm-token-tip",
    title: "Route shell commands through RTK",
    whyItMatters: "Cuts token spend.",
  };
}
