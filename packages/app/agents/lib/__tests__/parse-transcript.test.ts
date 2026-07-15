import { describe, expect, it } from "vitest";
import {
  isCloudParseableHarness,
  parseTranscriptText,
} from "../parse-transcript";

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

describe("isCloudParseableHarness", () => {
  it("accepts the extracted harnesses and rejects the rest", () => {
    expect(isCloudParseableHarness("claude")).toBe(true);
    expect(isCloudParseableHarness("Codex")).toBe(true);
    expect(isCloudParseableHarness("cursor")).toBe(false);
    expect(isCloudParseableHarness("opencode")).toBe(false);
  });
});

describe("parseTranscriptText", () => {
  it("splits the string into lines and dispatches to the claude core", async () => {
    // Our wrapper's job: iterate lines — including a blank line and a final line
    // with no trailing newline — and hand them to the right harness core. Parser
    // internals (token/parse-quality accounting) are covered in @repo/lib.
    const text = `\n${USER_LINE}\n${ASSISTANT_LINE}`;
    const session = await parseTranscriptText({
      harness: "claude",
      sessionId: "s1",
      text,
    });

    expect(session?.messages.map((message) => message.role)).toEqual([
      "human",
      "assistant",
    ]);
  });

  it("returns null for a harness with no cloud parser", async () => {
    const session = await parseTranscriptText({
      harness: "cursor",
      sessionId: "s1",
      text: USER_LINE,
    });
    expect(session).toBeNull();
  });
});
