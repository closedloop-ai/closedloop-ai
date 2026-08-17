/**
 * Tests for content/message handling branches in parse-codex.ts.
 *
 * Targets uncovered branches in:
 *  - extractText() (called indirectly via message items):
 *    Branches 25[0] (string content), 26[0] (non-array), 27[0] (null array item),
 *    28[0] (string array item), 29[0] (non-record array item), 30[1] (block.text
 *    not a string), 31[0-1] (else-if condition), 32[0-3] (type sub-conditions)
 *  - handleMessageItem:
 *    Branch 44[1,2] (role fallback: p.author), 49[0] (user message no explicitIso),
 *    51[1] (assistant message, no iso), 52[0]/53 (proposed plan extraction),
 *    55[1]/56[0] (isSyntheticModelKey on assistant), 61/62 (no currentTurnModel)
 *  - handleReasoningItem:
 *    Branch 58[0-3] (text/summary fallback chain), 59[0-1], 60[0-1], 61[0-1], 62[0-1]
 */

import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// ── Shared builders ─────────────────────────────────────────────────────────

const SESSION_META = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-08-01T10:00:00.000Z",
  payload: { cwd: "/workspace/proj" },
});

const TURN_CONTEXT = (model: string) =>
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T10:00:01.000Z",
    payload: { model },
  });

function msgItem(
  role: string,
  content: unknown,
  ts = "2026-08-01T10:00:02.000Z"
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: { type: "message", role, content },
  });
}

function msgItemWithAuthor(
  author: string,
  content: unknown,
  ts = "2026-08-01T10:00:02.000Z"
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: { type: "message", author, content },
  });
}

function reasoningItem(
  contentOrFields: unknown,
  ts = "2026-08-01T10:00:03.000Z"
): string {
  const payload =
    typeof contentOrFields === "object" && contentOrFields !== null
      ? { type: "reasoning", ...contentOrFields }
      : { type: "reasoning", content: contentOrFields };
  return JSON.stringify({ type: "response_item", timestamp: ts, payload });
}

function tokenCount(ts = "2026-08-01T10:00:10.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
        },
      },
    },
  });
}

// ── extractText via string content (Branch 25[0]) ────────────────────────────

describe("extractText — string content (Branch 25[0])", () => {
  it("extracts a plain string content directly from a user message", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5-codex"),
      msgItem("user", "hello world"),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "str-content",
    });
    expect(session?.messages[0]?.text).toBe("hello world");
  });

  it("extracts a plain string content from an assistant message", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5-codex"),
      msgItem("assistant", "the answer"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "str-asst" });
    expect(session?.messages[0]?.text).toBe("the answer");
  });
});

// ── extractText — non-array, non-string content (Branch 26[0]) ──────────────

describe("extractText — non-string, non-array content returns empty string (Branch 26[0])", () => {
  it("extracts empty string when content is null → message text is null after truncateText", async () => {
    // extractText(null) returns ""; truncateText("") returns null
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), msgItem("user", null)];
    const session = await parseCodexRollout(lines, {
      sessionId: "null-content",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });

  it("extracts empty string when content is a number → message text is null after truncateText", async () => {
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), msgItem("user", 42)];
    const session = await parseCodexRollout(lines, {
      sessionId: "num-content",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });

  it("extracts empty string when content is a boolean → message text is null after truncateText", async () => {
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), msgItem("user", true)];
    const session = await parseCodexRollout(lines, {
      sessionId: "bool-content",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });
});

// ── extractText — array with null/falsy items (Branch 27[0]) ─────────────────

describe("extractText — array items that are null/falsy are skipped (Branch 27[0])", () => {
  it("skips null items in the content array", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", [null, { type: "input_text", text: "hello" }]),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "null-item" });
    expect(session?.messages[0]?.text).toBe("hello");
  });

  it("skips undefined (falsy) items in the content array", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      // undefined serialises to null in JSON; use 0 as another falsy value
      msgItem("user", [0, { type: "input_text", text: "world" }]),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "falsy-item" });
    expect(session?.messages[0]?.text).toBe("world");
  });
});

// ── extractText — array with string items (Branch 28[0]) ─────────────────────

describe("extractText — string items in content array (Branch 28[0])", () => {
  it("concatenates plain string items from content array", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", ["foo", "bar"]),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "str-items" });
    expect(session?.messages[0]?.text).toBe("foobar");
  });

  it("handles mixed string and block items", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", ["prefix-", { type: "input_text", text: "body" }]),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "mixed-items",
    });
    expect(session?.messages[0]?.text).toBe("prefix-body");
  });
});

