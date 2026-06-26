import { describe, expect, it } from "vitest";
import { ERROR_EVENT_PATTERN, ERROR_EVENT_TERMS } from "./agent-session-events";

describe("ERROR_EVENT_PATTERN", () => {
  it("is derived from ERROR_EVENT_TERMS so all surfaces stay in sync", () => {
    expect(ERROR_EVENT_TERMS).toEqual(["error", "fail"]);
    expect(ERROR_EVENT_PATTERN.source).toBe("error|fail");
    expect(ERROR_EVENT_PATTERN.flags).toContain("i");
  });

  it("matches error- and failure-flavored event types (case-insensitive)", () => {
    for (const eventType of [
      "error",
      "tool_error",
      "runtime_error",
      "Error",
      "fail",
      "tool_failure",
      "failed",
      "FAILURE",
    ]) {
      expect(ERROR_EVENT_PATTERN.test(eventType)).toBe(true);
    }
  });

  it("does not match non-error event types", () => {
    for (const eventType of [
      "tool_use",
      "tool_result",
      "message",
      "completed",
      "success",
    ]) {
      expect(ERROR_EVENT_PATTERN.test(eventType)).toBe(false);
    }
  });
});
