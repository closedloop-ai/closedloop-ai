import type { SyncedAgentSessionEvent } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { event } from "./agent-session-detail-projection.test-helpers.ts";
import { projectAgentSessionTimelineEvents } from "./agent-session-detail-projection.ts";

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
