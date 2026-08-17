import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { describe, expect, it } from "vitest";
import {
  BranchActorTurnSide,
  buildActorColorDomain,
} from "../branch-actor-domain";
import { mergedTraceToSessionTraceItems } from "../branch-merged-trace-adapter";

const items: MergedTraceItem[] = [
  {
    type: "sessionstart",
    sessionId: "s1",
    t: "2026-06-10T10:00:00.000Z",
    actor: { name: "alice", harness: "claude" },
  },
  {
    type: "prompt",
    sessionId: "s1",
    t: "2026-06-10T10:01:00.000Z",
    tMs: 1,
    cumCostUsd: 0.5,
    actorName: "alice",
    text: "hi",
  },
  {
    type: "say",
    sessionId: "s1",
    t: "2026-06-10T10:02:00.000Z",
    tMs: 2,
    cumCostUsd: 0.6,
    actorName: "alice",
    text: "hello",
  },
  {
    type: "tools",
    sessionId: "s1",
    t: "2026-06-10T10:03:00.000Z",
    tMs: 3,
    endMs: 4,
    summary: "Edited 2 files",
    hasFail: false,
    failN: 0,
  },
  {
    type: "event",
    sessionId: "s1",
    t: "2026-06-10T10:04:00.000Z",
    dot: "g",
    text: "Commit pushed",
  },
  { type: "end", sessionId: "s1", text: "done" },
];

describe("mergedTraceToSessionTraceItems", () => {
  const domain = buildActorColorDomain(["alice"]);
  const result = mergedTraceToSessionTraceItems(items, domain);

  it("preserves length and sets _row to the source index", () => {
    expect(result).toHaveLength(items.length);
    const prompt = result[1];
    const event = result[4];
    expect(prompt?.type === "prompt" && prompt._row).toBe(1);
    expect(event?.type === "event" && event._row).toBe(4);
  });

  it("maps prompt to the human side and say to the agent side", () => {
    const prompt = result[1];
    const say = result[2];
    // prompt → human actor (avatar name set); say → agent (human null).
    expect(prompt?.type === "prompt" && prompt.actor.human).toBe("alice");
    expect(say?.type === "say" && say.actor.human).toBeNull();
  });

  it("colors prompt and agent turns via the shared side-aware domain", () => {
    const prompt = result[1];
    const say = result[2];
    expect(prompt?.type === "prompt" && prompt.actor.color).toBe(
      domain.colorForTurn("alice", BranchActorTurnSide.Human)
    );
    expect(say?.type === "say" && say.actor.color).toBe(
      domain.colorForTurn("alice", BranchActorTurnSide.Agent)
    );
  });

  it("degrades tools to an empty per-tool list when the producer omits detail", () => {
    const tools = result[3];
    if (tools?.type !== "tools") {
      throw new Error("expected tools item");
    }
    expect(tools.summary).toBe("Edited 2 files");
    expect(tools.items).toEqual([]);
    expect(tools.cats).toEqual({});
    // tools/subagent inherit the session actor (no per-turn actorName).
    expect(tools.actor.name).toBe("alice");
  });

  it("carries per-tool rows through when the producer supplies them", () => {
    const withItems = mergedTraceToSessionTraceItems([
      {
        type: "tools",
        sessionId: "s1",
        t: "2026-06-10T10:03:00.000Z",
        tMs: 3,
        endMs: 4,
        summary: "Ran 2 tools · 1 read",
        hasFail: false,
        failN: 0,
        items: [
          { label: "Read", detail: "file.ts", err: false },
          { label: "Bash", detail: "ls", err: false },
        ],
      },
    ]);
    const tools = withItems[0];
    if (tools?.type !== "tools") {
      throw new Error("expected tools item");
    }
    expect(tools.items.map((i) => i.label)).toEqual(["Read", "Bash"]);
  });

  it("preserves per-call identity + truthful detailState through the adapter (FEA-3696)", () => {
    // The cross-surface adapter must not drop the callId/detailState the shared
    // projection stamps — the branch (cloud) trace renders the SAME truthful
    // states and stable identities as the session-detail (desktop) trace.
    const withStates = mergedTraceToSessionTraceItems([
      {
        type: "tools",
        sessionId: "s1",
        t: "2026-06-10T10:03:00.000Z",
        tMs: 3,
        endMs: 4,
        summary: "Ran 2 tools",
        hasFail: false,
        failN: 0,
        items: [
          {
            label: "mcp__figma__get",
            detail: "",
            err: false,
            callId: "mcp-1",
            detailState: "unavailable",
          },
          {
            label: "Bash",
            detail: "ls",
            err: false,
            callId: "fn-1",
            detailState: "available",
            input: "ls -la",
            output: "ok",
          },
        ],
      },
    ]);
    const tools = withStates[0];
    if (tools?.type !== "tools") {
      throw new Error("expected tools item");
    }
    expect(tools.items.map((i) => i.callId)).toEqual(["mcp-1", "fn-1"]);
    expect(tools.items.map((i) => i.detailState)).toEqual([
      "unavailable",
      "available",
    ]);
  });

  it("formats a sub-agent's carried costUsd onto the collapsed box's cost meta part (FEA-4178)", () => {
    const withSub = mergedTraceToSessionTraceItems([
      {
        type: "subagent",
        sessionId: "s1",
        t: "2026-06-10T10:05:00.000Z",
        tMs: 5,
        sub: "reviewer",
        model: "claude-opus-4-8",
        costUsd: 0.2,
      },
    ]);
    const sub = withSub[0];
    if (sub?.type !== "subagent") {
      throw new Error("expected subagent item");
    }
    // Parity with the single-session trace: cost shows, tokens/duration have no
    // per-sub-agent source in the merged trace so they stay null.
    expect(sub.cost).toBe("$0.20");
    expect(sub.tokens).toBeNull();
    expect(sub.duration).toBeNull();
  });

  it("renders a sub-cent sub-agent cost precisely and omits only a genuinely absent one (FEA-4178)", () => {
    // wongk review: a real sub-cent cost must render precisely (not floored to
    // "$0.00" or hidden) so it stays a DISTINCT state from "no data" (null cost).
    // Only a genuinely absent cost (`costUsd: null`, no attribution) yields null.
    const [subCent, absent] = mergedTraceToSessionTraceItems([
      {
        type: "subagent",
        sessionId: "s1",
        t: "2026-06-10T10:05:00.000Z",
        tMs: 5,
        sub: "reviewer",
        model: null,
        costUsd: 0.004,
      },
      {
        type: "subagent",
        sessionId: "s1",
        t: "2026-06-10T10:06:00.000Z",
        tMs: 6,
        sub: "builder",
        model: null,
        costUsd: null,
      },
    ]);
    if (subCent?.type !== "subagent" || absent?.type !== "subagent") {
      throw new Error("expected subagent items");
    }
    // Sub-cent value shows a nonzero figure via the precise formatter, not $0.00.
    expect(subCent.cost).toBe("$0.004");
    // Genuinely absent cost is the only null: the box drops the empty part.
    expect(absent.cost).toBeNull();
  });

  it("derives the event tMs from its timestamp", () => {
    const event = result[4];
    expect(event?.type === "event" && event.tMs).toBe(
      Date.parse("2026-06-10T10:04:00.000Z")
    );
  });

  it("maps end and sessionstart to their renderless/terminal shapes", () => {
    expect(result[0]?.type).toBe("sessionstart");
    const end = result[5];
    expect(end?.type === "end" && end.text).toBe("done");
  });
});
