import { describe, expect, it } from "vitest";
import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../../shared/agent-db-contract";
import {
  buildAgentCoachingTips,
  filterGeneratedTipsByAdoptionSignal,
} from "../agent-coaching-model";
import { leverForCategory } from "../agent-coaching-scoring";
import type {
  AgentCoachingInput,
  AgentCoachingTip,
  AgentCoachingTipCategory,
} from "../agent-coaching-types";

const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");

describe("FEA-4179 generated-tip adoption gate", () => {
  it("drops a generated tip whose lever the user's metrics do not warrant", () => {
    // A zero-activity user: no sessions/events/tokens, no skills, no delegations.
    // The wall_time lever (long average session) is NOT warranted.
    const input = makeInput({
      analytics: null,
      recentEvents: [],
      skills: [],
      workflow: null,
    });

    const generated: AgentCoachingTip[] = [
      makeTip("wall-time-tip", "wall_time"),
    ];
    const kept = filterGeneratedTipsByAdoptionSignal(generated, input);

    expect(kept).toHaveLength(0);
  });

  it("keeps a generated tip whose lever the user's metrics DO warrant", () => {
    // Long average session wall time warrants the wall_time lever.
    const input = makeInput({
      workflow: makeWorkflow({ avgDurationSec: 1800 }),
    });

    const generated: AgentCoachingTip[] = [
      makeTip("wall-time-tip", "wall_time"),
    ];
    const kept = filterGeneratedTipsByAdoptionSignal(generated, input);

    expect(kept.map((tip) => tip.id)).toEqual(["wall-time-tip"]);
  });

  it("gates multiple levers independently in one batch", () => {
    // cost warranted (>50k tokens), wall_time NOT warranted (short sessions),
    // resilience NOT warranted (no frustration peak).
    const input = makeInput({
      analytics: makeAnalytics({ inputTokens: 80_000, outputTokens: 20_000 }),
      recentEvents: [],
      workflow: makeWorkflow({ avgDurationSec: 60 }),
    });

    const generated: AgentCoachingTip[] = [
      makeTip("cost-tip", "cost"),
      makeTip("wall-time-tip", "wall_time"),
      makeTip("resilience-tip", "resilience"),
    ];
    const kept = filterGeneratedTipsByAdoptionSignal(generated, input).map(
      (tip) => tip.id
    );

    expect(kept).toEqual(["cost-tip"]);
  });

  it("does not drop a warranted resilience tip when a frustration peak exists", () => {
    const input = makeInput({
      recentEvents: [
        frustrationUserEvent("STOP. this is STILL broken, again?? just STOP"),
      ],
    });

    const generated: AgentCoachingTip[] = [
      makeTip("resilience-tip", "resilience"),
    ];
    const kept = filterGeneratedTipsByAdoptionSignal(generated, input);

    expect(kept.map((tip) => tip.id)).toEqual(["resilience-tip"]);
  });

  // Per-lever boundary parity. Each case pins the concrete threshold with a
  // fixture just ABOVE it (warranted) and one just BELOW it (unwarranted), and
  // asserts BOTH paths against a LITERAL expectation — not against
  // warrantedLeversForInput, which the generated filter itself calls (a
  // tautology). The generated path must keep the category's tip iff warranted;
  // the seed path must never surface a tip of that lever when it is NOT
  // warranted. This proves the two paths agree at each boundary, so a seed gate
  // that stopped surfacing a lever the generated path still admits (or vice
  // versa) would fail here.
  const LEVER_BOUNDARY_CASES: LeverBoundaryCase[] = [
    {
      category: "context_management",
      lever: "context_hygiene",
      // avg tokens/session floor is 15_000 → 150_000 tokens / 10 sessions.
      warranted: () =>
        makeInput({
          analytics: makeAnalytics({ inputTokens: 150_000, outputTokens: 0 }),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
      // Just below both floors: avg events ~1, avg tokens ~1_000.
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
    },
    {
      category: "token_efficiency",
      lever: "reuse",
      // A single prior skill invocation is enough to warrant reuse.
      warranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [{ invocationCount: 1 }],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
      // No skills, no shell tool, no repeated command family.
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
    },
    {
      category: "accuracy",
      lever: "test_sequencing",
      // Delegation floor is 3 general/test subagents.
      warranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({
            avgDurationSec: 30,
            subagentTypes: [
              { count: 3, subagentType: "general-explore" },
            ] as WorkflowQueryData["orchestration"]["subagentTypes"],
          }),
        }),
      // Two delegations — one below the floor.
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({
            avgDurationSec: 30,
            subagentTypes: [
              { count: 2, subagentType: "general-explore" },
            ] as WorkflowQueryData["orchestration"]["subagentTypes"],
          }),
        }),
    },
    {
      category: "wall_time",
      lever: "wall_time",
      // avg session wall-clock floor is 600s.
      warranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 600, subagentTypes: [] }),
        }),
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 599, subagentTypes: [] }),
        }),
    },
    {
      category: "cost",
      lever: "cost",
      // Token floor is 50_000 (dollar estimate absent in this fixture → tokens
      // alone qualify).
      warranted: () =>
        makeInput({
          analytics: makeAnalytics({ inputTokens: 50_000, outputTokens: 0 }),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
      unwarranted: () =>
        makeInput({
          analytics: makeAnalytics({ inputTokens: 49_000, outputTokens: 0 }),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
    },
    {
      category: "resilience",
      lever: "resilience",
      // A confident frustration peak in the recent events.
      warranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [
            frustrationUserEvent(
              "STOP. this is STILL broken, again?? just STOP"
            ),
          ],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
      // Calm events — no frustration peak.
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: [],
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
    },
    {
      category: "capability_gap",
      lever: "capability_gap",
      // Two distinct repeated command families (≥3 each) and ZERO skills in use
      // → the skills capability gap fires (FEA-4153), warranting the lever.
      warranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: repeatedFamilyEvents(),
          skills: [],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
      // Same repeated families, but a prior skill invocation exists → the user
      // already adopts skills, so no capability gap is detected.
      unwarranted: () =>
        makeInput({
          analytics: lowLoadAnalytics(),
          recentEvents: repeatedFamilyEvents(),
          skills: [{ invocationCount: 1 }],
          workflow: makeWorkflow({ avgDurationSec: 30, subagentTypes: [] }),
        }),
    },
  ];

  for (const boundary of LEVER_BOUNDARY_CASES) {
    it(`boundary parity for the ${boundary.lever} lever`, () => {
      const warrantedInput = boundary.warranted();
      const unwarrantedInput = boundary.unwarranted();

      // Generated path: literal expectations, NOT derived from
      // warrantedLeversForInput (which the filter itself calls).
      const keptWhenWarranted = filterGeneratedTipsByAdoptionSignal(
        [makeTip(`gen-${boundary.category}`, boundary.category)],
        warrantedInput
      );
      expect(keptWhenWarranted.map((tip) => tip.id)).toEqual([
        `gen-${boundary.category}`,
      ]);

      const keptWhenUnwarranted = filterGeneratedTipsByAdoptionSignal(
        [makeTip(`gen-${boundary.category}`, boundary.category)],
        unwarrantedInput
      );
      expect(keptWhenUnwarranted).toHaveLength(0);

      // Seed-path parity: with the lever NOT warranted, the seed builders must
      // not surface a tip that pulls it — the same gate, from the other path.
      const seedLeversWhenUnwarranted = new Set(
        buildAgentCoachingTips(unwarrantedInput).map((tip) =>
          leverForCategory(tip.category)
        )
      );
      expect(seedLeversWhenUnwarranted.has(boundary.lever)).toBe(false);
    });
  }
});

type LeverBoundaryCase = {
  category: AgentCoachingTipCategory;
  lever: ReturnType<typeof leverForCategory>;
  warranted: () => AgentCoachingInput;
  unwarranted: () => AgentCoachingInput;
};

// Analytics with sub-floor per-session load (avg events ~1, avg tokens ~1_000)
// and NO shell tool in the mix — clears NEITHER the context nor the reuse gate
// on its own, so each boundary fixture warrants a lever only via the signal it
// deliberately sets (skills, delegations, duration, tokens, frustration).
function lowLoadAnalytics(): AnalyticsData {
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
      totalInputTokens: 8000,
      totalOutputTokens: 2000,
      windowDays: 30,
    },
    toolUsage: [{ count: 4, toolName: "Read" }],
    totalAgents: 0,
    totalEvents: 10,
    totalSessions: 10,
  } as unknown as AnalyticsData;
}

