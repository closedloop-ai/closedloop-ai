import { describe, expect, it, vi } from "vitest";
import { createAgentCoachingApi } from "../agent-coaching-api";
import type {
  AgentCoachingDesktopApi,
  AgentCoachingTip,
} from "../agent-coaching-types";

// Active-usage fixture that warrants every lever, mirroring
// agent-coaching-api.test.ts's makeDesktopApi. Duplicated locally (new test
// file, per instructions) rather than importing a non-exported helper.
function makeActiveDesktopApi(): AgentCoachingDesktopApi {
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
          toolUsage: [
            { count: 12, toolName: "Bash" },
            { count: 6, toolName: "Task" },
          ],
          tokens: {
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalInputTokens: 200_000,
            totalOutputTokens: 60_000,
          },
          totalEvents: 200,
          totalSessions: 2,
        })
      ),
      getEventFeed: vi.fn(() =>
        Promise.resolve([
          ...Array.from({ length: 3 }, (_, index) => ({
            createdAt: "2026-06-17T00:00:00.000Z",
            id: `event-${index}`,
            sessionId: "session-1",
            summary:
              "git fetch origin && mkdir -p /tmp/nrev && gh pr view 123 --json files",
            toolName: "Bash",
          })),
          {
            createdAt: "2026-06-17T00:05:00.000Z",
            eventType: "user_message",
            id: "event-frustration",
            sessionId: "session-1",
            sessionName: "Frustrating session",
            summary: "STOP. this is STILL broken, again?? just STOP",
            toolName: null,
          },
        ])
      ),
      getWorkflowData: vi.fn(() =>
        Promise.resolve({
          orchestration: {
            subagentTypes: [{ count: 4, subagentType: "general-explore" }],
          },
          stats: { avgDurationSec: 1800, totalSessions: 2 },
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

// Six distinct levers to give every generated tip a unique lever, so the
// diversity dedup in dedupeGeneratedTipsByLever never collapses them.
const DISTINCT_LEVER_CATEGORIES: AgentCoachingTip["category"][] = [
  "token_efficiency",
  "context_management",
  "cost",
  "wall_time",
  "resilience",
  "accuracy",
];

function makeTip(
  id: string,
  category: AgentCoachingTip["category"] = "token_efficiency"
): AgentCoachingTip {
  return {
    actions: [],
    body: "LLM-generated coaching body",
    category,
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

describe("createAgentCoachingApi collectGeneratedTips round loop", () => {
  it("stops generating further rounds once the daily limit is reached mid-loop", async () => {
    // Round 0 alone returns 5 distinct-lever tips (the full daily limit), so
    // the loop-top check before round 1 (collected.length >= limit) must break
    // early rather than spawning a second/third generation round.
    const generateTips = vi.fn(() =>
      Promise.resolve(
        DISTINCT_LEVER_CATEGORIES.slice(0, 5).map((category, index) =>
          makeTip(`tip-${index}`, category)
        )
      )
    );
    const api = createAgentCoachingApi(makeActiveDesktopApi(), makeStorage(), {
      generateTips,
    });

    const { tips } = await api.loadTips();

    expect(tips).toHaveLength(5);
    expect(generateTips).toHaveBeenCalledTimes(1);
  });

  it("stops the round loop once a round contributes no new tips", async () => {
    // First round returns one fresh tip; every later round returns only that
    // SAME id, so `collected.length === before` after round 2 must break the
    // loop instead of spawning a third round.
    let round = 0;
    const generateTips = vi.fn(() => {
      round += 1;
      return Promise.resolve([makeTip("repeat-tip", "cost")]);
    });
    const api = createAgentCoachingApi(makeActiveDesktopApi(), makeStorage(), {
      generateTips,
    });

    const { tips } = await api.loadTips();

    expect(tips.map((tip) => tip.id)).toEqual(["repeat-tip"]);
    // Round 1 adds the tip; round 2 repeats it and stops the loop, so a third
    // round is never spawned.
    expect(generateTips).toHaveBeenCalledTimes(2);
    expect(round).toBe(2);
  });

  it("falls back to the (non-empty) seed tips when every generation round yields nothing", async () => {
    // The active-usage fixture warrants a lever AND builds a non-empty seed
    // set from buildAgentCoachingTips; the generator returns [] every round,
    // so `collected` stays empty and `loadTips` must fall back to that real
    // seed set — not to an empty array — pinning the `collected.length > 0`
    // branch against a generator that legitimately produced nothing.
    const generateTips = vi.fn(() => Promise.resolve([]));
    const api = createAgentCoachingApi(makeActiveDesktopApi(), makeStorage(), {
      generateTips,
    });

    const { tips } = await api.loadTips();

    expect(generateTips).toHaveBeenCalled();
    expect(tips.length).toBeGreaterThan(0);
    expect(tips.some((tip) => tip.id === "shell-probe-reusable-skill")).toBe(
      true
    );
  });
});

describe("createAgentCoachingApi loadTips DB-read fallbacks", () => {
  it("falls back to null workflow and an empty event feed when those reads fail", async () => {
    const desktopApi = makeActiveDesktopApi();
    (
      desktopApi.db.getWorkflowData as unknown as {
        mockImplementation: (fn: () => Promise<never>) => void;
      }
    ).mockImplementation(() =>
      Promise.reject(new Error("workflow read failed"))
    );
    (
      desktopApi.db.getEventFeed as unknown as {
        mockImplementation: (fn: () => Promise<never>) => void;
      }
    ).mockImplementation(() =>
      Promise.reject(new Error("event feed read failed"))
    );
    const requests: Array<{
      localEvidence: { workflow: unknown; recentEvents: unknown[] };
    }> = [];
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn((request) => {
        requests.push(request);
        return Promise.resolve([]);
      }),
    });

    await api.loadTips();

    // A rejected workflow read must fall back to null (not undefined) and a
    // rejected event-feed read to an empty array (not undefined) — both feed
    // straight into the generation request.
    expect(requests[0]?.localEvidence.workflow).toBeNull();
    expect(requests[0]?.localEvidence.recentEvents).toEqual([]);
  });
});

describe("createAgentCoachingApi installArtifact", () => {
  it("resolves with the handler's output when the install succeeds", async () => {
    const installCoachingArtifact = vi.fn(() =>
      Promise.resolve({ ok: true, output: "Installed at .claude/skills/x" })
    );
    const desktopApi = makeActiveDesktopApi();
    (
      desktopApi as { installCoachingArtifact: unknown }
    ).installCoachingArtifact = installCoachingArtifact;
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn(() => Promise.resolve([])),
    });

    const output = await api.installArtifact?.(
      "draft content",
      "claude",
      "create-new-file"
    );

    expect(output).toBe("Installed at .claude/skills/x");
    expect(installCoachingArtifact).toHaveBeenCalledWith(
      "draft content",
      "claude",
      "create-new-file"
    );
  });

  it("throws with the handler's message when the install fails", async () => {
    const installCoachingArtifact = vi.fn(() =>
      Promise.resolve({ ok: false, message: "spawn failed" })
    );
    const desktopApi = makeActiveDesktopApi();
    (
      desktopApi as { installCoachingArtifact: unknown }
    ).installCoachingArtifact = installCoachingArtifact;
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn(() => Promise.resolve([])),
    });

    await expect(api.installArtifact?.("draft content")).rejects.toThrow(
      "spawn failed"
    );
  });
});