// ── extractText — non-record array items (Branch 29[0]) ─────────────────────

describe("extractText — non-record array items are skipped (Branch 29[0])", () => {
  it("skips number items in content array", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", [42, { type: "input_text", text: "after-num" }]),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "num-item" });
    expect(session?.messages[0]?.text).toBe("after-num");
  });
});

// ── extractText — block with non-string text (Branch 30[1]) ─────────────────

describe("extractText — block where text is not a string (Branch 30[1])", () => {
  it("skips block when block.text is a number, falls through to else-if", async () => {
    // block.text = 123: neither branch pushes text when the else-if also needs
    // block.text to be a string, so extractText returns "". truncateText("") → null.
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", [{ type: "input_text", text: 123 }]),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "non-str-text",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });

  it("skips block when block.text is null", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", [{ type: "output_text", text: null }]),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "null-text" });
    expect(session?.messages[0]?.text).toBeNull();
  });

  it("skips block with unrecognised type and no string text", async () => {
    // block.type is not input_text/output_text/text AND block.text is not a string
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("user", [
        { type: "image_url", url: "https://example.com/img.png" },
      ]),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-text-block",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });
});

// ── handleMessageItem — role fallback (Branch 44[1,2]) ───────────────────────

describe("handleMessageItem — role and author fallbacks (Branch 44[1,2])", () => {
  it("uses p.author when p.role is absent", async () => {
    // author === "user" → treated as user message
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItemWithAuthor("user", "via-author"),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "author-user",
    });
    // userMessageCount increments for user role
    expect(session?.userMessages).toBe(1);
    expect(session?.messages[0]?.text).toBe("via-author");
  });

  it("defaults role to assistant when neither role nor author is set", async () => {
    // No role, no author → defaults to "assistant"
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-01T10:00:02.000Z",
      payload: {
        type: "message",
        content: [{ type: "output_text", text: "assistant default" }],
      },
    });
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), line, tokenCount()];
    const session = await parseCodexRollout(lines, { sessionId: "no-role" });
    // No user message (role defaulted to assistant)
    expect(session?.userMessages).toBe(0);
    expect(session?.messages.some((m) => m.text === "assistant default")).toBe(
      true
    );
  });
});

// ── handleMessageItem — user message without explicitIso (Branch 49[0]) ──────

describe("handleMessageItem — user message without explicit timestamp (Branch 49[0])", () => {
  it("does not set pendingTurnStartedAt when user message has no explicit timestamp", async () => {
    const noTsMsg = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: "prompt" },
    });
    const asstMsg = JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-01T10:00:05.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "reply" }],
      },
    });
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      noTsMsg,
      asstMsg,
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-explicit-ts",
    });
    expect(session).not.toBeNull();
    expect(session?.turnDurations).toHaveLength(0);
  });
});

// ── handleMessageItem — assistant message no iso (Branch 51[1]) ──────────────

describe("handleMessageItem — assistant message with no own timestamp (Branch 51[1])", () => {
  it("captures assistant message even when it carries no timestamp", async () => {
    const noTsAsst = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "untimed" }],
      },
    });
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), noTsAsst, tokenCount()];
    const session = await parseCodexRollout(lines, { sessionId: "asst-no-ts" });
    expect(session?.messages.some((m) => m.text === "untimed")).toBe(true);
  });
});

// ── handleMessageItem — proposed plan in assistant message (Branch 52[0], 53) ─

describe("handleMessageItem — proposed plan extraction (Branches 52[0], 53)", () => {
  it("extracts a <proposed_plan> block from an assistant message", async () => {
    const planText = "1. Do the thing\n2. Verify it";
    const content = `Thinking...\n<proposed_plan>\n${planText}\n</proposed_plan>\nDone.`;
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("assistant", content),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "proposed-plan",
    });
    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0]?.source).toBe("codex-proposed-plan");
    expect(session?.plans?.[0]?.content).toContain("Do the thing");
  });

  it("does not extract a plan when <proposed_plan> tags are absent", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("assistant", "Just a regular reply"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "no-plan" });
    expect(session?.plans).toHaveLength(0);
  });

  it("does not extract a plan when proposed_plan body is blank", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      msgItem("assistant", "<proposed_plan>   </proposed_plan>"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "blank-plan" });
    expect(session?.plans).toHaveLength(0);
  });
});