const _ALL_CATEGORIES: AgentCoachingTipCategory[] = [
  "context_management",
  "speed_of_delivery",
  "accuracy",
  "opportunity_analysis",
  "token_efficiency",
  "resilience",
  "wall_time",
  "cost",
  "capability_gap",
];

function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: makeEvents(),
    skills: [{ invocationCount: 4 }],
    workflow: makeWorkflow(),
    ...overrides,
  };
}

function makeAnalytics(
  opts: { inputTokens?: number; outputTokens?: number } = {}
): AnalyticsData {
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
      totalInputTokens: opts.inputTokens ?? 120_000,
      totalOutputTokens: opts.outputTokens ?? 30_000,
      windowDays: 30,
    },
    toolUsage: [
      { count: 80, toolName: "Bash" },
      { count: 20, toolName: "Agent" },
    ],
    totalAgents: 20,
    totalEvents: 1000,
    totalSessions: 10,
  } as unknown as AnalyticsData;
}

function makeWorkflow(
  opts: {
    avgDurationSec?: number;
    subagentTypes?: WorkflowQueryData["orchestration"]["subagentTypes"];
    totalSessions?: number;
  } = {}
): WorkflowQueryData {
  const totalSessions = opts.totalSessions ?? 10;
  return {
    cooccurrence: [],
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
      edges: [],
      mainCount: totalSessions,
      outcomes: [],
      sessionCount: totalSessions,
      subagentTypes: opts.subagentTypes ?? [
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
      avgDurationSec: opts.avgDurationSec ?? 100,
      avgSubagents: 1,
      successRate: 0.9,
      topFlow: null,
      totalAgents: 20,
      totalCompactions: 0,
      totalSessions,
      totalSubagents: 12,
    },
    toolFlow: { toolCounts: [], transitions: [] },
  } as unknown as WorkflowQueryData;
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
      "git fetch origin && mkdir -p /tmp/nrev && gh pr view 1656 --json files",
    toolName: "Bash",
  })) as unknown as EventWithSession[];
}

