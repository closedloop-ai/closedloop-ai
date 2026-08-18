import { describe, expect, it, vi } from "vitest";
import { createAgentCoachingApi } from "../agent-coaching-api";
import { renderAgentCoachingPrompt } from "../agent-coaching-llm";
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
        // Each non-deterministic round contributes two fresh tips on DISTINCT
        // levers so they survive the diversity dedup and accumulate toward 5.
        const a = round * 2;
        const b = a + 1;
        round += 1;
        return Promise.resolve([
          makeTip(`round-${round}-a`, DISTINCT_LEVER_CATEGORIES[a]),
          makeTip(`round-${round}-b`, DISTINCT_LEVER_CATEGORIES[b]),
        ]);
      }),
    });

    const { tips } = await api.loadTips();

    // 2 + 2 + 2 across the bounded rounds, capped at the daily target of 5.
    expect(tips).toHaveLength(5);
    expect(new Set(tips.map((tip) => tip.id)).size).toBe(5);
  });

  it("applies the diversity guarantee to harness output (one tip per lever)", async () => {
    // Codex P1: successful harness output previously bypassed the pool contract,
    // so it could surface two tips pulling the SAME lever. speed_of_delivery and
    // token_efficiency both pull `reuse`; only the first survives.
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn(() =>
        Promise.resolve([
          makeTip("reuse-first", "speed_of_delivery"),
          makeTip("reuse-second", "token_efficiency"),
          makeTip("cost", "cost"),
        ])
      ),
    });

    const { tips } = await api.loadTips();
    const ids = tips.map((tip) => tip.id);

    expect(ids).toContain("reuse-first");
    expect(ids).not.toContain("reuse-second");
    expect(ids).toContain("cost");
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

  it("never spawns the generator when there is no substantive activity to ground a tip in", async () => {
    // An empty-activity load must NOT burn the ~9s-each local `claude -p` spawn
    // only to be refused — it falls back to the built-in seed tips instead.
    const generateTips = vi.fn(() => Promise.resolve([makeTip("llm-tip")]));
    const api = createAgentCoachingApi(makeEmptyDesktopApi(), makeStorage(), {
      generateTips,
    });

    const { tips } = await api.loadTips();

    expect(generateTips).not.toHaveBeenCalled();
    // With no activity the built-in seed model also has nothing to ground a tip
    // in, so loadTips falls back to the (empty) seed set — the point is that no
    // harness was spawned to reach that clean state.
    expect(tips).toEqual([]);
  });

  it("never spawns the generator when substantive activity warrants no lever (FEA-4179)", async () => {
    // A sparse-but-nonempty corpus (a couple of short sessions, a handful of
    // events, sub-floor token spend, a single work mode, no shell/skill/reuse,
    // no frustration peak) passes hasSubstantiveCoachingActivity yet warrants no
    // lever. Every generated tip would be dropped by the warranted-lever filter
    // regardless of what the model returns, so the ~9s-each local `claude -p`
    // spawn must be skipped — loadTips falls back to the seed set, whose own
    // per-lever gates likewise surface nothing here.
    const generateTips = vi.fn(() => Promise.resolve([makeTip("llm-tip")]));
    const api = createAgentCoachingApi(
      makeSparseUnwarrantedDesktopApi(),
      makeStorage(),
      {
        generateTips,
      }
    );

    const { tips } = await api.loadTips();

    expect(generateTips).not.toHaveBeenCalled();
    expect(tips).toEqual([]);
  });

  it("drops generated tips for unwarranted levers when a mixed batch flows through loadTips (FEA-4179)", async () => {
    // API-level regression for the warranted-lever filter INSIDE loadTips (not
    // the helper in isolation): the corpus warrants ONLY the cost lever (>50k
    // tokens) — short sessions (no wall_time), no frustration peak (no
    // resilience), no skills/shell/reuse, sub-floor per-session load and few
    // delegations. A generator that returns a mixed batch (cost + wall_time +
    // resilience) must have the two unwarranted tips filtered out by loadTips,
    // leaving only the cost tip. Deleting the filterGeneratedTipsByWarrantedLevers
    // call in agent-coaching-api.ts would leave all three, failing this test.
    const generateTips = vi.fn(() =>
      Promise.resolve([
        makeTip("cost-tip", "cost"),
        makeTip("wall-time-tip", "wall_time"),
        makeTip("resilience-tip", "resilience"),
      ])
    );
    const api = createAgentCoachingApi(
      makeCostOnlyWarrantedDesktopApi(),
      makeStorage(),
      { generateTips }
    );

    const { tips } = await api.loadTips();
    const ids = tips.map((tip) => tip.id);

    // The generator was spawned (cost is warranted, so we did not short-circuit).
    expect(generateTips).toHaveBeenCalled();
    // Only the warranted-lever tip survives the loadTips filter.
    expect(ids).toEqual(["cost-tip"]);
  });

  it("constrains the prompt to the warranted-lever categories and states the category→lever contract (FEA-4179)", async () => {
    // The prompt must TELL the generator which lever each category pulls and
    // which categories the user's usage warrants — so a tip's lever is decided
    // by evidence stated up front, not filtered out afterwards. With a
    // cost-only-warranted corpus, the request advertises `cost` but not the
    // unwarranted `wall_time`/`resilience`, and the rendered prompt states the
    // contract.
    const requests: AgentCoachingLlmRequest[] = [];
    const api = createAgentCoachingApi(
      makeCostOnlyWarrantedDesktopApi(),
      makeStorage(),
      {
        generateTips: vi.fn((nextRequest) => {
          requests.push(nextRequest);
          return Promise.resolve([makeTip("cost-tip", "cost")]);
        }),
      }
    );

    await api.loadTips();
    const request = requests[0];

    expect(request?.allowedCategories).toContain("cost");
    expect(request?.allowedCategories).not.toContain("wall_time");
    expect(request?.allowedCategories).not.toContain("resilience");
    // The contract lists the canonical category→lever pairs.
    expect(request?.categoryLeverContract).toEqual(
      expect.arrayContaining([["cost", "cost"]])
    );

    const prompt = renderAgentCoachingPrompt(
      request as AgentCoachingLlmRequest
    );
    expect(prompt).toContain("cost → cost");
    // The prompt constrains the generator to the warranted categories and warns
    // that an unwarranted-lever tip is discarded.
    expect(prompt).toContain("Produce tips ONLY in these categories");
    expect(prompt).toContain("will be discarded");
  });

  it("threads an all-time (null) load into the prompt so it renders as all time (FEA-3722)", async () => {
    // Production regression: loadTips(null) fetches all-time analytics (windowDays
    // 0/absent); request construction must pass the selected range so the prompt
    // labels the window "all time" — not the 30-day default that would frame the
    // all-time token totals as a month.
    const requests: AgentCoachingLlmRequest[] = [];
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn((nextRequest) => {
        requests.push(nextRequest);
        return Promise.resolve([makeTip("llm-tip")]);
      }),
    });

    await api.loadTips(null);

    const request = requests[0];
    expect(request?.groundedMetrics.lookbackDays).toBe(0);
    const prompt = renderAgentCoachingPrompt(
      request as AgentCoachingLlmRequest
    );
    expect(prompt).toContain("Windowed metrics (all time)");
    expect(prompt).not.toContain("last 30 days");
  });

  it("spawns the generator when the load carries substantive activity", async () => {
    const generateTips = vi.fn(() => Promise.resolve([makeTip("llm-tip")]));
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips,
    });

    await api.loadTips();

    expect(generateTips).toHaveBeenCalled();
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

  it("bridges subscribeToActivity to the desktop DB-change push", () => {
    const unsubscribe = vi.fn();
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => unsubscribe
    );
    const desktopApi = makeDesktopApi();
    (desktopApi as { onDbChanged?: unknown }).onDbChanged = onDbChanged;
    const api = createAgentCoachingApi(desktopApi, makeStorage(), {
      generateTips: vi.fn(() => Promise.resolve([])),
    });

    const onChange = vi.fn();
    const stop = api.subscribeToActivity?.(onChange);
    // The DB push fires with a payload; the activity callback is payload-free.
    expect(onDbChanged).toHaveBeenCalledTimes(1);
    onDbChanged.mock.calls[0][0]({ sessionId: "s1" });
    expect(onChange).toHaveBeenCalledTimes(1);

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("omits subscribeToActivity when the bridge exposes no DB-change push", () => {
    const api = createAgentCoachingApi(makeDesktopApi(), makeStorage(), {
      generateTips: vi.fn(() => Promise.resolve([])),
    });

    expect(api.subscribeToActivity).toBeUndefined();
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
        // FEA-4179: the generated path now gates each tip on the user's real
        // usage for its lever (the SAME per-lever gate the seed builders use), so
        // this "active user" fixture must warrant every lever the generation
        // tests exercise: high per-session load (context), repeated shell + skill
        // usage (reuse), two distinct work modes — execution + delegation
        // (harness routing), and >50k tokens (cost).
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
          // A confident frustration peak so the resilience lever is warranted.
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
            // General/explore delegations clear the test-sequencing floor so the
            // accuracy lever is warranted.
            subagentTypes: [{ count: 4, subagentType: "general-explore" }],
          },
          // Long average session wall time warrants the wall_time lever.
          stats: { avgDurationSec: 1800, totalSessions: 2 },
        })
      ),
    },
  } as unknown as AgentCoachingDesktopApi;
}

