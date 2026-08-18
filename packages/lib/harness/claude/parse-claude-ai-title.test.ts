import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

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

describe("parseClaudeTranscript ai-title → name (FEA-3578)", () => {
  const aiTitle = (title: unknown) =>
    JSON.stringify({
      type: "ai-title",
      aiTitle: title,
      timestamp: "2026-07-09T12:00:03.000Z",
    });

  it("uses the ai-title as the session name over the cwd-derived name", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, aiTitle("Query session ID")],
      { sessionId: "test-session" }
    );
    expect(session?.name).toBe("Query session ID");
  });

  it("keeps the newest title when several ai-title records appear (last wins)", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        aiTitle("First guess"),
        ASSISTANT_LINE,
        aiTitle("Refined final title"),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.name).toBe("Refined final title");
  });

  it("trims the title and ignores blank/whitespace records", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, aiTitle("  Padded title  ")],
      { sessionId: "test-session" }
    );
    expect(session?.name).toBe("Padded title");
  });

  it("does not let a later blank title clobber a real one", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, aiTitle("Real title"), ASSISTANT_LINE, aiTitle("   ")],
      { sessionId: "test-session" }
    );
    expect(session?.name).toBe("Real title");
  });

  it("ignores a non-string aiTitle and falls back to the derived name", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, aiTitle(42)],
      { sessionId: "test-session" }
    );
    expect(session?.name).toBe("myproject - test-ses");
  });

  it("falls back to the cwd-derived name when no ai-title record exists", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "test-session",
    });
    expect(session?.name).toBe("myproject - test-ses");
  });
});
