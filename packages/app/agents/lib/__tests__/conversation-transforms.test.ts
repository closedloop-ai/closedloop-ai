import type { ConversationMessage } from "@repo/design-system/components/ui/types";
import { describe, expect, it } from "vitest";
import {
  messagesToEnvelopes,
  stringifyJsonValue,
} from "../conversation-transforms";

function makeMessage(
  overrides: Partial<ConversationMessage> = {}
): ConversationMessage {
  return {
    id: "m1",
    role: "user",
    author: "Ada",
    createdAt: "2026-01-05T10:00:00.000Z",
    content: "hello",
    ...overrides,
  };
}

describe("stringifyJsonValue", () => {
  it("returns strings unchanged", () => {
    expect(stringifyJsonValue("hi")).toBe("hi");
  });

  it("stringifies numbers, booleans, and null with String()", () => {
    expect(stringifyJsonValue(42)).toBe("42");
    expect(stringifyJsonValue(true)).toBe("true");
    expect(stringifyJsonValue(null)).toBe("null");
  });

  it("pretty-prints objects and arrays with 2-space indent", () => {
    expect(stringifyJsonValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(stringifyJsonValue([1, 2])).toBe("[\n  1,\n  2\n]");
  });
});

describe("messagesToEnvelopes", () => {
  it("maps an assistant message and carries usage when present", () => {
    const [envelope] = messagesToEnvelopes([
      makeMessage({
        id: "a1",
        role: "assistant",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ]);

    expect(envelope).toMatchObject({
      id: "a1",
      type: "assistant",
      author: "Ada",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("sets assistant usage to null when the message has none", () => {
    const [envelope] = messagesToEnvelopes([
      makeMessage({ role: "assistant", usage: null }),
    ]);

    expect(envelope).toMatchObject({ type: "assistant", usage: null });
  });

  it("maps a user message", () => {
    const [envelope] = messagesToEnvelopes([makeMessage({ role: "user" })]);
    expect(envelope).toMatchObject({ type: "user", author: "Ada" });
  });

  it("falls back to a single text block from content when no blocks exist", () => {
    const [envelope] = messagesToEnvelopes([
      makeMessage({ role: "user", content: "hello" }),
    ]);

    expect(envelope).toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("prefers explicit blocks over the content fallback", () => {
    const blocks = [{ type: "text" as const, text: "from blocks" }];
    const [envelope] = messagesToEnvelopes([
      makeMessage({ role: "user", content: "ignored", blocks }),
    ]);

    expect(envelope).toMatchObject({ content: blocks });
  });

  it("yields empty content blocks for blank content and no blocks", () => {
    const [envelope] = messagesToEnvelopes([
      makeMessage({ role: "user", content: "   " }),
    ]);

    expect(envelope).toMatchObject({ content: [] });
  });

  it("maps non-user/assistant roles to a typed data envelope", () => {
    const [envelope] = messagesToEnvelopes([
      makeMessage({ id: "s1", role: "system", content: "boot" }),
    ]);

    expect(envelope).toMatchObject({
      id: "s1",
      type: "system",
      data: { author: "Ada", content: "boot" },
    });
  });
});
