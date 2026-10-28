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
import type { AgentCoachingInput } from "../agent-coaching-types";

function makeAnalytics(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
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
    toolUsage: [{ count: 5, toolName: "Bash" }],
    totalAgents: 20,
    totalEvents: 1000,
    totalSessions: 10,
    ...overrides,
  } as AnalyticsData;
}

function makeWorkflow(
  overrides: Partial<WorkflowQueryData> = {}
): WorkflowQueryData {
  return {
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
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
      ],
    },
    stats: {
      avgCompactions: 0,
      avgDepth: 1,
      avgDurationSec: 100,
      avgSubagents: 1,
      successRate: 0.9,
      totalAgents: 20,
      totalCompactions: 0,
      totalSessions: 10,
      totalSubagents: 12,
    },
    ...overrides,
  } as WorkflowQueryData;
}

function makeEvent(
  overrides: Partial<EventWithSession> = {}
): EventWithSession {
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: "event-0",
    sessionId: "session-1",
    sessionName: "Session",
    summary: "read a file",
    toolName: "Bash",
    ...overrides,
  } as EventWithSession;
}

function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: new Date("2026-06-18T12:00:00.000Z"),
    recentEvents: [makeEvent()],
    skills: [],
    workflow: makeWorkflow(),
    ...overrides,
  };
}

describe("buildTokenEfficiencyCandidate shell-tool fallback (no repeated-command candidate)", () => {
  it("falls back to the topShellTool's name and count when no reusable-command candidate exists", () => {
    // Three DISTINCT shell commands (never the same family 3x) so
    // findReusableCommandCandidate returns null, while analytics.toolUsage still
    // carries a Bash entry so reuseLeverWarranted is true via hasShellTool.
    const recentEvents: EventWithSession[] = [
      makeEvent({ id: "event-0", summary: "ls -la", toolName: "Bash" }),
      makeEvent({ id: "event-1", summary: "pwd", toolName: "Bash" }),
    ];
    const tips = buildAgentCoachingTips(
      makeInput({
        analytics: makeAnalytics({
          toolUsage: [{ count: 9, toolName: "Bash" }],
        }),
        recentEvents,
      })
    );

    const tokenTip = tips.find(
      (tip) => tip.id === "shell-probe-reusable-skill"
    );

    expect(tokenTip).toBeDefined();
    expect(tokenTip?.body).toContain("Move Bash to a reusable skill");
    expect(tokenTip?.detail.candidateFromThisDryRun?.observedCalls).toBe(9);
  });

  // buildTokenEfficiencyCandidate's final fallbacks — `?? "shell probes"` and
  // `?? 0` on lines 618-619 — require BOTH commandCandidate and topShellTool to
  // be null/undefined. But reuseLeverWarranted is called here with
  // `skillCount: 0` HARD-CODED (skill usage is the workflow builder's signal,
  // not this one's), so with both candidate and shell tool absent, every one of
  // its three OR arms is false and the function returns null before reaching
  // line 618-619 at all. That final "both absent" fallback is therefore
  // unreachable through this gate; left unexercised — see the report.
});

describe("classifyCommand family classification via findReusableCommandCandidate", () => {
  function tokenTipFor(commands: string[]) {
    const recentEvents: EventWithSession[] = commands.map((summary, index) =>
      makeEvent({ id: `event-${index}`, summary, toolName: "Bash" })
    );
    const tips = buildAgentCoachingTips(
      makeInput({
        analytics: makeAnalytics({
          toolUsage: [{ count: 9, toolName: "Bash" }],
        }),
        recentEvents,
      })
    );
    return tips.find((tip) => tip.id === "shell-probe-reusable-skill");
  }

  it("classifies a repeated pnpm invocation as 'pnpm <subcommand>'", () => {
    const tip = tokenTipFor(["pnpm test", "pnpm test", "pnpm test"]);
    expect(tip?.body).toContain("Move pnpm test to a reusable skill");
  });

  it("classifies a repeated node invocation as 'node script'", () => {
    const tip = tokenTipFor([
      "node script.js",
      "node script.js",
      "node script.js",
    ]);
    expect(tip?.body).toContain("Move node script to a reusable skill");
  });

  it("classifies a repeated rtk-prefixed git invocation via the rtk-offset branch", () => {
    // `rtk git status` — the leading "rtk" token shifts `offset` to 1, so
    // `first`/`second` are read from `tokens[1]`/`tokens[2]` (git/status),
    // covering the tokens[offset] branch of the `??` fallback.
    const tip = tokenTipFor([
      "rtk git commit -m wip",
      "rtk git commit -m wip",
      "rtk git commit -m wip",
    ]);
    expect(tip?.body).toContain("Move git commit to a reusable skill");
  });

  it("classifies an unrecognized single-token command as the bare token", () => {
    const tip = tokenTipFor(["whoami", "whoami", "whoami"]);
    expect(tip?.body).toContain("Move whoami to a reusable skill");
  });

  // classifyCommand's `return first || "shell"` right-hand branch (an empty
  // `first`) is NOT reachable through findReusableCommandCandidate: a
  // whitespace-only or empty summary is filtered out earlier by
  // extractShellCommand's `!trimmed` guard, so classifyCommand is never called
  // with a string whose first whitespace-split token is empty. Left
  // unreachable-and-unexercised here; see the report's unreachable-branches note.
});

describe("extractShellCommand JSON-data parsing branches (parseCommandFromEventData)", () => {
  // parseCommandFromEventData's `typeof parsed !== "object" || parsed === null`
  // guard (L845) is dead: it only runs after `trimmed.startsWith("{")`, and any
  // string starting with "{" that JSON.parse succeeds on always yields a plain
  // object (never a primitive or null) — a malformed "{"-prefixed string throws
  // and is already caught above. Left unreachable-and-unexercised; see the
  // report's unreachable-branches note.

  it("extracts the command from a bare {command} JSON object", () => {
    const event = makeEvent({
      data: '{"command":"git status"}',
      summary: null,
    });
    expect(extractShellCommand(event)).toBe("git status");
  });
});
