import { describe, expect, it } from "vitest";
import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../../shared/agent-db-contract";
import {
  buildAgentCoachingTips,
  extractShellCommand,
} from "../agent-coaching-model";
import type {
  AgentCoachingFeedbackEvent,
  AgentCoachingInput,
} from "../agent-coaching-types";

const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");
const GARBLED_SESSION_ID_SLUG_PATTERN = /session-id-[0-9a-f-]{8,}/;
const GIANT_SLUG_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+){8,}/;

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

  it("emits a resilience tip from a peak frustration moment (FEA-3399)", () => {
    const recentEvents: EventWithSession[] = [
      frustrationUserEvent(
        "STOP this is WRONG again, revert it please seriously!!"
      ),
      frustrationErrorEvent(),
    ];

    const tips = buildAgentCoachingTips(makeInput({ recentEvents }));
    const resilienceTip = tips.find(
      (tip) => tip.id === "resilience-frustration-reset"
    );

    expect(resilienceTip?.category).toBe("resilience");
    expect(resilienceTip?.detail.whyThisRecommendation).toContain(
      "frustration peak"
    );
    expect(
      resilienceTip?.evidence.some((line) => line.includes("intensity score"))
    ).toBe(true);
  });

  it("omits the resilience tip when there is no confident peak (FEA-3399)", () => {
    const recentEvents: EventWithSession[] = [
      frustrationUserEvent("please add a test for the parser"),
    ];

    const tips = buildAgentCoachingTips(makeInput({ recentEvents }));

    expect(tips.some((tip) => tip.id === "resilience-frustration-reset")).toBe(
      false
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

  // FEA-2430: "today" is the LOCAL calendar day. Fixtures below are built from
  // LOCAL date components so the assertions hold under any host timezone —
  // vitest workers share a process, so a module-level TZ pin is not safe here
  // (the main-process node:test suites carry the pinned-TZ coverage).
  it("clears a tip acted on late the same LOCAL evening (FEA-2430)", () => {
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "action_clicked",
        actionId: "draft-command-wrapper",
        category: "token_efficiency",
        createdAt: new Date(2026, 5, 18, 23, 15).toISOString(),
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(
      makeInput({ feedback, generatedAt: new Date(2026, 5, 18, 23, 45) })
    );

    expect(tips.some((tip) => tip.id === "shell-probe-reusable-skill")).toBe(
      false
    );
  });

  it("treats details opened the previous LOCAL evening as prior-day interest (FEA-2430)", () => {
    // 23:30 local vs 00:30 local straddle LOCAL midnight (different local
    // days) but on a negative-UTC-offset host they share a UTC day — under the
    // old UTC day key this feedback was skipped as "today" and produced no
    // follow-up.
    const feedback: AgentCoachingFeedbackEvent[] = [
      {
        action: "details_opened",
        category: "token_efficiency",
        createdAt: new Date(2026, 5, 17, 23, 30).toISOString(),
        tipId: "shell-probe-reusable-skill",
      },
    ];

    const tips = buildAgentCoachingTips(
      makeInput({ feedback, generatedAt: new Date(2026, 5, 18, 0, 30) })
    );
    const tokenTip = tips.find(
      (tip) => tip.id === "shell-probe-reusable-skill"
    );

    expect(tokenTip?.body).toContain(
      "You opened details on this coaching area before"
    );
  });
});

// FEA-3687 #1: the garbled-recommendation regression. A shell event whose
// `data` is the WHOLE serialized tool JSON must yield the real command (never
// the raw blob), and the tip prose / skill name must be clean.
describe("extractShellCommand (FEA-3687)", () => {
  const baseEvent = {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    eventType: "tool_use",
    id: "e1",
    sessionId: "session-1",
    sessionName: "s",
    summary: null,
    toolName: "Bash",
  };

  it("pulls tool_input.command out of a raw serialized event blob", () => {
    const event = {
      ...baseEvent,
      data: JSON.stringify({
        session_id: "65950db3-bb90-4438-babe-c66ba9c378f2",
        tool_input: { command: "cd apps/desktop && pnpm test" },
      }),
    };
    expect(extractShellCommand(event)).toBe("cd apps/desktop && pnpm test");
  });

  it("handles a bare {command} data object", () => {
    const event = {
      ...baseEvent,
      data: JSON.stringify({ command: "git status" }),
    };
    expect(extractShellCommand(event)).toBe("git status");
  });

  it("returns null (never the blob) when a JSON data object has no command", () => {
    const event = {
      ...baseEvent,
      data: JSON.stringify({ session_id: "abc", tool_name: "Bash" }),
    };
    expect(extractShellCommand(event)).toBeNull();
  });

  it("uses a plain summary string when present", () => {
    const event = { ...baseEvent, summary: "rg foo src/", data: null };
    expect(extractShellCommand(event)).toBe("rg foo src/");
  });

  it("returns null for an unparseable blobby data field", () => {
    const event = { ...baseEvent, data: '{"session_id":"broken' };
    expect(extractShellCommand(event)).toBeNull();
  });
});

// FEA-3687 #1 end-to-end: a repeated-command corpus whose events carry raw
// serialized tool JSON must produce a CLEAN token-efficiency tip — no
// `{"session_id":…}` blob or giant `session-id-…-command-…-skill` slug leaking
// into the title, body, why, or skill name.
describe("buildAgentCoachingTips with raw-JSON event.data (FEA-3687)", () => {
  it("does not leak raw event JSON or a garbled slug into the tip", () => {
    const recentEvents: EventWithSession[] = Array.from(
      { length: 6 },
      (_, index) => ({
        agentId: null,
        createdAt: "2026-06-17T00:00:00.000Z",
        data: JSON.stringify({
          session_id: "65950db3-bb90-4438-babe-c66ba9c378f2",
          tool_input: {
            command: `pnpm turbo test --filter=desktop --run ${1600 + index}`,
          },
        }),
        eventType: "tool_use",
        id: `blob-${index}`,
        sessionId: "session-1",
        sessionName: "PR review",
        summary: null,
        toolName: "Bash",
      })
    );

    const tips = buildAgentCoachingTips(makeInput({ recentEvents }));
    const tokenTip = tips.find(
      (tip) => tip.id === "shell-probe-reusable-skill"
    );
    expect(tokenTip).toBeDefined();

    const prose = [
      tokenTip?.title ?? "",
      tokenTip?.body ?? "",
      tokenTip?.detail.whyThisRecommendation ?? "",
      ...(tokenTip?.evidence ?? []),
      tokenTip?.detail.candidateFromThisDryRun?.suggestedWrapper ?? "",
      ...(tokenTip?.actions.map((action) => action.result) ?? []),
    ].join("\n");

    // No raw serialized event JSON.
    expect(prose).not.toContain("session_id");
    expect(prose).not.toContain('"tool_input"');
    // No giant slugified identifier mashed from the blob.
    expect(prose).not.toMatch(GARBLED_SESSION_ID_SLUG_PATTERN);
    expect(prose).not.toMatch(GIANT_SLUG_PATTERN);
    // The skill name / family is derived from the real command (pnpm turbo),
    // proving the command was extracted from tool_input.command not the blob.
    expect(prose).toContain("pnpm turbo");
  });
});

// FEA-3265: the candidate-pool behavior — end to end through
// buildAgentCoachingTips (not just the pure ranker).
describe("buildAgentCoachingTips candidate pool (FEA-3265)", () => {
  it("surfaces a diverse pool — no two tips share a category/lever", () => {
    const tips = buildAgentCoachingTips(makeInput());

    const categories = tips.map((tip) => tip.category);
    expect(categories.length).toBeGreaterThan(1);
    // Diversity guarantee: every surfaced tip is a different lever.
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("does not force a skill-creation tip when a non-skill lever is stronger", () => {
    // Heavy token spend + long sessions, but NO repeated shell commands and no
    // skills — so the reuse/skill lever cannot even be built, and the cost and
    // wall-time levers dominate. This is the "no forced skill quota" case.
    const analytics = makeAnalytics();
    analytics.tokens.totalInputTokens = 1_500_000;
    analytics.tokens.totalOutputTokens = 400_000;
    analytics.tokens.byDay = [
      {
        day: "2026-06-17",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 180,
      },
    ];
    analytics.tokens.byModel = [
      {
        model: "opus",
        inputTokens: 1_400_000,
        outputTokens: 380_000,
        sessions: 8,
      },
      {
        model: "haiku",
        inputTokens: 100_000,
        outputTokens: 20_000,
        sessions: 2,
      },
    ];
    // No shell tools → no repeated-command / skill-reuse candidate.
    analytics.toolUsage = [
      { count: 40, toolName: "Read" },
      { count: 20, toolName: "Agent" },
    ];

    const workflow = makeWorkflow();
    workflow.stats.avgDurationSec = 1800; // 30 min sessions

    const tips = buildAgentCoachingTips(
      makeInput({
        analytics,
        workflow,
        recentEvents: [],
        skills: [],
      })
    );

    const ids = tips.map((tip) => tip.id);
    // The skill-creation tip is NOT present (no evidence for it).
    expect(ids).not.toContain("shell-probe-reusable-skill");
    expect(ids).not.toContain("promote-review-workflow");
    // The cost lever surfaced instead.
    expect(ids).toContain("rebalance-model-spend");
  });

  it("ranks the strongest non-skill lever first (most impactful, deck order)", () => {
    // Cost is enormous; the only competing lever is the context tip. The
    // presentation order is most → least impactful, so the cost tip is first.
    const analytics = makeAnalytics();
    analytics.tokens.totalInputTokens = 1_900_000;
    analytics.tokens.totalOutputTokens = 500_000;
    analytics.tokens.byDay = [
      {
        day: "2026-06-17",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 190,
      },
    ];
    analytics.tokens.byModel = [
      {
        model: "opus",
        inputTokens: 1_900_000,
        outputTokens: 500_000,
        sessions: 9,
      },
    ];
    analytics.toolUsage = [{ count: 10, toolName: "Read" }];

    const tips = buildAgentCoachingTips(
      makeInput({ analytics, recentEvents: [], skills: [] })
    );

    expect(tips.length).toBeGreaterThan(0);
    // Most impactful (cost) is presented first (Tip 1 of N).
    expect(tips[0]?.id).toBe("rebalance-model-spend");
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
      windowDays: 30,
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

let frustrationSeq = 0;

function frustrationUserEvent(summary: string): EventWithSession {
  frustrationSeq += 1;
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "UserMessage",
    id: `user-${frustrationSeq}`,
    sessionId: "session-1",
    sessionName: "Crash-out session",
    summary,
    toolName: null,
  };
}

function frustrationErrorEvent(): EventWithSession {
  frustrationSeq += 1;
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "error",
    id: `error-${frustrationSeq}`,
    sessionId: "session-1",
    sessionName: "Crash-out session",
    summary: "command failed",
    toolName: null,
  };
}
