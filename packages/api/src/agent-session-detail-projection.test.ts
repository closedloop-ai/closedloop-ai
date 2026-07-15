import { describe, expect, it } from "vitest";
import {
  deriveAgentSessionFallbackState,
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "./agent-session-detail-projection.ts";
import type {
  SessionTimelineEvent,
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "./types/agent-session.ts";

function event(
  overrides: Partial<SyncedAgentSessionEvent> &
    Pick<SyncedAgentSessionEvent, "externalEventId" | "eventType" | "createdAt">
): SyncedAgentSessionEvent {
  return { ...overrides };
}

function agent(
  overrides: Partial<SyncedAgentSessionAgent> &
    Pick<
      SyncedAgentSessionAgent,
      "externalAgentId" | "name" | "type" | "status"
    >
): SyncedAgentSessionAgent {
  return { ...overrides };
}

describe("projectAgentSessionTimelineEvents", () => {
  it("merges metadata messages with events and assigns sequential tl indices by time", () => {
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "e1",
        eventType: "tool_use",
        toolName: "Bash",
        summary: "ls -la",
        createdAt: "2026-06-17T00:00:01.000Z",
      }),
      event({
        externalEventId: "e2",
        eventType: "git_commit",
        createdAt: "2026-06-17T00:00:04.000Z",
      }),
      event({
        externalEventId: "e3",
        eventType: "error_thrown",
        createdAt: "2026-06-17T00:00:05.000Z",
      }),
    ];
    const metadata = {
      messages: [
        {
          role: "human",
          timestamp: "2026-06-17T00:00:00.000Z",
          text: "Do the thing",
        },
        {
          role: "assistant",
          timestamp: "2026-06-17T00:00:02.000Z",
          text: "Let me think",
          isThinking: true,
        },
        {
          role: "assistant",
          timestamp: "2026-06-17T00:00:03.000Z",
          text: "Done",
          model: "claude-opus",
        },
      ],
    };

    const rows = projectAgentSessionTimelineEvents(events, { metadata });

    expect(rows.map((row) => [row.tl, row.kind, row.title])).toEqual([
      [0, "human", "human"],
      [1, "tool", "Bash"],
      [2, "say", "Reasoning"],
      [3, "say", "claude-opus"],
      [4, "event", "git_commit"],
      [5, "event", "error_thrown"],
    ]);

    const reasoningRow = rows[2]!;
    expect(reasoningRow.isThinking).toBe(true);
    expect(reasoningRow.detail).toBe("Let me think");

    const answerRow = rows[3]!;
    expect(answerRow.isThinking).toBeUndefined();
    expect(answerRow.model).toBe("claude-opus");
    expect(answerRow.detail).toBe("Done");

    const human = rows[0]!;
    expect(human.who).toBe("human");
    expect(human.detail).toBe("Do the thing");

    const toolRow = rows[1]!;
    expect(toolRow.detail).toBe("ls -la");

    const gitRow = rows[4]!;
    expect(gitRow.git).toBe(true);

    const errorRow = rows[5]!;
    expect(errorRow.err).toBe(true);
  });

  it("breaks timestamp ties by kind order (human before say before tool)", () => {
    const sharedTimestamp = "2026-06-17T00:00:00.000Z";
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "e1",
        eventType: "tool_use",
        toolName: "Read",
        createdAt: sharedTimestamp,
      }),
    ];
    const metadata = {
      messages: [
        { role: "assistant", timestamp: sharedTimestamp, text: "answer" },
        { role: "human", timestamp: sharedTimestamp, text: "question" },
      ],
    };

    const rows = projectAgentSessionTimelineEvents(events, { metadata });

    expect(rows.map((row) => row.kind)).toEqual(["human", "say", "tool"]);
  });

  it("derives event kind from event type and tool name", () => {
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "t",
        eventType: "anything",
        toolName: "Bash",
        createdAt: "2026-06-17T00:00:00.000Z",
      }),
      event({
        externalEventId: "h",
        eventType: "human_prompt",
        createdAt: "2026-06-17T00:00:01.000Z",
      }),
      event({
        externalEventId: "r",
        eventType: "tool_result",
        createdAt: "2026-06-17T00:00:02.000Z",
      }),
      event({
        externalEventId: "m",
        eventType: "mcp_call",
        createdAt: "2026-06-17T00:00:03.000Z",
      }),
      event({
        externalEventId: "ed",
        eventType: "file_edit",
        createdAt: "2026-06-17T00:00:04.000Z",
      }),
      event({
        externalEventId: "o",
        eventType: "other",
        createdAt: "2026-06-17T00:00:05.000Z",
      }),
    ];

    const rows = projectAgentSessionTimelineEvents(events);

    expect(rows.map((row) => row.kind)).toEqual([
      "tool",
      "human",
      "result",
      "mcp",
      "edit",
      "event",
    ]);
  });

  it("builds detail from data fields and diff deltas when no summary is present", () => {
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "e1",
        eventType: "file_edit",
        createdAt: "2026-06-17T00:00:00.000Z",
        data: {
          file_path: "src/index.ts",
          diffDelta: { add: 3, del: 1 },
        },
      }),
    ];

    const [row] = projectAgentSessionTimelineEvents(events);

    expect(row?.detail).toBe("src/index.ts · +3/-1");
  });

  it("flags Stop/SubagentStop hooks as boundary rows from the raw event type", () => {
    const rows = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "stop",
        eventType: "Stop",
        createdAt: "2026-06-18T12:00:00.000Z",
      }),
      event({
        externalEventId: "subagent-stop",
        eventType: "SubagentStop",
        createdAt: "2026-06-18T12:00:01.000Z",
      }),
      event({
        externalEventId: "session-end",
        eventType: "SessionEnd",
        createdAt: "2026-06-18T12:00:02.000Z",
      }),
    ]);

    expect(rows.map((row) => row.isBoundary)).toEqual([true, true, undefined]);
  });

  it("deduplicates equivalent snake_case and camelCase path details", () => {
    const [row] = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "path-casing",
        eventType: "PostToolUse",
        toolName: "Read",
        createdAt: "2026-06-18T12:00:00.000Z",
        data: {
          file_path: "src/app.ts",
          filePath: "src/app.ts",
          command: "cat src/app.ts",
        },
      }),
    ]);

    expect(row?.detail).toBe("src/app.ts · cat src/app.ts");
  });

  it("renders repeated exec_command rows with distinct command details", () => {
    const timeline = projectAgentSessionTimelineEvents([
      event({
        externalEventId: "command-a",
        eventType: "PostToolUse",
        toolName: "exec_command",
        createdAt: "2026-06-18T12:00:00.000Z",
        data: { command: "pnpm -C packages/api test" },
      }),
      event({
        externalEventId: "command-b",
        eventType: "PostToolUse",
        toolName: "exec_command",
        createdAt: "2026-06-18T12:00:01.000Z",
        data: {
          executable: "git",
          arguments: ["diff", "--stat"],
        },
      }),
      event({
        externalEventId: "command-c",
        eventType: "PostToolUse",
        toolName: "exec_command",
        createdAt: "2026-06-18T12:00:02.000Z",
        data: {
          tool_input: {
            command: "docker exec postgres16 psql",
          },
          tool_response: {
            exitCode: 0,
          },
        },
      }),
      event({
        externalEventId: "command-d",
        eventType: "PostToolUse",
        toolName: "exec_command",
        createdAt: "2026-06-18T12:00:03.000Z",
        data: {
          tool_input: {
            command: "pnpm lint",
          },
          tool_response: {
            exit_code: 1,
          },
        },
      }),
    ]);

    expect(timeline.map((event) => [event.title, event.detail])).toEqual([
      ["exec_command", "pnpm -C packages/api test"],
      ["exec_command", "git diff --stat"],
      ["exec_command", "docker exec postgres16 psql · exit 0"],
      ["exec_command", "pnpm lint · exit 1"],
    ]);
  });

  it("keeps existing metadata fields available while deriving detail text", () => {
    const source = event({
      externalEventId: "read-1",
      eventType: "PostToolUse",
      toolName: "Read",
      summary: "opened src/app.ts",
      createdAt: "2026-06-18T12:00:00.000Z",
      data: {
        filePath: "src/app.ts",
        command: "cat src/app.ts",
        stdout: "file contents remain on the event payload",
        nested: { visible: "yes" },
      },
    });
    const timeline = projectAgentSessionTimelineEvents([source]);

    expect(timeline[0]?.detail).toBe("opened src/app.ts");
    expect(source.data).toEqual({
      filePath: "src/app.ts",
      command: "cat src/app.ts",
      stdout: "file contents remain on the event payload",
      nested: { visible: "yes" },
    });
  });

  it("drops metadata messages without a usable role or timestamp", () => {
    const metadata = {
      messages: [
        { role: "human", text: "no timestamp" },
        {
          role: "robot",
          timestamp: "2026-06-17T00:00:00.000Z",
          text: "bad role",
        },
        {
          role: "human",
          timestamp: "2026-06-17T00:00:01.000Z",
          text: "kept",
        },
      ],
    };

    const rows = projectAgentSessionTimelineEvents([], { metadata });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe("kept");
  });

  it("returns an empty timeline when metadata is not an object", () => {
    expect(projectAgentSessionTimelineEvents([], { metadata: "nope" })).toEqual(
      []
    );
  });
});

