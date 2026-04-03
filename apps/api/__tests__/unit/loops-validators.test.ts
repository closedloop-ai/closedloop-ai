import { describe, expect, it } from "vitest";
import {
  loopEventPayloadValidator,
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
});
