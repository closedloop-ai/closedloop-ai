import type { TurnItem } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  actor,
  iso,
  promptTurn,
  sayTurn,
  session,
  toolItem,
  toolsTurn,
} from "./__tests__/merged-trace-fixtures";
import {
  buildMergedTrace,
  MERGED_TRACE_IDLE_THRESHOLD_MS,
  mapTurnItemToTrace,
  parseSubagentCostUsd,
} from "./merged-trace";

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
  // PRD-522 R3.2 mutation-sanity guard: every session contributes exactly one
  // sessionstart to the merged trace, chronologically. Dropping a session (kind)
  // from the k-way merge fails this ordering/attribution assertion.
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

/**
 * ISS-8720. The span is the PAUSE, not the delta between two start instants: a
 * `tools` run occupies the trace until its `endMs`, so a marker sized
 * start-to-start prints wall time the reader spent watching tools run as time
 * nothing happened.
 */
describe("buildMergedTrace — idle spans measure from the previous item's end", () => {
  const TEN_MINUTES_S = 600;

  it("sizes the pause after a long tool run from its end, not its start", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Date.parse(iso(TEN_MINUTES_S)) }),
          sayTurn(TEN_MINUTES_S + 360),
        ],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    // 6 minutes of real pause, not the 16 minutes separating the two starts.
    expect(idle[0]).toMatchObject({ gapMs: 360_000 });
  });

  it("synthesizes nothing when the tool run leaves a sub-threshold pause", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Date.parse(iso(TEN_MINUTES_S)) }),
          // 11 minutes after the run STARTED — a 1-minute real pause.
          sayTurn(TEN_MINUTES_S + 60),
        ],
      }),
    ]);
    expect(trace.some((item) => item.type === "idle")).toBe(false);
  });

  it("measures start-to-start between point events, which have no extent", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [promptTurn(0), sayTurn(300)],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    // A prompt is an instant, so its end is its start and the whole 5 minutes
    // between the two really is a pause — no extent to subtract.
    expect(idle[0]).toMatchObject({ gapMs: 300_000 });
  });

  it("anchors the marker at the instant the pause began", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Date.parse(iso(TEN_MINUTES_S)) }),
          sayTurn(TEN_MINUTES_S + 360),
        ],
      }),
    ]);
    const idle = trace.find((item) => item.type === "idle");
    // The run's END, not its start: `t` + `gapMs` has to land on the next item,
    // or the marker describes an interval it does not span.
    expect(idle).toMatchObject({ t: iso(TEN_MINUTES_S) });
  });

  it("ignores a tool extent that ends before the run started", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(200),
        turnItems: [
          // An earlier item to out-rank, so the skewed run really is the last
          // thing active and the running max cannot cover for the floor.
          sayTurn(250),
          // Clock-skewed producer: `endMs` precedes `tMs`. Believing it would
          // rewind the trace and OVERSTATE the pause this change shortens.
          toolsTurn({ atSeconds: 300, endMs: Date.parse(iso(0)) }),
          sayTurn(600),
        ],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ gapMs: 300_000 });
  });

  it("ignores a non-finite tool extent rather than sizing the pause from it", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          // `endMs: last.tMs ?? Date.parse(last.t)` in the detail projection is
          // NaN for an unparseable source stamp, and the wire type says
          // `number`, so the boundary sees it even though callers cannot.
          toolsTurn({ atSeconds: 0, endMs: Number.NaN }),
          sayTurn(300),
        ],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ gapMs: 300_000 });
  });

  it("suppresses the marker when a tool run encloses the next item", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Date.parse(iso(TEN_MINUTES_S)) }),
          // Starts INSIDE the run: there is no pause between them at all.
          sayTurn(300),
        ],
      }),
    ]);
    expect(trace.some((item) => item.type === "idle")).toBe(false);
  });

  it("measures from the longest-running prior item, not the nearest one", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Date.parse(iso(TEN_MINUTES_S)) }),
          // Sorts AFTER the run's start and ends long before the run does, so
          // reading only the immediately previous item would report 12m40s.
          sayTurn(20),
          sayTurn(TEN_MINUTES_S + 180),
        ],
      }),
    ]);
    const idle = trace.filter((item) => item.type === "idle");
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ gapMs: 180_000 });
  });
});