describe("projectAgentSessionTurnItems", () => {
  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    events: [] as SyncedAgentSessionEvent[],
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  it("coalesces consecutive tool-like events into a single tools turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      { t: "t1", tMs: 1000, kind: "tool", title: "Bash", detail: "ls", tl: 1 },
      {
        t: "t2",
        tMs: 2000,
        kind: "tool",
        title: "Read",
        detail: "file",
        tl: 2,
      },
      {
        t: "t3",
        tMs: 3000,
        kind: "edit",
        title: "Edit",
        detail: "patch",
        err: true,
        tl: 3,
      },
      {
        t: "t4",
        tMs: 4000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 4,
      },
      {
        t: "t5",
        tMs: 5000,
        kind: "event",
        title: "note",
        detail: "thing",
        git: true,
        tl: 5,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual([
      "prompt",
      "tools",
      "say",
      "event",
    ]);

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.text).toBe("Question");
    expect(prompt.actor.human).toBe("Ada");

    const tools = items[1]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }
    expect(tools.items).toHaveLength(3);
    expect(tools.cats).toEqual({ bash: 1, read: 1, tool: 1 });
    expect(tools.failN).toBe(1);
    expect(tools.hasFail).toBe(true);
    expect(tools.defaultOpen).toBe(true);
    expect(tools.summary).toBe("Ran 3 tools · 1 bash · 1 read · 1 tool");
    expect(tools.tMs).toBe(1000);
    expect(tools.endMs).toBe(3000);

    const event = items[3]!;
    if (event.type !== "event") {
      throw new Error("expected event turn");
    }
    expect(event.dot).toBe("g");
    expect(event.text).toBe("thing");
  });

  it("drops Stop/SubagentStop turn-boundary markers but keeps session lifecycle rows", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "event",
        title: "SessionStart",
        detail: "SessionStart",
        tl: 0,
      },
      { t: "t1", tMs: 1000, kind: "tool", title: "Read", detail: "a", tl: 1 },
      {
        t: "t2",
        tMs: 2000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 2,
      },
      {
        t: "t3",
        tMs: 3000,
        kind: "event",
        title: "SubagentStop",
        isBoundary: true,
        tl: 3,
      },
      {
        t: "t4",
        tMs: 4000,
        kind: "event",
        title: "SessionEnd",
        detail: "SessionEnd",
        tl: 4,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual(["event", "tools", "event"]);
    const texts = items
      .filter((item) => item.type === "event")
      .map((item) => (item.type === "event" ? item.text : ""));
    expect(texts).toEqual(["SessionStart", "SessionEnd"]);
  });

  it("coalesces tool runs separated only by a Stop marker into one tools turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "tool", title: "Read", detail: "a", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 1,
      },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
      {
        t: "t3",
        tMs: 3000,
        kind: "event",
        title: "Stop",
        isBoundary: true,
        tl: 3,
      },
      { t: "t4", tMs: 4000, kind: "tool", title: "Grep", detail: "x", tl: 4 },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    expect(items.map((item) => item.type)).toEqual(["tools"]);
    const tools = items[0]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }
    expect(tools.items).toHaveLength(3);
    expect(tools.summary).toBe("Ran 3 tools · 1 bash · 1 read · 1 tool");
    expect(tools.tMs).toBe(0);
    expect(tools.endMs).toBe(4000);
  });

  it("carries model and reasoning flags onto say turns without leaking labels into text", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "say",
        title: "Reasoning",
        isThinking: true,
        tl: 0,
      },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "claude-opus",
        model: "claude-opus",
        detail: "All done",
        tl: 1,
      },
      {
        t: "t2",
        tMs: 2000,
        kind: "say",
        title: "claude-opus",
        model: "claude-opus",
        tl: 2,
      },
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const says = items.filter((item) => item.type === "say");
    expect(
      says.map((item) => [item.text, item.isThinking, item.model])
    ).toEqual([
      // Redacted reasoning: empty text, flagged as thinking.
      ["", true, undefined],
      // Response text keeps its body and carries the model caption.
      ["All done", undefined, "claude-opus"],
      // Text-less model marker no longer falls back to the model label.
      ["", undefined, "claude-opus"],
    ]);
  });

  it("projects subagents with duration, token, and cost formatting after timeline rows", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "say", title: "opus", detail: "hi", tl: 0 },
    ];
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        task: "Find usages",
        currentTool: "Grep",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:30.000Z",
      }),
      agent({
        externalAgentId: "main",
        name: "main",
        type: "primary",
        status: "running",
      }),
    ];
    const tokenUsageByModel: SyncedAgentSessionTokenUsage[] = [
      {
        model: "claude-opus",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
        estimatedCostUsd: 1.5,
      },
    ];
    const events: SyncedAgentSessionEvent[] = [
      event({
        externalEventId: "ev-1",
        agentExternalId: "sub-1",
        eventType: "tool_use",
        toolName: "Grep",
        createdAt: "2026-06-17T00:00:10.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents,
      events,
      tokenUsageByModel,
    });

    const subagents = items.filter((item) => item.type === "subagent");
    expect(subagents).toHaveLength(1);
    const sub = subagents[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.sub).toBe("Explorer");
    expect(sub.subagentType).toBe("Explore");
    expect(sub.duration).toBe("1m 30s");
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
    expect(sub.body.map((line) => [line.kind, line.text])).toEqual([
      ["task", "Find usages"],
      ["tool", "Grep"],
      ["tool", "Grep"],
      ["status", "completed"],
    ]);
    // Subagents sort after the timeline-derived turns.
    expect(items.at(-1)).toBe(sub);
  });

  it("emits null duration, tokens, and cost when data is missing or inconsistent", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "NoTiming",
        type: "subagent",
        subagentType: "Explore",
        status: "running",
        // endedAt precedes startedAt → duration is rejected.
        startedAt: "2026-06-17T00:01:00.000Z",
        endedAt: "2026-06-17T00:00:00.000Z",
      }),
    ];

    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.duration).toBeNull();
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
  });
});