// ── handleReasoningItem — text/summary fallback chain (Branches 58-62) ───────

describe("handleReasoningItem — content/text/summary fallback chain", () => {
  it("extracts reasoning text from content field", async () => {
    // content is a string — Branch 25[0] in extractText, then reasoning item captures it
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      reasoningItem({ content: "thinking hard..." }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "reasoning-content",
    });
    expect(session?.thinkingBlockCount).toBe(1);
    const thinkMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkMsg?.text).toBe("thinking hard...");
  });

  it("falls back to p.text when content is empty", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "reasoning", content: [], text: "fallback text" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "reasoning-text",
    });
    const thinkMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkMsg?.text).toBe("fallback text");
  });

  it("falls back to p.summary when content and text are absent", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "reasoning", summary: "summary thought" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "reasoning-summary",
    });
    const thinkMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkMsg?.text).toBe("summary thought");
  });

  it("produces a thinking message with null text when no content/text/summary", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "reasoning" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "reasoning-empty",
    });
    expect(session?.thinkingBlockCount).toBe(1);
    const thinkMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkMsg).toBeDefined();
    // text is null (no content/text/summary available)
    expect(thinkMsg?.text).toBeNull();
  });

  it("marks reasoning message as isThinking=true", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      reasoningItem({ content: "step 1" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "thinking-flag",
    });
    const thinkMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkMsg?.isThinking).toBe(true);
    expect(thinkMsg?.role).toBe("assistant");
  });
});

// ── dispatchLine auto kind → RESPONSE_ITEM_TYPES dispatch (Branch 224[1]) ────

describe("dispatchLine — auto kind with non-response-item payload type dispatches as event", () => {
  it("dispatches auto-classified token_count payload as an event", async () => {
    // An unknown wrapper envelope carrying a token_count payload should increment
    // assistantMessages just as a normal event_msg/token_count would.
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      JSON.stringify({
        type: "some_future_envelope_type",
        timestamp: "2026-08-01T10:00:05.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 0,
              output_tokens: 20,
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "auto-event" });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["gpt-5"]).toMatchObject({
      input: 50,
      output: 20,
    });
  });
});

// ── parseCodexRollout — empty/whitespace lines are skipped (Branch 255[0]) ───

describe("parseCodexRollout — empty lines are silently skipped", () => {
  it("ignores blank lines interspersed with valid records", async () => {
    const lines = [
      "",
      SESSION_META,
      "   ",
      TURN_CONTEXT("gpt-5"),
      "",
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "empty-lines",
    });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(1);
  });
});

// ── parseCodexRollout — malformed JSON lines (Branch 256[0]) ─────────────────

describe("parseCodexRollout — malformed JSON lines are counted as parse errors", () => {
  it("counts a malformed mid-stream line and keeps parsing the rest", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      "NOT VALID JSON {{{",
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "bad-json" });
    expect(session).not.toBeNull();
    expect(session?.parseQuality?.malformedLines).toBe(1);
    expect(session?.parseQuality?.truncatedFinalLine).toBe(false);
    expect(session?.assistantMessages).toBe(1);
  });

  it("flags truncatedFinalLine when the last line is malformed", async () => {
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      tokenCount(),
      "{incomplete",
    ];
    const session = await parseCodexRollout(lines, { sessionId: "truncated" });
    expect(session).not.toBeNull();
    expect(session?.parseQuality?.truncatedFinalLine).toBe(true);
    expect(session?.parseQuality?.malformedLines).toBe(1);
  });
});

// ── parseCodexRollout — unknown records counted (FEA-3713) (Branch 256[0]) ───

describe("parseCodexRollout — unknown records counted in parseQuality (FEA-3713)", () => {
  it("counts a valid-JSON but unroutable record as unknownRecords", async () => {
    // A record with no type and no session fields → classified as 'other' → counted
    const lines = [
      SESSION_META,
      TURN_CONTEXT("gpt-5"),
      JSON.stringify({ completely_foreign_field: "whatever" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "unknown-rec",
    });
    expect(session).not.toBeNull();
    expect(session?.parseQuality?.unknownRecords).toBe(1);
  });

  it("omits unknownRecords when there are no unroutable records", async () => {
    const lines = [SESSION_META, TURN_CONTEXT("gpt-5"), tokenCount()];
    const session = await parseCodexRollout(lines, { sessionId: "no-unknown" });
    expect(session?.parseQuality?.unknownRecords).toBeUndefined();
  });
});
