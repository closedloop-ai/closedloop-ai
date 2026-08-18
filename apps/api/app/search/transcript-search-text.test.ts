import { describe, expect, it } from "vitest";
import { extractTranscriptSearchText } from "./transcript-search-text";

/** Build a JSONL blob from turn objects. */
function jsonl(...turns: unknown[]): string {
  return turns.map((t) => JSON.stringify(t)).join("\n");
}

const userTurn = (content: unknown) => ({
  type: "user",
  message: { role: "user", content },
});
const assistantTurn = (content: unknown) => ({
  type: "assistant",
  message: { role: "assistant", content },
});

/** A Codex rollout `response_item` message record (`{type,payload}` shape). */
const codexMessage = (
  role: "user" | "assistant" | "developer",
  content: unknown[]
) => ({
  type: "response_item",
  payload: { type: "message", role, content },
});

describe("extractTranscriptSearchText", () => {
  it("extracts string-content user turns", () => {
    const raw = jsonl(userTurn("What is the session id?"));
    expect(extractTranscriptSearchText(raw)).toBe("What is the session id?");
  });

  it("extracts text blocks from array-content assistant turns", () => {
    const raw = jsonl(
      assistantTurn([{ type: "text", text: "I checked the code." }])
    );
    expect(extractTranscriptSearchText(raw)).toBe("I checked the code.");
  });

  it("joins consecutive human and assistant turns in order", () => {
    const raw = jsonl(
      userTurn("Fix the bug"),
      assistantTurn([{ type: "text", text: "Done, patched the null check." }])
    );
    expect(extractTranscriptSearchText(raw)).toBe(
      "Fix the bug\nDone, patched the null check."
    );
  });

  it("skips tool_use / tool_result / image blocks, keeping only text", () => {
    const raw = jsonl(
      assistantTurn([
        { type: "text", text: "Running the test." },
        { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
      ]),
      userTurn([
        { type: "tool_result", tool_use_id: "t1", content: "file.ts" },
        { type: "image", source: { data: "AAAA" } },
      ])
    );
    expect(extractTranscriptSearchText(raw)).toBe("Running the test.");
  });

  it("skips non-message rows (queue-operation, session_meta)", () => {
    const raw = jsonl(
      { type: "queue-operation", operation: "enqueue", content: "noise" },
      { type: "session_meta", payload: { id: "abc" } },
      userTurn("Real question")
    );
    expect(extractTranscriptSearchText(raw)).toBe("Real question");
  });

  it("skips malformed / truncated JSONL lines without throwing", () => {
    const raw = `${JSON.stringify(userTurn("Keep me"))}\n{"type":"assistant","message":{"role":"assist`;
    expect(extractTranscriptSearchText(raw)).toBe("Keep me");
  });

  it("returns null for a transcript with no indexable text", () => {
    const raw = jsonl(
      { type: "queue-operation", operation: "dequeue" },
      assistantTurn([{ type: "tool_use", id: "t1", name: "Bash" }])
    );
    expect(extractTranscriptSearchText(raw)).toBeNull();
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(extractTranscriptSearchText("")).toBeNull();
    expect(extractTranscriptSearchText("   \n  \n")).toBeNull();
  });

  it("bounds the body to maxChars", () => {
    const long = "x".repeat(50);
    const raw = jsonl(
      userTurn(long),
      userTurn(long),
      userTurn(long),
      userTurn(long)
    );
    const result = extractTranscriptSearchText(raw, 30);
    expect(result).not.toBeNull();
    expect((result as string).length).toBeLessThanOrEqual(30);
  });

  it("ignores blank content blocks", () => {
    const raw = jsonl(
      assistantTurn([
        { type: "text", text: "   " },
        { type: "text", text: "Actual content" },
      ])
    );
    expect(extractTranscriptSearchText(raw)).toBe("Actual content");
  });

  it("extracts Codex response_item user/assistant prose (input_text/output_text)", () => {
    const raw = jsonl(
      codexMessage("user", [
        { type: "input_text", text: "Refactor the parser" },
      ]),
      codexMessage("assistant", [
        { type: "output_text", text: "Split it into two modules." },
      ])
    );
    expect(extractTranscriptSearchText(raw)).toBe(
      "Refactor the parser\nSplit it into two modules."
    );
  });

  it("skips Codex developer (injected-instructions) role and reasoning/tool blocks", () => {
    const raw = jsonl(
      codexMessage("developer", [
        { type: "input_text", text: "<permissions instructions>…" },
      ]),
      codexMessage("assistant", [
        { type: "reasoning", text: "thinking…" },
        { type: "output_text", text: "Here is the answer." },
      ])
    );
    expect(extractTranscriptSearchText(raw)).toBe("Here is the answer.");
  });

  it("indexes a Codex-only transcript that carries no Claude envelope", () => {
    const raw = jsonl(
      { type: "session_meta", payload: { id: "abc" } },
      codexMessage("user", [{ type: "input_text", text: "Codex-only body" }])
    );
    expect(extractTranscriptSearchText(raw)).toBe("Codex-only body");
  });
});
