import { describe, expect, it } from "vitest";
import {
  buildDesktopTelemetryPayload,
  sanitizeDesktopTelemetryDiagnostics,
} from "../telemetry/emitter";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
  TelemetrySeverity,
  telemetryDiagnosticsSchema,
  telemetryTraceContextSchema,
} from "../telemetry/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID_A = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
const VALID_UUID_B = "85c4e16f-43d1-4422-b017-e9a2b7073c15";

const validTraceContext = {
  commandId: "cmd-1",
  operationId: "op-1",
  computeTargetId: "target-1",
  gatewaySessionId: VALID_UUID_A,
  loopSessionId: VALID_UUID_B,
  schemaVersion: "1",
};

const validDesktopWirePayload = {
  schemaVersion: "1",
  category: TelemetryCategory.JobStarted,
  severity: TelemetrySeverity.Info,
  timestamp: "2024-01-01T00:00:00.000Z",
  trace: {
    commandId: "cmd-1",
    operationId: "op-1",
    computeTargetId: "target-1",
    gatewaySessionId: VALID_UUID_A,
    sessionId: VALID_UUID_B,
  },
};

// ---------------------------------------------------------------------------
// telemetryTraceContextSchema
// ---------------------------------------------------------------------------

describe("telemetryTraceContextSchema", () => {
  it("accepts a valid trace context payload", () => {
    const result = telemetryTraceContextSchema.safeParse(validTraceContext);
    expect(result.success).toBe(true);
  });

  it("loopSessionId is optional — accepts payload without it", () => {
    const { loopSessionId: _omit, ...rest } = validTraceContext;
    const result = telemetryTraceContextSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// telemetryDiagnosticsSchema
// ---------------------------------------------------------------------------

describe("telemetryDiagnosticsSchema", () => {
  it("accepts an empty diagnostics object (all fields optional)", () => {
    const result = telemetryDiagnosticsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts diagnostics with logTail and exitCode", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      logTail: "some log output",
      exitCode: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts diagnostics with tokenUsage", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tokenUsage missing inputTokens", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { outputTokens: 50 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tokenUsage missing outputTokens", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { inputTokens: 100 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// desktopTelemetryEventSchema — transform behavior
// ---------------------------------------------------------------------------

describe("desktopTelemetryEventSchema", () => {
  it("accepts a valid desktop wire payload", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
  });

  it("transforms trace.sessionId to trace.loopSessionId", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trace.loopSessionId).toBe(VALID_UUID_B);
      expect(result.data.trace.gatewaySessionId).toBe(VALID_UUID_A);
    }
  });

  it("output does not contain a sessionId field in trace (renamed to loopSessionId)", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect("sessionId" in result.data.trace).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildDesktopTelemetryPayload — validation, sanitization, and transform
// ---------------------------------------------------------------------------

describe("buildDesktopTelemetryPayload", () => {
  it("returns validation_failed payload when input is invalid", () => {
    const result = buildDesktopTelemetryPayload({
      category: "job.started",
      schemaVersion: "1",
    });

    expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
  });

  it("validation_failed issues only contain path, code, and optionally expected — no received or message", () => {
    const payloadWithSecret = {
      schemaVersion: "1",
      category: "job.started",
      severity: "info",
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd",
        operationId: "op",
        computeTargetId: "target",
        secret: "sk_test_abc123",
      },
    };

    const result = buildDesktopTelemetryPayload(payloadWithSecret);

    expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(Array.isArray(result.issues)).toBe(true);

    for (const issue of result.issues as Record<string, unknown>[]) {
      const issueKeys = Object.keys(issue);
      expect(issueKeys).not.toContain("message");
      expect(issueKeys).not.toContain("received");
      expect(issueKeys).toContain("path");
      expect(issueKeys).toContain("code");
    }
  });

  it("a secret embedded in trace does not appear in validation_failed payload", () => {
    const SECRET = "sk_test_abc123";
    const result = buildDesktopTelemetryPayload({
      schemaVersion: "1",
      category: "job.started",
      severity: "info",
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd",
        operationId: "op",
        computeTargetId: "target",
        gatewaySessionId: "not-a-uuid",
        secret: SECRET,
      },
    });

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("returns correct payload for well-formed input with sessionId→loopSessionId transform", () => {
    const result = buildDesktopTelemetryPayload(validDesktopWirePayload);

    expect(result.category).toBe(TelemetryCategory.JobStarted);
    expect(result.schemaVersion).toBe("1");
    const trace = result.trace as Record<string, unknown>;
    expect(trace.loopSessionId).toBe(VALID_UUID_B);
    expect(trace.gatewaySessionId).toBe(VALID_UUID_A);
  });
});

// ---------------------------------------------------------------------------
// sanitizeDesktopTelemetryDiagnostics
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics", () => {
  it("returns undefined when diagnostics is undefined", () => {
    expect(sanitizeDesktopTelemetryDiagnostics(undefined)).toBeUndefined();
  });

  it("returns diagnostics unchanged when logTail is absent", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({ exitCode: 0 });
    expect(result).toEqual({ exitCode: 0 });
  });

  it("passes through a short logTail with no credential patterns", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting job\nCompleted successfully",
    });
    expect(result?.logTail).toBe("Starting job\nCompleted successfully");
  });

  it("strips lines containing sk_ credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting job\nusing sk_live_secret123\nCompleted",
    });
    expect(result?.logTail).not.toContain("sk_live_secret123");
    expect(result?.logTail).toContain("Starting job");
    expect(result?.logTail).toContain("Completed");
  });

  it("strips lines containing token= credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\ntoken=abc123xyz\nDone",
    });
    expect(result?.logTail).not.toContain("token=abc123xyz");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("strips lines containing password= credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\npassword=hunter2\nDone",
    });
    expect(result?.logTail).not.toContain("password=hunter2");
  });

  it("strips lines containing authorization: credential pattern (case-insensitive)", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\nAuthorization: Bearer token123\nDone",
    });
    expect(result?.logTail).not.toContain("Bearer token123");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("truncates logTail exceeding 4096 bytes", () => {
    const longLine = "a".repeat(5000);
    const result = sanitizeDesktopTelemetryDiagnostics({ logTail: longLine });
    const encoded = new TextEncoder().encode(result?.logTail ?? "");
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
  });

  it("does not truncate logTail that fits within 4096 bytes", () => {
    const shortLog = "short log line\nsecond line";
    const result = sanitizeDesktopTelemetryDiagnostics({ logTail: shortLog });
    expect(result?.logTail).toBe(shortLog);
  });

  it("preserves tokenUsage and exitCode when sanitizing logTail", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "clean log",
      exitCode: 1,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result?.exitCode).toBe(1);
    expect(result?.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
