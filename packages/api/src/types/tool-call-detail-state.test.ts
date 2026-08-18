import { describe, expect, it } from "vitest";
import {
  resolveToolCallDetailState,
  TOOL_CALL_DETAIL_STATES,
  toolCallDetailEmptyMessage,
} from "./agent-session-tool-call";

const REDACTED_RE = /redacted/i;
const UNAVAILABLE_RE = /isn't loaded in this view/i;
const MALFORMED_RE = /couldn't be read/i;

describe("resolveToolCallDetailState (FEA-3696)", () => {
  it("honors an explicit detailState over inline inference", () => {
    expect(
      resolveToolCallDetailState({ detailState: "redacted", input: "x" })
    ).toBe("redacted");
  });

  it("infers `unavailable` when nothing is inline and no state is set", () => {
    expect(resolveToolCallDetailState({})).toBe("unavailable");
  });

  it("infers `available` from inline input/output when no state is set", () => {
    expect(resolveToolCallDetailState({ input: "ls -la" })).toBe("available");
    expect(resolveToolCallDetailState({ output: "ok" })).toBe("available");
    expect(resolveToolCallDetailState({ status: "exit 0" })).toBe("available");
    expect(resolveToolCallDetailState({ durationMs: 0 })).toBe("available");
  });

  it("infers `truncated` when an inline field is flagged clipped", () => {
    expect(
      resolveToolCallDetailState({ input: "x", inputTruncated: true })
    ).toBe("truncated");
    expect(
      resolveToolCallDetailState({ output: "y", outputTruncated: true })
    ).toBe("truncated");
  });
});

describe("toolCallDetailEmptyMessage (FEA-3696)", () => {
  it("returns null for states that render real content", () => {
    expect(toolCallDetailEmptyMessage("available")).toBeNull();
    expect(toolCallDetailEmptyMessage("truncated")).toBeNull();
  });

  it("returns a distinct honest message for each empty state", () => {
    const redacted = toolCallDetailEmptyMessage("redacted");
    const unavailable = toolCallDetailEmptyMessage("unavailable");
    const malformed = toolCallDetailEmptyMessage("malformed");
    expect(redacted).toMatch(REDACTED_RE);
    expect(unavailable).toMatch(UNAVAILABLE_RE);
    expect(malformed).toMatch(MALFORMED_RE);
    // The three empty-state messages are all distinct (no ambiguous reuse).
    expect(new Set([redacted, unavailable, malformed]).size).toBe(3);
  });

  it("covers every declared detail state", () => {
    // Exhaustiveness guard: adding a state without updating the message map
    // would surface here (unavailable/redacted/malformed → message; the two
    // content states → null).
    for (const state of TOOL_CALL_DETAIL_STATES) {
      const message = toolCallDetailEmptyMessage(state);
      if (state === "available" || state === "truncated") {
        expect(message).toBeNull();
      } else {
        expect(message).toBeTruthy();
      }
    }
  });
});
