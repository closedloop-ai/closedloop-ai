import { describe, expect, it } from "vitest";
import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../../shared/agent-db-contract";
import { buildAgentCoachingTips } from "../agent-coaching-model";
import type {
  AgentCoachingFeedbackEvent,
  AgentCoachingInput,
} from "../agent-coaching-types";

const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");

describe("buildAgentCoachingTips", () => {
  it("creates a reusable-skill recommendation from repeated local shell probes", () => {
    const tips = buildAgentCoachingTips(makeInput());

    const tokenTip = tips.find(
      (tip) => tip.id === "shell-probe-reusable-skill"
    );

    expect(tokenTip?.body).toContain(
      "Move nightly-review-worktree-preflight to a reusable skill"
    );
    expect(
      tokenTip?.detail.candidateFromThisDryRun?.estimatedTokenSavingsPercent
    ).toBeGreaterThan(0);
    expect(tokenTip?.detail.whyThisRecommendation).toContain(
      "nightly-review-worktree-preflight appeared"
    );
  });

  it("uses prior detail feedback to generate a follow-up recommendation", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "details_opened",
        category: "token_efficiency",
        createdAt: "2026-06-17T12:00:00.000Z",
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(makeInput({ feedback }));
    const tokenTip = tips.find(
      (tip) => tip.id === "shell-probe-reusable-skill"
    );

    expect(tokenTip?.body).toContain(
      "You opened details on this coaching area before"
    );
    expect(tokenTip?.detail.whyThisRecommendation).toContain(
      "Prior detail engagement is treated as interest"
    );
  });

  it("permanently excludes a dismissed tip on later days", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "dismissed",
        category: "token_efficiency",
        createdAt: "2026-06-16T12:00:00.000Z",
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(makeInput({ feedback }));

    // A dismissal two days earlier still excludes the tip today — it is gone for
    // good, making room for genuinely different tips rather than returning.
    expect(tips.some((tip) => tip.id === "shell-probe-reusable-skill")).toBe(
      false
    );
  });

  it("excludes a tip dismissed earlier the same day", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "dismissed",
        category: "token_efficiency",
        createdAt: "2026-06-18T09:00:00.000Z",
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(makeInput({ feedback }));

    expect(tips.some((tip) => tip.id === "shell-probe-reusable-skill")).toBe(
      false
    );
  });

  it("clears a tip acted on earlier the same day", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "action_clicked",
        actionId: "draft-command-wrapper",
        category: "token_efficiency",
        createdAt: "2026-06-18T09:00:00.000Z",
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(makeInput({ feedback }));

    expect(tips.some((tip) => tip.id === "shell-probe-reusable-skill")).toBe(
      false
    );
  });
});

function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: makeEvents(),
    skills: [
      {
        invocationCount: 4,
      },
    ],
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
    tokens: {
      byDay: [],
      byModel: [],
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalInputTokens: 120_000,
      totalOutputTokens: 30_000,
    },
    toolUsage: [
      { count: 80, toolName: "Bash" },
      { count: 25, toolName: "Read" },
      { count: 20, toolName: "Agent" },
    ],
    totalAgents: 20,
    totalEvents: 1000,
    totalSessions: 10,
  };
}

function makeWorkflow(): WorkflowQueryData {
  return {
    cooccurrence: [],
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
      edges: [],
      mainCount: 10,
      outcomes: [],
      sessionCount: 10,
      subagentTypes: [
        {
          completed: 8,
          count: 10,
          errors: 0,
          subagentType: "general-purpose",
        },
        {
          completed: 2,
          count: 2,
          errors: 0,
          subagentType: "test-engineer",
        },
      ],
    },
    stats: {
      avgCompactions: 0,
      avgDepth: 1,
      avgDurationSec: 100,
      avgSubagents: 1,
      successRate: 0.9,
      topFlow: null,
      totalAgents: 20,
      totalCompactions: 0,
      totalSessions: 10,
      totalSubagents: 12,
    },
    toolFlow: {
      toolCounts: [],
      transitions: [],
    },
  };
}

function makeEvents(): EventWithSession[] {
  return Array.from({ length: 5 }, (_, index) => ({
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: `event-${index}`,
    sessionId: "session-1",
    sessionName: "Nightly review",
    summary:
      "git fetch origin && mkdir -p /tmp/nrev && git worktree add /tmp/nrev/tina bot/nightly-testing-tina-2026-06-17 && gh pr view 1656 --json files",
    toolName: "Bash",
  }));
}
