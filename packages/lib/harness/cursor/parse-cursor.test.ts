import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "./parse-cursor";

// The desktop suite exercises the Cursor parser through file I/O; these tests pin
// the extracted browser-safe core (FEA-3710). It parses an in-memory line iterable
// (no fs, no path), reads Cursor's fresh-shape token counts verbatim, derives the
// project name from the cwd basename, and honors the no-timestamp null contract —
// exactly as the desktop shell invokes it today (and as a future cloud renderer
// will once Cursor is routed through this core).

const LINES = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-09T12:00:00.000Z",
    payload: {
      cwd: "/workspace/my-project",
      cursor_version: "0.42.0",
      git: { branch: "feature/x" },
    },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-09T12:00:00.500Z",
    payload: { model: "claude-sonnet-4-6" },
  }),
  JSON.stringify({
    type: "user_message",
    timestamp: "2026-07-09T12:00:01.000Z",
    payload: { content: "please refactor this" },
  }),
  JSON.stringify({
    type: "tool_call",
    timestamp: "2026-07-09T12:00:01.500Z",
    payload: { name: "Edit", arguments: { file: "a.ts" } },
  }),
  JSON.stringify({
    type: "tool_result",
    timestamp: "2026-07-09T12:00:01.800Z",
    payload: { output: "done", is_error: false },
  }),
  JSON.stringify({
    type: "assistant_message",
    timestamp: "2026-07-09T12:00:02.000Z",
    payload: { content: "refactored" },
  }),
  JSON.stringify({
    type: "token_count",
    timestamp: "2026-07-09T12:00:02.500Z",
    payload: {
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
    },
  }),
];

describe("parseCursorTranscript (browser-safe core)", () => {
  it("parses a representative Cursor transcript into a NormalizedSession", async () => {
    const session = await parseCursorTranscript(LINES, {
      sessionId: "cursor-sess",
    });
    expect(session).not.toBeNull();
    if (!session) {
      return;
    }

    expect(session.sessionId).toBe("cursor-sess");
    expect(session.entrypoint).toBe("cursor");
    // Project name is the cwd basename, computed with the shared browser-safe
    // baseName (no node:path) so desktop and cloud agree.
    expect(session.name).toBe("my-project");
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.gitBranch).toBe("feature/x");
    expect(session.version).toBe("0.42.0");
    expect(session.startedAt).toBe("2026-07-09T12:00:00.000Z");
    expect(session.endedAt).toBe("2026-07-09T12:00:02.500Z");
    expect(session.userMessages).toBe(1);
    expect(session.assistantMessages).toBe(1);
  });

  it("reads Cursor's fresh-shape token counts verbatim (no subtraction)", async () => {
    const session = await parseCursorTranscript(LINES, {
      sessionId: "cursor-sess",
    });
    expect(session?.tokensByModel).toEqual({
      "claude-sonnet-4-6": {
        input: 100,
        output: 40,
        cacheRead: 10,
        cacheWrite: 5,
      },
    });
    expect(session?.tokenSeries).toHaveLength(1);
    expect(session?.tokenSeries[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
    });
  });

  it("attaches tool output to the most recent tool use", async () => {
    const session = await parseCursorTranscript(LINES, {
      sessionId: "cursor-sess",
    });
    expect(session?.toolUses).toHaveLength(1);
    expect(session?.toolUses[0]).toMatchObject({
      name: "Edit",
      output: "done",
    });
    expect(session?.toolUses[0].isError).toBeUndefined();
  });

  it("records a tool result error and flags the tool use", async () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "tool_call",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: { name: "Bash", arguments: { command: "ls" } },
      }),
      JSON.stringify({
        type: "tool_result",
        timestamp: "2026-07-09T12:00:01.500Z",
        payload: { output: "boom", exit_code: 1 },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "cursor-err",
    });
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolResultErrors[0]).toMatchObject({ content: "boom" });
    expect(session?.toolUses[0].isError).toBe(true);
  });

  it("falls back to a synthetic project name when cwd is absent", async () => {
    const lines = [
      JSON.stringify({
        type: "user_message",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "abcdef012345",
    });
    expect(session?.name).toBe("Cursor Session abcdef01");
  });

  it("returns null when the transcript carries no usable timestamp", async () => {
    const lines = [JSON.stringify({ type: "user_message", payload: {} })];
    const session = await parseCursorTranscript(lines, {
      sessionId: "no-ts",
    });
    expect(session).toBeNull();
  });

  it("tolerates malformed lines and unknown event types", async () => {
    const lines = [
      "not json at all",
      "",
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "__proto__",
        timestamp: "2026-07-09T12:00:00.100Z",
      }),
      JSON.stringify({ type: "some_future_event", timestamp: "x" }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "cursor-tolerant",
    });
    expect(session).not.toBeNull();
    expect(session?.name).toBe("proj");
  });
});
