import type { TurnItem } from "@repo/api/src/types/agent-session";
import {
  createNormalizedSession,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import { describe, expect, it } from "vitest";
import {
  buildTurnItemsFromNormalizedSession,
  type TranscriptActorContext,
} from "../transcript-turn-items";

const CONTEXT: TranscriptActorContext = {
  harness: "claude",
  primaryModel: "claude-opus-4-8",
  humanActor: { name: "Ada", color: "#abcdef" },
};

function build(overrides: Partial<NormalizedSession>): TurnItem[] {
  const session = createNormalizedSession({ sessionId: "s1", ...overrides });
  return buildTurnItemsFromNormalizedSession(session, CONTEXT);
}

function ofType<T extends TurnItem["type"]>(
  items: TurnItem[],
  type: T
): Extract<TurnItem, { type: T }>[] {
  return items.filter(
    (item): item is Extract<TurnItem, { type: T }> => item.type === type
  );
}

describe("buildTurnItemsFromNormalizedSession", () => {
  it("maps a human message to a prompt turn with the human actor", () => {
    const items = build({
      messages: [
        { role: "human", timestamp: "2026-07-09T10:00:00.000Z", text: "Do it" },
      ],
    });
    const prompts = ofType(items, "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe("Do it");
    expect(prompts[0].actor.human).toBe("Ada");
    expect(prompts[0].actor.color).toBe("#abcdef");
  });

  it("maps an assistant message to a say turn carrying model + thinking flag", () => {
    const items = build({
      messages: [
        {
          role: "assistant",
          timestamp: "2026-07-09T10:00:03.000Z",
          text: "Let me think",
          isThinking: true,
        },
        {
          role: "assistant",
          timestamp: "2026-07-09T10:00:05.000Z",
          text: "Done",
          model: "claude-opus-4-8",
        },
      ],
    });
    const says = ofType(items, "say");
    expect(says).toHaveLength(2);
    const [thinking, response] = says;
    expect(thinking.text).toBe("Let me think");
    expect(thinking.isThinking).toBe(true);
    expect(response.text).toBe("Done");
    expect(response.model).toBe("claude-opus-4-8");
  });

  it("drops messages without a timestamp", () => {
    const items = build({
      messages: [
        { role: "human", timestamp: null, text: "no time" },
        { role: "human", timestamp: "2026-07-09T10:00:00.000Z", text: "kept" },
      ],
    });
    expect(ofType(items, "prompt")).toHaveLength(1);
  });

  it("coalesces consecutive tool uses into one tools turn and flags errors", () => {
    const items = build({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2026-07-09T10:00:06.000Z",
          input: { command: "ls -a" },
          id: "toolu_1",
        },
        {
          name: "Read",
          timestamp: "2026-07-09T10:00:07.000Z",
          input: { file_path: "/tmp/a.ts" },
          isError: true,
          id: "toolu_2",
        },
      ],
    });
    const tools = ofType(items, "tools");
    expect(tools).toHaveLength(1);
    expect(tools[0].items).toHaveLength(2);
    expect(tools[0].items.map((tool) => tool.label)).toEqual(["Bash", "Read"]);
    expect(tools[0].hasFail).toBe(true);
    expect(tools[0].failN).toBe(1);
    // Bash command + Read file path are surfaced in the coalesced tool details.
    expect(tools[0].items[0].detail).toContain("ls -a");
    expect(tools[0].items[1].detail).toContain("/tmp/a.ts");
  });

  it("projects a subagent turn and links its tool without double-counting", () => {
    // parse-claude pushes a subagent tool into BOTH `session.toolUses` (tagged
    // with subagentId) and `subagents[].toolUses`. The adapter must source events
    // only from `session.toolUses`, so the tool appears once (in the tools turn
    // and folded into the subagent body), never twice.
    const subagentTool = {
      name: "Grep",
      timestamp: "2026-07-09T10:00:08.000Z",
      input: { pattern: "needle" },
      id: "toolu_3",
      subagentId: "sub-1",
    };
    const items = build({
      toolUses: [subagentTool],
      subagents: [
        {
          id: "sub-1",
          name: "explorer",
          type: "Explore",
          status: "completed",
          task: "search the tree",
          startedAt: "2026-07-09T10:00:07.500Z",
          endedAt: "2026-07-09T10:00:09.000Z",
          toolUses: [subagentTool],
        },
      ],
    });

    const subagents = ofType(items, "subagent");
    expect(subagents).toHaveLength(1);
    expect(subagents[0].sub).toBe("explorer");
    expect(subagents[0].subagentType).toBe("Explore");
    expect(subagents[0].status).toBe("completed");
    expect(subagents[0].body.some((line) => line.kind === "task")).toBe(true);
    expect(subagents[0].body.some((line) => line.text === "Grep")).toBe(true);

    // The Grep tool is present exactly once across the tools turns.
    const toolLabels = ofType(items, "tools").flatMap((turn) =>
      turn.items.map((tool) => tool.label)
    );
    expect(toolLabels.filter((label) => label === "Grep")).toHaveLength(1);
  });

  it("orders turns by timestamp across message and tool kinds", () => {
    const items = build({
      messages: [
        { role: "human", timestamp: "2026-07-09T10:00:00.000Z", text: "go" },
        {
          role: "assistant",
          timestamp: "2026-07-09T10:00:05.000Z",
          text: "reply",
        },
      ],
      toolUses: [
        {
          name: "Bash",
          timestamp: "2026-07-09T10:00:02.000Z",
          input: { command: "pwd" },
          id: "toolu_1",
        },
      ],
    });
    const order = items
      .filter(
        (
          item
        ): item is Extract<TurnItem, { type: "prompt" | "say" | "tools" }> =>
          item.type === "prompt" || item.type === "say" || item.type === "tools"
      )
      .map((item) => item.type);
    expect(order).toEqual(["prompt", "tools", "say"]);
  });
});
