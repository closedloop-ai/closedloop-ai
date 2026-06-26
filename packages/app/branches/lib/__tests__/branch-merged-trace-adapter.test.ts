import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { buildActorColorDomain } from "../branch-actor-domain";
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

  it("colors actors via the shared domain", () => {
    const say = result[2];
    expect(say?.type === "say" && say.actor.color).toBe(
      domain.colorFor("alice")
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
