import { describe, expect, it } from "vitest";
import { isToolResultEntry, parseJsonlLine } from "../jsonl-parse";

describe("parseJsonlLine", () => {
  it("parses an assistant entry", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.message?.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("parses a user entry", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello" },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
  });

  it("parses a system entry with subtype and hook fields", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      hook_event: "start",
      hook_name: "pre-run",
      parent_tool_use_id: "abc",
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
    expect(result!.data?.subtype).toBe("init");
    expect(result!.data?.hookEvent).toBe("start");
    expect(result!.data?.hookName).toBe("pre-run");
    expect(result!.parentToolUseId).toBe("abc");
  });

  it("parses progress entries", () => {
    const line = JSON.stringify({
      type: "progress",
      data: { subtype: "tick" },
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("progress");
  });

  it("parses queue-operation entries", () => {
    const line = JSON.stringify({ type: "queue-operation" });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("queue-operation");
  });

  it("parses file-history-snapshot entries", () => {
    const line = JSON.stringify({ type: "file-history-snapshot" });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("file-history-snapshot");
  });

  it("returns null for unknown types", () => {
    const line = JSON.stringify({ type: "content_block_delta" });
    expect(parseJsonlLine(line)).toBeNull();
  });

  it("normalizes result type into a system entry", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 421,
      num_turns: 4,
      total_cost_usd: 0,
      is_error: false,
      result: "done",
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
    expect(result!.data?.type).toBe("result");
    expect(result!.data?.subtype).toBe("success");
    expect(result!.data?.durationMs).toBe(421);
    expect(result!.data?.numTurns).toBe(4);
    expect(result!.data?.totalCostUsd).toBe(0);
    expect(result!.data?.isError).toBe(false);
    expect(result!.data?.resultText).toBe("done");
  });

  it("normalizes result entries whose result is a content-block array", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [
        { type: "text", text: "first chunk " },
        { type: "tool_use", id: "abc" },
        { type: "text", text: "second chunk" },
      ],
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.data?.resultText).toBe("first chunk second chunk");
  });

  it("leaves resultText undefined when the result array has no text blocks", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [{ type: "tool_use", id: "abc" }],
    });
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result!.data?.resultText).toBeUndefined();
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonlLine("{broken")).toBeNull();
    expect(parseJsonlLine("")).toBeNull();
    expect(parseJsonlLine("not json at all")).toBeNull();
  });

  it("preserves parent_tool_use_id", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "tool-123",
      message: { content: "sub" },
    });
    const result = parseJsonlLine(line);
    expect(result!.parentToolUseId).toBe("tool-123");
  });
});

describe("isToolResultEntry", () => {
  it("returns true for user entry with tool_result blocks", () => {
    const entry = parseJsonlLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      })
    )!;
    expect(isToolResultEntry(entry)).toBe(true);
  });

  it("returns false for user entry with string content", () => {
    const entry = parseJsonlLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello world" },
      })
    )!;
    expect(isToolResultEntry(entry)).toBe(false);
  });

  it("returns false for assistant entries", () => {
    const entry = parseJsonlLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_result", content: "ok" }],
        },
      })
    )!;
    expect(isToolResultEntry(entry)).toBe(false);
  });

  it("returns false when content is not an array", () => {
    const entry = parseJsonlLine(
      JSON.stringify({
        type: "user",
        message: { content: "just text" },
      })
    )!;
    expect(isToolResultEntry(entry)).toBe(false);
  });
});