// A desktop API whose DB reads all resolve empty/null — no sessions, events,
// tokens, or skills. Mirrors a fresh install / zero-activity Sessions view.
function makeEmptyDesktopApi(): AgentCoachingDesktopApi {
  return {
    agentSessionsApi: {
      analytics: vi.fn(),
      detail: vi.fn(),
      list: vi.fn(),
      usage: vi.fn(),
    },
    db: {
      getAllSkills: vi.fn(() => Promise.resolve([])),
      getAnalytics: vi.fn(() => Promise.resolve(null)),
      getEventFeed: vi.fn(() => Promise.resolve([])),
      getWorkflowData: vi.fn(() => Promise.resolve(null)),
    },
  } as unknown as AgentCoachingDesktopApi;
}

// A desktop API with real-but-sparse activity that clears the
// hasSubstantiveCoachingActivity floor (sessions + a few events + some tokens)
// yet warrants NO coaching lever: sub-floor per-session load and token spend
// (no context/cost), a single work mode (no harness routing), one delegation
// (no test sequencing), no shell/skill/reusable command (no reuse), a short
// average session (no wall_time), and no confident frustration peak (no
// resilience). FEA-4179: proves the empty-warranted short-circuit.
function makeSparseUnwarrantedDesktopApi(): AgentCoachingDesktopApi {
  return {
    agentSessionsApi: {
      analytics: vi.fn(),
      detail: vi.fn(),
      list: vi.fn(),
      usage: vi.fn(),
    },
    db: {
      getAllSkills: vi.fn(() => Promise.resolve([])),
      getAnalytics: vi.fn(() =>
        Promise.resolve({
          toolUsage: [{ count: 2, toolName: "Read" }],
          tokens: {
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalInputTokens: 800,
            totalOutputTokens: 200,
          },
          totalEvents: 4,
          totalSessions: 2,
        })
      ),
      getEventFeed: vi.fn(() =>
        Promise.resolve([
          {
            createdAt: "2026-06-17T00:00:00.000Z",
            id: "event-0",
            sessionId: "session-1",
            summary: "Read a file",
            toolName: "Read",
          },
        ])
      ),
      getWorkflowData: vi.fn(() =>
        Promise.resolve({
          orchestration: {
            subagentTypes: [{ count: 1, subagentType: "general-explore" }],
          },
          stats: { avgDurationSec: 30, totalSessions: 2 },
        })
      ),
    },
  } as unknown as AgentCoachingDesktopApi;
}

