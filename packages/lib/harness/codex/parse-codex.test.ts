import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// The desktop suite exercises the Codex parser exhaustively through file I/O.
// These tests pin the browser entry point: it parses an in-memory line iterable
// (no fs, no env), derives the fresh-shape token totals (nonCached input, output
// + reasoning), and honors the no-timestamp null contract.

const LINES = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-09T12:00:00.000Z",
    payload: { cwd: "/home/me/proj", cli_version: "1.2.3" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-09T12:00:00.500Z",
    payload: { model: "gpt-5-codex" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-09T12:00:01.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-09T12:00:02.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hi" }],
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-09T12:00:03.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    },
  }),
];

describe("parseCodexRollout", () => {
  it("parses a minimal rollout and derives fresh-shape token totals", async () => {
    const session = await parseCodexRollout(LINES, { sessionId: "codex-sess" });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("codex-sess");
    expect(session?.entrypoint).toBe("codex");
    expect(session?.model).toBe("gpt-5-codex");
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
    // input = 100 total − 20 cached; output = 30 + 5 reasoning; cacheRead = 20.
    expect(session?.tokensByModel["gpt-5-codex"]).toMatchObject({
      input: 80,
      output: 35,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(session?.fileModifiedAt).toBeNull();
  });

  it("returns null when the rollout has no usable timestamp", async () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "no ts" }],
      },
    });
    expect(await parseCodexRollout([line], { sessionId: "s" })).toBeNull();
  });
});