describe("projectAgentSessionTurnItems — cost attribution", () => {
  const baseInput = {
    sessionId: "sess-1",
    harness: "claude-code",
    primaryModel: "claude-opus",
    humanActor: { name: "Ada", color: "var(--human)" },
    events: [] as SyncedAgentSessionEvent[],
    tokenUsageByModel: [] as SyncedAgentSessionTokenUsage[],
  };

  it("attributes a token event before the first cost-bearing turn to the first turn", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 1000,
        kind: "human",
        title: "Q",
        detail: "Question",
        tl: 0,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 500, costUsd: 0.01 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0.01);
    expect(prompt.cum).toBe(0.01);
  });

  it("attributes a token event between a prompt and agent turn to the agent turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 2000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 1000, costUsd: 0.05 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(say.costDelta).toBe(0.05);
  });

  it("attributes a token event whose tMs matches a turn's tMs to that turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 1000, costUsd: 0.02 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(say.costDelta).toBe(0.02);
  });

  it("attributes a token event after the last turn to the last cost-bearing turn", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 5000, costUsd: 0.03 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0.03);
    expect(prompt.cum).toBe(0.03);
  });

  it("sum of all costDelta equals the sum of input costUsd", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      {
        t: "t1",
        tMs: 1000,
        kind: "say",
        title: "opus",
        detail: "Answer",
        tl: 1,
      },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
    ];
    const tokenEvents = [
      { tMs: 500, costUsd: 0.01 },
      { tMs: 1500, costUsd: 0.02 },
      { tMs: 2500, costUsd: 0.03 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents,
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    const tools = items[2]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }

    const totalDelta =
      (prompt.costDelta ?? 0) + (say.costDelta ?? 0) + (tools.costDelta ?? 0);
    const totalInput = tokenEvents.reduce((sum, e) => sum + e.costUsd, 0);
    expect(totalDelta).toBeCloseTo(totalInput, 10);
  });

  it("cum is monotonically non-decreasing across cost-bearing turns", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
      { t: "t1", tMs: 1000, kind: "say", title: "opus", detail: "A", tl: 1 },
      { t: "t2", tMs: 2000, kind: "tool", title: "Bash", detail: "ls", tl: 2 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [
        { tMs: 500, costUsd: 0.01 },
        { tMs: 1500, costUsd: 0.02 },
        { tMs: 2500, costUsd: 0.03 },
      ],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    const say = items[1]!;
    if (say.type !== "say") {
      throw new Error("expected say turn");
    }
    const tools = items[2]!;
    if (tools.type !== "tools") {
      throw new Error("expected tools turn");
    }

    expect(prompt.cum).toBeLessThanOrEqual(say.cum);
    expect(say.cum).toBeLessThanOrEqual(tools.cum);
  });

  it("a zero-cost token event contributes 0 to costDelta", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [{ tMs: 500, costUsd: 0 }],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBe(0);
    expect(prompt.cum).toBe(0);
  });

  it("leaves costDelta undefined and cum at 0 when tokenEvents is not provided", () => {
    const timeline: SessionTimelineEvent[] = [
      { t: "t0", tMs: 0, kind: "human", title: "Q", detail: "Question", tl: 0 },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
    });

    const prompt = items[0]!;
    if (prompt.type !== "prompt") {
      throw new Error("expected prompt turn");
    }
    expect(prompt.costDelta).toBeUndefined();
    expect(prompt.cum).toBe(0);
  });

  it("leaves subagent tokens and cost null rather than deriving session totals", () => {
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
    });

    const sub = items[0]!;
    if (sub.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    expect(sub.tokens).toBeNull();
    expect(sub.cost).toBeNull();
  });

  it("does not throw when there are no cost-bearing turns and tokenEvents is non-empty", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        t: "t0",
        tMs: 0,
        kind: "event",
        title: "SessionStart",
        detail: "SessionStart",
        tl: 0,
      },
    ];
    expect(() =>
      projectAgentSessionTurnItems({
        ...baseInput,
        timeline,
        agents: [],
        tokenEvents: [{ tMs: 500, costUsd: 0.01 }],
      })
    ).not.toThrow();
  });

  it("attributes cost events to each of multiple subagent turns based on their tMs window", () => {
    const sub1Start = Date.parse("2026-06-17T00:00:00.000Z");
    const agents: SyncedAgentSessionAgent[] = [
      agent({
        externalAgentId: "sub-1",
        name: "Explorer",
        type: "subagent",
        subagentType: "Explore",
        status: "completed",
        startedAt: "2026-06-17T00:00:00.000Z",
      }),
      agent({
        externalAgentId: "sub-2",
        name: "Builder",
        type: "subagent",
        subagentType: "Build",
        status: "completed",
        startedAt: "2026-06-17T00:01:00.000Z",
      }),
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline: [],
      agents,
      tokenEvents: [
        { tMs: sub1Start + 30_000, costUsd: 0.1 },
        { tMs: sub1Start + 90_000, costUsd: 0.2 },
      ],
    });

    const sub1 = items[0]!;
    if (sub1.type !== "subagent") {
      throw new Error("expected subagent turn");
    }
    const sub2 = items[1]!;
    if (sub2.type !== "subagent") {
      throw new Error("expected subagent turn");
    }

    expect(sub1.costDelta).toBe(0.1);
    expect(sub2.costDelta).toBe(0.2);
    expect(sub2.cum).toBeCloseTo(0.3, 10);
  });

  it("ignores token events with NaN tMs", () => {
    const timeline: SessionTimelineEvent[] = [
      {
        tl: 0,
        t: "2026-01-01T00:01:00.000Z",
        tMs: Date.parse("2026-01-01T00:01:00.000Z"),
        kind: "say",
        title: "say",
      },
    ];
    const items = projectAgentSessionTurnItems({
      ...baseInput,
      timeline,
      agents: [],
      tokenEvents: [
        { tMs: Number.NaN, costUsd: 0.5 },
        { tMs: Date.parse("2026-01-01T00:02:00.000Z"), costUsd: 0.1 },
      ],
    });
    const say = items.find((item) => item.type === "say");
    if (say?.type !== "say") {
      throw new Error("expected say turn");
    }
    expect(say.costDelta).toBe(0.1);
    expect(say.cum).toBe(0.1);
  });
});

describe("deriveAgentSessionFallbackState", () => {
  it("returns Completed for completed status regardless of case", () => {
    expect(deriveAgentSessionFallbackState({ status: "COMPLETED" })).toBe(
      "COMPLETED"
    );
  });

  it("returns Blocked for terminal failure statuses", () => {
    for (const status of ["abandoned", "error", "failed"]) {
      expect(deriveAgentSessionFallbackState({ status })).toBe("BLOCKED");
    }
  });

  it("returns PendingApproval when awaiting input and not ended", () => {
    expect(
      deriveAgentSessionFallbackState({
        status: "active",
        awaitingInputSince: "2026-06-17T00:00:00.000Z",
      })
    ).toBe("PENDING_APPROVAL");
  });

  it("treats an ended-but-uncanonicalized session as Completed", () => {
    expect(
      deriveAgentSessionFallbackState({
        status: "active",
        awaitingInputSince: "2026-06-17T00:00:00.000Z",
        endedAt: "2026-06-17T00:05:00.000Z",
      })
    ).toBe("COMPLETED");
  });

  it("falls back to Running for an active session with no terminal signals", () => {
    expect(deriveAgentSessionFallbackState({ status: "active" })).toBe(
      "RUNNING"
    );
  });
});
