import { describe, expect, it, vi } from "vitest";
import { createAgentCoachingApi } from "../agent-coaching-api";
import type {
  AgentCoachingDesktopApi,
  AgentCoachingLlmRequest,
  AgentCoachingTip,
} from "../agent-coaching-types";

describe("createAgentCoachingApi", () => {
  it("fills the startup batch toward five tips across generation rounds", async () => {
    let round = 0;
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn(() => {
        round += 1;
        // Each non-deterministic round contributes two fresh tips.
        return Promise.resolve([
          makeTip(`round-${round}-a`),
          makeTip(`round-${round}-b`),
        ]);
      }),
    });

    const { tips } = await api.loadTips();

    // 2 + 2 + 2 across the bounded rounds, capped at the daily target of 5.
    expect(tips).toHaveLength(5);
    expect(new Set(tips.map((tip) => tip.id)).size).toBe(5);
  });

  it("never re-serves a dismissed tip even if the generator returns it", async () => {
    const storage = makeStorage();
    const api = createAgentCoachingApi(makeDesktopApi(), storage, {
      generateTips: vi.fn(() =>
        Promise.resolve([makeTip("dismissed-tip"), makeTip("fresh-tip")])
      ),
    });
    await api.recordFeedback({
      action: "dismissed",
      category: "token_efficiency",
      createdAt: "2026-06-10T00:00:00.000Z",
      tipId: "dismissed-tip",
    });

    const { tips } = await api.loadTips();

    expect(tips.some((tip) => tip.id === "dismissed-tip")).toBe(false);
    expect(tips.some((tip) => tip.id === "fresh-tip")).toBe(true);
  });

  it("passes prior feedback and agentic-development signals into LLM generation", async () => {
    const generatedTip = makeTip("llm-tip");
    const requests: AgentCoachingLlmRequest[] = [];
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn((nextRequest) => {
        requests.push(nextRequest);
        return Promise.resolve([generatedTip]);
      }),
    });

    await api.recordFeedback({
      action: "action_clicked",
      actionId: "draft-command-wrapper",
      category: "token_efficiency",
      createdAt: "2026-06-17T12:00:00.000Z",
      tipId: "shell-probe-reusable-skill",
    });

    const { tips } = await api.loadTips();
    const request = requests[0];

    expect(tips).toEqual([generatedTip]);
    expect(request).toBeDefined();
    expect(request?.generationMode).toBe("non_deterministic_high_reasoning");
    expect(request?.reasoningEffort).toBe("high");
    expect(request?.priorFeedback).toEqual([
      expect.objectContaining({
        action: "action_clicked",
        actionId: "draft-command-wrapper",
        category: "token_efficiency",
      }),
    ]);
    expect(request?.bestPracticeSignals.join(" ")).toContain("Codex");
    expect(request?.bestPracticeSignals.join(" ")).toContain("Claude Code");
    expect(request?.bestPracticeSignals.join(" ")).toContain("OpenCode");
  });

  it("uses the active coaching pack's signals instead of the built-in defaults", async () => {
    const requests: AgentCoachingLlmRequest[] = [];
    const desktopApi = makeDesktopApi();
    desktopApi.getCoachingPack = vi.fn(() =>
      Promise.resolve({
        name: "token-coach",
        displayName: "Token Coach",
        version: "1.0.0",
        description: null,
        signals: ["Cache efficiency is the biggest lever."],
      })
    );
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn((nextRequest) => {
        requests.push(nextRequest);
        return Promise.resolve([makeTip("llm-tip")]);
      }),
    });

    const pack = await api.loadActivePack?.();
    expect(pack?.displayName).toBe("Token Coach");

    // loadTips surfaces the same pack it generated against (badge ↔ signals).
    const { activePack } = await api.loadTips();
    expect(activePack?.displayName).toBe("Token Coach");
    expect(requests[0]?.bestPracticeSignals).toEqual([
      "Cache efficiency is the biggest lever.",
    ]);
    expect(requests[0]?.bestPracticeSignals.join(" ")).not.toContain(
      "OpenCode"
    );
  });

  it("falls back to built-in signals when no coaching pack bridge exists", async () => {
    const requests: AgentCoachingLlmRequest[] = [];
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn((nextRequest) => {
        requests.push(nextRequest);
        return Promise.resolve([makeTip("llm-tip")]);
      }),
    });

    expect(await api.loadActivePack?.()).toBeNull();
    const { activePack } = await api.loadTips();
    expect(activePack).toBeNull();
    expect(requests[0]?.bestPracticeSignals.join(" ")).toContain("Claude Code");
  });

  it("redacts secrets from event evidence before it reaches the LLM provider", async () => {
    const requests: AgentCoachingLlmRequest[] = [];
    const desktopApi = makeDesktopApi();
    desktopApi.db.getEventFeed = vi.fn(() =>
      Promise.resolve([
        {
          agentId: null,
          createdAt: "2026-06-17T00:00:00.000Z",
          data: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
          eventType: "tool_use",
          id: "event-secret",
          sessionId: "session-1",
          sessionName: "Secret session",
          summary:
            "curl -H 'x' https://api.example.com --key sk_live_DEADBEEF1234",
          toolName: "Bash",
        },
      ])
    );
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn((nextRequest) => {
        requests.push(nextRequest);
        return Promise.resolve([makeTip("llm-tip")]);
      }),
    });

    await api.loadTips();
    const event = requests[0]?.localEvidence.recentEvents[0];

    expect(event?.summary).not.toContain("sk_live_DEADBEEF1234");
    expect(event?.summary).toContain("[REDACTED_SECRET]");
    expect(event?.data).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(event?.data).toContain("[REDACTED_SECRET]");
  });
});

function makeDesktopApi(): AgentCoachingDesktopApi {
  return {
    agentSessionsApi: {
      analytics: vi.fn(),
      detail: vi.fn(),
      list: vi.fn(),
      usage: vi.fn(),
    },
    db: {
      getAllSkills: vi.fn(() =>
        Promise.resolve([{ invocationCount: 2, name: "nightly-review" }])
      ),
      getAnalytics: vi.fn(() =>
        Promise.resolve({
          toolUsage: [{ count: 12, toolName: "Bash" }],
          tokens: {
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalInputTokens: 20_000,
            totalOutputTokens: 5000,
          },
          totalEvents: 200,
          totalSessions: 2,
        })
      ),
      getEventFeed: vi.fn(() =>
        Promise.resolve(
          Array.from({ length: 3 }, (_, index) => ({
            createdAt: "2026-06-17T00:00:00.000Z",
            id: `event-${index}`,
            sessionId: "session-1",
            summary:
              "git fetch origin && mkdir -p /tmp/nrev && gh pr view 123 --json files",
            toolName: "Bash",
          }))
        )
      ),
      getWorkflowData: vi.fn(() =>
        Promise.resolve({
          orchestration: { subagentTypes: [] },
          stats: { totalSessions: 2 },
        })
      ),
    },
  } as unknown as AgentCoachingDesktopApi;
}

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function makeTip(id: string): AgentCoachingTip {
  return {
    actions: [],
    body: "LLM-generated coaching body",
    category: "token_efficiency",
    detail: {
      autoApply: "No automatic changes.",
      howToAct: ["Inspect the evidence"],
      whatThisMeans: "A provider generated this coaching tip.",
      whyThisRecommendation:
        "The provider used feedback and local session evidence.",
    },
    evidence: ["provider evidence"],
    experiment: "Try one follow-up.",
    id,
    title: "LLM coaching tip",
    whyItMatters: "It adapts from feedback.",
  };
}
