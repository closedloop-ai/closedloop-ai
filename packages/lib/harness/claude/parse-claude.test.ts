import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude";

// The desktop suite exercises the Claude parser exhaustively through file I/O.
// These tests pin the browser entry point itself: it parses an in-memory line
// iterable (no fs), honors the no-timestamp null contract, tolerates junk lines,
// and leaves `fileModifiedAt` for the desktop shell to stamp.

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/myproject",
  message: { role: "user", content: "hello" },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "hi there" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  },
});

describe("parseClaudeTranscript", () => {
  it("parses a minimal transcript from an in-memory line iterable", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "test-session",
    });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("test-session");
    expect(session?.model).toBe("claude-opus-4");
    expect(session?.userMessages).toBe(1);
    // One deduped API turn.
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["claude-opus-4"]).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
    });
    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    expect(session?.startedAt).toBe("2026-07-09T12:00:00.000Z");
    // The core never touches the filesystem; the desktop shell stamps mtime.
    expect(session?.fileModifiedAt).toBeNull();
    expect(session?.subagents).toEqual([]);
  });

  it("returns null when the transcript has no usable timestamp", async () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "no timestamp here" },
    });
    expect(await parseClaudeTranscript([line], { sessionId: "s" })).toBeNull();
  });

  it("skips blank, malformed, and partial trailing lines", async () => {
    const lines = ["", "not-json", "{partial", USER_LINE, ASSISTANT_LINE, "  "];
    const session = await parseClaudeTranscript(lines, { sessionId: "s" });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
  });

  it("accepts an async iterable of lines", async () => {
    // Mimics a streamed fetch: each line arrives across an await boundary.
    async function* gen(): AsyncGenerator<string> {
      for (const line of [USER_LINE, ASSISTANT_LINE]) {
        await Promise.resolve();
        yield line;
      }
    }
    const session = await parseClaudeTranscript(gen(), { sessionId: "s" });
    expect(session?.assistantMessages).toBe(1);
  });
});
