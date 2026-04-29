import { describe, expect, it } from "vitest";
import {
  loopEventPayloadValidator,
  loopMetadataUpdateValidator,
  manualEventPayloadValidator,
  manualEventValidator,
  normalizeLoopEvent,
  TERMINAL_LOOP_EVENTS,
  TERMINAL_LOOP_STATUSES,
  validateNormalizedEvent,
} from "@/app/loops/validators";

describe("loop event payload validator", () => {
  it("accepts small envelope payload", () => {
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      data: { chunk: "ok" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects oversized envelope payload", () => {
    const big = "x".repeat(21_000_000);
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      data: { chunk: big },
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized flattened payload", () => {
    const big = "x".repeat(21_000_000);
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      chunk: big,
    });
    expect(result.success).toBe(false);
  });
});

describe("validateNormalizedEvent — error event validation", () => {
  it("accepts valid error with code, message, timestamp only", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toBeNull();
  });

  it("accepts valid error with string logTail", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: "last 10 log lines here",
    });
    expect(result).toBeNull();
  });

  it("accepts valid error with tokenUsage { inputTokens, outputTokens }", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result).toBeNull();
  });

  it("accepts valid error with string diagnosticsVersion", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      diagnosticsVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("accepts valid error with all diagnostic fields present", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: "some log",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      diagnosticsVersion: "2.1.0",
    });
    expect(result).toBeNull();
  });

  it("rejects error missing timestamp", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("timestamp");
  });

  it("rejects error with non-string timestamp", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: 12_345,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("timestamp");
  });

  it("rejects error with logTail: 123 (non-string)", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: 123,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("logTail");
  });

  it("rejects error with tokenUsage containing non-numeric inputTokens", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: "ten", outputTokens: 5 },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects error with diagnosticsVersion: false (non-string)", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      diagnosticsVersion: false,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("diagnosticsVersion");
  });

  it("accepts error with numeric cacheCreationInputTokens and cacheReadInputTokens", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 1500,
      },
    });
    expect(result).toBeNull();
  });

  it("accepts error with only cacheCreationInputTokens (cacheRead absent)", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 500,
      },
    });
    expect(result).toBeNull();
  });

  it("rejects error where cacheCreationInputTokens is non-numeric", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: "lots",
      },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects error where cacheReadInputTokens is non-numeric", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: true,
      },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects error missing code", () => {
    const result = validateNormalizedEvent({
      type: "error",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("code");
  });

  it("rejects error missing message", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("message");
  });

  it("accepts valid tokensByModel map", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokensByModel: {
        "claude-sonnet-4-5": { input: 1500, output: 800 },
        "claude-opus-4": {
          input: 500,
          output: 200,
          cacheCreation: 100,
          cacheRead: 50,
        },
      },
    });
    expect(result).toBeNull();
  });

  it("rejects tokensByModel with non-numeric input value", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokensByModel: {
        "claude-sonnet-4-5": { input: "many", output: 800 },
      },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokensByModel");
  });

  it("rejects tokensByModel with non-numeric output value", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokensByModel: {
        "claude-sonnet-4-5": { input: 1500, output: false },
      },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokensByModel");
  });

  it("accepts error with omitted tokensByModel", () => {
    const result = validateNormalizedEvent({
      type: "error",
      code: "SOME_ERROR",
      message: "Something failed",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toBeNull();
  });
});

