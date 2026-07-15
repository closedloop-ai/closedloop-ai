import type {
  ToolItem,
  TurnActor,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  buildMergedTrace,
  MERGED_TRACE_IDLE_THRESHOLD_MS,
  type MergedTraceSessionInput,
  mapTurnItemToTrace,
  parseSubagentCostUsd,
} from "./merged-trace";

const iso = (secondsFromEpochBase: number): string =>
  new Date(Date.UTC(2026, 6, 3, 0, 0, secondsFromEpochBase)).toISOString();

function actor(sessionId: string): TurnActor {
  return { name: "Ada", sessionId, human: "Ada", color: "#64748B" };
}

const toolItem: ToolItem = { label: "bash", detail: "ls", err: false };

function session(
  overrides: Partial<MergedTraceSessionInput> & { sessionId: string }
): MergedTraceSessionInput {
  return {
    startedAt: iso(0),
    actorName: "Ada",
    harness: "claude",
    turnItems: [],
    ...overrides,
  };
}

describe("mapTurnItemToTrace", () => {
  it("synthesized-only turn item types map to null", () => {
    const sessionStart: TurnItem = {
      type: "sessionstart",
      t: iso(0),
      actor: actor("s1"),
    };
    expect(mapTurnItemToTrace(sessionStart, "s1")).toBeNull();
    expect(mapTurnItemToTrace({ type: "idle", gap: 5 }, "s1")).toBeNull();
  });

  it("maps a tools turn item preserving per-tool rows and failure counts", () => {
    const tools: TurnItem = {
      type: "tools",
      _row: 1,
      t: iso(10),
      tMs: 10_000,
      endMs: 12_000,
      cum: 0.1,
      actor: actor("s1"),
      summary: "2 tools",
      items: [toolItem],
      hasFail: true,
      failN: 1,
      cats: { bash: 1 },
    };
    expect(mapTurnItemToTrace(tools, "s1")).toEqual({
      type: "tools",
      sessionId: "s1",
      t: iso(10),
      tMs: 10_000,
      endMs: 12_000,
      summary: "2 tools",
      hasFail: true,
      failN: 1,
      items: [toolItem],
    });
  });

  it("parses the subagent cost label into a number", () => {
    const sub: TurnItem = {
      type: "subagent",
      _row: 2,
      t: iso(20),
      tMs: 20_000,
      cum: 0.5,
      actor: actor("s1"),
      sub: "explorer",
      subagentType: "Explore",
      status: "done",
      model: "claude-opus-4-8",
      duration: "1m",
      tokens: "1k",
      cost: "$0.42",
      body: [],
    };
    const mapped = mapTurnItemToTrace(sub, "s1");
    expect(mapped).toMatchObject({ type: "subagent", costUsd: 0.42 });
  });
});

describe("parseSubagentCostUsd", () => {
  it("returns null for null or unparseable labels", () => {
    expect(parseSubagentCostUsd(null)).toBeNull();
    expect(parseSubagentCostUsd("n/a")).toBeNull();
  });

  it("strips currency formatting", () => {
    expect(parseSubagentCostUsd("$1,024.50")).toBe(1024.5);
  });
});

describe("buildMergedTrace", () => {
  it("synthesizes one sessionstart per session and k-way merges by timestamp", () => {
    const prompt: TurnItem = {
      type: "prompt",
      _row: 1,
      t: iso(10),
      tMs: 10_000,
      cum: 0.1,
      actor: actor("a"),
      text: "hi",
    };
    const say: TurnItem = {
      type: "say",
      _row: 1,
      t: iso(15),
      tMs: 15_000,
      cum: 0.2,
      actor: actor("b"),
      text: "yo",
    };
    const trace = buildMergedTrace([
      session({ sessionId: "a", startedAt: iso(0), turnItems: [prompt] }),
      session({ sessionId: "b", startedAt: iso(5), turnItems: [say] }),
    ]);
    expect(trace.map((item) => [item.type, item.sessionId])).toEqual([
      ["sessionstart", "a"],
      ["sessionstart", "b"],
      ["prompt", "a"],
      ["say", "b"],
    ]);
    expect(trace[0]).toMatchObject({
      type: "sessionstart",
      actor: { name: "Ada", harness: "claude" },
    });
  });

  it("synthesizes an idle marker only across a gap >= the idle threshold", () => {
    const gapSeconds = MERGED_TRACE_IDLE_THRESHOLD_MS / 1000; // 120s
    const early: TurnItem = {
      type: "event",
      _row: 1,
      t: iso(10),
      tMs: 10_000,
      dot: "g",
      text: "start",
    };
    const late: TurnItem = {
      type: "event",
      _row: 2,
      t: iso(10 + gapSeconds),
      tMs: (10 + gapSeconds) * 1000,
      dot: "b",
      text: "resume",
    };
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(10),
        turnItems: [early, late],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({
      type: "idle",
      sessionId: "a",
      t: iso(10),
      gapMs: MERGED_TRACE_IDLE_THRESHOLD_MS,
    });

    // A sub-threshold gap synthesizes no idle.
    const near: TurnItem = {
      type: "event",
      _row: 2,
      t: iso(11),
      tMs: 11_000,
      dot: "b",
      text: "soon",
    };
    const dense = buildMergedTrace([
      session({ sessionId: "a", startedAt: iso(10), turnItems: [near] }),
    ]);
    expect(dense.some((item) => item.type === "idle")).toBe(false);
  });

  it("trails timestamp-less end markers after the chronological stream", () => {
    const end: TurnItem = { type: "end", text: "done" };
    const say: TurnItem = {
      type: "say",
      _row: 1,
      t: iso(30),
      tMs: 30_000,
      cum: 0.1,
      actor: actor("a"),
      text: "bye",
    };
    const trace = buildMergedTrace([
      session({ sessionId: "a", startedAt: iso(0), turnItems: [say, end] }),
    ]);
    expect(trace.at(-1)).toEqual({ type: "end", sessionId: "a", text: "done" });
  });

  it("skips a session-start with an unparseable startedAt", () => {
    const trace = buildMergedTrace([
      session({ sessionId: "a", startedAt: "not-a-date", turnItems: [] }),
    ]);
    expect(trace).toEqual([]);
  });
});