// Two distinct shell command families (`git status`, `pnpm test`), each
// repeated ≥3 times, so `computeRepeatedFamilies` reports two families — the
// floor the skills capability gap needs. Every command is routed through `rtk`
// so the unwrapped-shell (rtk-routing) gap never fires: this isolates the
// boundary on the SKILLS gap alone (zero skills → gap; a skill in use → none).
function repeatedFamilyEvents(): EventWithSession[] {
  const commands = [
    "rtk git status",
    "rtk git status",
    "rtk git status",
    "rtk pnpm test",
    "rtk pnpm test",
    "rtk pnpm test",
  ];
  return commands.map(
    (summary, index) =>
      ({
        agentId: null,
        createdAt: "2026-06-17T00:00:00.000Z",
        data: null,
        eventType: "tool_use",
        id: `family-event-${index}`,
        sessionId: "session-1",
        sessionName: "Repeated commands",
        summary,
        toolName: "Bash",
      }) as unknown as EventWithSession
  );
}

function frustrationUserEvent(summary: string): EventWithSession {
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "UserMessage",
    id: "user-frustration",
    sessionId: "session-1",
    sessionName: "Crash-out session",
    summary,
    toolName: null,
  } as unknown as EventWithSession;
}

function makeTip(
  id: string,
  category: AgentCoachingTipCategory
): AgentCoachingTip {
  return {
    actions: [],
    body: "LLM-generated coaching body",
    category,
    detail: {
      autoApply: "No automatic changes.",
      howToAct: ["Inspect the evidence"],
      whatThisMeans: "A provider generated this coaching tip.",
      whyThisRecommendation: "The provider used local session evidence.",
    },
    evidence: ["provider evidence"],
    experiment: "Try one follow-up.",
    id,
    title: "LLM coaching tip",
    whyItMatters: "It adapts from feedback.",
  };
}