// A desktop API whose usage warrants ONLY the cost lever: >50k tokens (cost),
// but short sessions (no wall_time), no frustration peak (no resilience), no
// skills / shell / repeated-command family (no reuse), sub-floor per-session
// load (no context_hygiene), and one delegation (no test_sequencing). Drives the
// FEA-4179 mixed-batch filter INSIDE loadTips: a generator returning cost +
// wall_time + resilience must have the two unwarranted tips dropped.
function makeCostOnlyWarrantedDesktopApi(): AgentCoachingDesktopApi {
  return {
    agentSessionsApi: {
      analytics: vi.fn(),
      detail: vi.fn(),
      list: vi.fn(),
      usage: vi.fn(),
    },
    db: {
      getAllSkills: vi.fn(() => Promise.resolve([])),
      getAnalytics: vi.fn(() =>
        Promise.resolve({
          // No shell tool in the mix → reuse stays unwarranted.
          toolUsage: [{ count: 6, toolName: "Read" }],
          tokens: {
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            // >50k tokens over many sessions: warrants cost, but the per-session
            // average stays well under the context floor.
            totalInputTokens: 60_000,
            totalOutputTokens: 20_000,
          },
          totalEvents: 30,
          totalSessions: 30,
        })
      ),
      getEventFeed: vi.fn(() =>
        Promise.resolve([
          {
            createdAt: "2026-06-17T00:00:00.000Z",
            id: "event-0",
            sessionId: "session-1",
            summary: "Read a file",
            toolName: "Read",
          },
        ])
      ),
      getWorkflowData: vi.fn(() =>
        Promise.resolve({
          orchestration: {
            subagentTypes: [{ count: 1, subagentType: "general-explore" }],
          },
          // Short average session → wall_time stays unwarranted.
          stats: { avgDurationSec: 30, totalSessions: 30 },
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

// Distinct levers so multi-tip fixtures survive the FEA-3265 diversity dedup
// (dedupeGeneratedTipsByLever keeps one tip per lever). Each entry pulls a
// different lever; callers index into this to give successive tips distinct
// levers.
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