describe("normalizeLoopEvent", () => {
  it("flattens envelope format { type, data } into a flat LoopEvent", () => {
    const body = {
      type: "output",
      data: { chunk: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
    };
    const result = normalizeLoopEvent(body);
    expect(result).toEqual({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns flattened format unchanged when no data wrapper is present", () => {
    const body = {
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const result = normalizeLoopEvent(body);
    expect(result).toEqual(body);
  });

  it("returns the body as-is when data is null (no envelope unwrapping)", () => {
    const body = { type: "progress", data: null };
    const result = normalizeLoopEvent(body);
    expect(result).toEqual(body);
  });

  it("returns the body as-is when data is a primitive (not an object)", () => {
    const body = { type: "progress", data: "string-value" };
    const result = normalizeLoopEvent(body);
    expect(result).toEqual(body);
  });

  it("merges data fields over the top-level type key in envelope format", () => {
    const body = {
      type: "completed",
      data: { summary: "all done", tokensUsed: 100 },
    };
    const result = normalizeLoopEvent(body);
    expect(result).toMatchObject({
      type: "completed",
      summary: "all done",
      tokensUsed: 100,
    });
  });
});

describe("TERMINAL_LOOP_STATUSES", () => {
  it("contains Completed, Failed, Cancelled, TimedOut", () => {
    expect(TERMINAL_LOOP_STATUSES.has("COMPLETED")).toBe(true);
    expect(TERMINAL_LOOP_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_LOOP_STATUSES.has("CANCELLED")).toBe(true);
    expect(TERMINAL_LOOP_STATUSES.has("TIMED_OUT")).toBe(true);
  });

  it("does not contain non-terminal statuses Running, Pending, Claimed", () => {
    expect(TERMINAL_LOOP_STATUSES.has("RUNNING")).toBe(false);
    expect(TERMINAL_LOOP_STATUSES.has("PENDING")).toBe(false);
    expect(TERMINAL_LOOP_STATUSES.has("CLAIMED")).toBe(false);
  });
});

describe("TERMINAL_LOOP_EVENTS", () => {
  it("contains completed, error, cancelled", () => {
    expect(TERMINAL_LOOP_EVENTS.has("completed")).toBe(true);
    expect(TERMINAL_LOOP_EVENTS.has("error")).toBe(true);
    expect(TERMINAL_LOOP_EVENTS.has("cancelled")).toBe(true);
  });

  it("does not contain non-terminal event types", () => {
    expect(TERMINAL_LOOP_EVENTS.has("output")).toBe(false);
    expect(TERMINAL_LOOP_EVENTS.has("progress")).toBe(false);
    expect(TERMINAL_LOOP_EVENTS.has("started")).toBe(false);
  });
});

describe("manualEventPayloadValidator", () => {
  it("accepts envelope format with an allowed manual event type", () => {
    const result = manualEventPayloadValidator.safeParse({
      type: "output",
      data: { chunk: "hello" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts flattened format with an allowed manual event type", () => {
    const result = manualEventPayloadValidator.safeParse({
      type: "progress",
      percent: 42,
    });
    expect(result.success).toBe(true);
  });

  it("rejects runner-only event type 'started'", () => {
    const result = manualEventPayloadValidator.safeParse({
      type: "started",
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects runner-only event type 'tool_call'", () => {
    const result = manualEventPayloadValidator.safeParse({
      type: "tool_call",
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects runner-only event type 'artifact_created'", () => {
    const result = manualEventPayloadValidator.safeParse({
      type: "artifact_created",
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts all five allowed manual event types", () => {
    const types = ["output", "progress", "completed", "error", "cancelled"];
    for (const type of types) {
      const result = manualEventPayloadValidator.safeParse({
        type,
        data: {},
      });
      expect(result.success, `expected '${type}' to be accepted`).toBe(true);
    }
  });
});

describe("manualEventValidator (envelope-only)", () => {
  it("rejects flattened format (envelope-only validator requires data key)", () => {
    const result = manualEventValidator.safeParse({
      type: "output",
      chunk: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid envelope with empty data", () => {
    const result = manualEventValidator.safeParse({
      type: "completed",
      data: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra top-level keys in strict envelope mode", () => {
    const result = manualEventValidator.safeParse({
      type: "output",
      data: { chunk: "hi" },
      extraKey: "not allowed",
    });
    expect(result.success).toBe(false);
  });
});

describe("loopMetadataUpdateValidator", () => {
  it("accepts a valid prUrl", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-URL prUrl", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      prUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a prUrl longer than 2048 characters", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      prUrl: `https://github.com/${"a".repeat(2050)}`,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid branchName with alphanumerics, dots, slashes, hyphens", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      branchName: "feature/my-branch.v2",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a branchName with shell metacharacters", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      branchName: "feat/bad;rm -rf /",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a branchName longer than 256 characters", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      branchName: "a".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a summary string within the 10000-character limit", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      summary: "Work is done.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a summary string exceeding 10000 characters", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      summary: "x".repeat(10_001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = loopMetadataUpdateValidator.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      unknownField: "value",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all three fields together", () => {
    const result = loopMetadataUpdateValidator.safeParse({
      prUrl: "https://github.com/acme/repo/pull/7",
      branchName: "feat/some-branch",
      summary: "Implemented the thing.",
    });
    expect(result.success).toBe(true);
  });
});
