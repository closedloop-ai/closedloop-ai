import { describe, expect, it } from "vitest";
import { createTelemetryReceiptParser } from "./e2e/helpers/telemetry-clock-receipt-parser.js";

const marker = "CLOSEDLOOP_TELEMETRY_TEST_CLOCK ";
const validReceipt = {
  qualification: {
    sourceQualified: true,
    canonicalCadence: 15_000,
    moduleRelative: "startup-fixture.js",
    ownerClass: "ClaudeCodeTelemetrySyncService",
    ownerMethod: "start",
    noPrecomputedLocationOrHash: true,
  },
  ownerRegistered: true,
  originalNativeHandleRetained: true,
  hasRef: false,
  cleared: true,
  advances: 2,
  actualCallbacks: 2,
  completionPending: false,
  errors: [],
  virtualTimersRemaining: 0,
  dateIdentityUnchanged: true,
  dropped: 0,
};
const line = `${marker}${JSON.stringify(validReceipt)}\n`;

describe("telemetry process-exit receipt boundary", () => {
  it("accepts a valid fragmented marker and discards unrelated stderr", () => {
    const parser = createTelemetryReceiptParser();
    parser.write("private unrelated body\n");
    parser.write(line.slice(0, 11));
    parser.write(line.slice(11));
    parser.finish();
    expect(parser.result()).toEqual({
      valid: true,
      faults: [],
      receipt: validReceipt,
    });
  });
  it.each(["missing", "malformed", "duplicate", "oversized"])(
    "retains %s as a clock lifecycle fault",
    (kind) => {
      const parser = createTelemetryReceiptParser();
      if (kind === "malformed") {
        parser.write(`${marker}{invalid}\n`);
      }
      if (kind === "duplicate") {
        parser.write(line);
        parser.write(line);
      }
      if (kind === "oversized") {
        parser.write(`${marker}${"x".repeat(65_536)}\n`);
      }
      parser.finish();
      expect(parser.result().faults.length).toBeGreaterThan(0);
    }
  );
  it.each([
    { cleared: false },
    { completionPending: true },
    { dateIdentityUnchanged: false },
    { dropped: 1 },
    { actualCallbacks: 1 },
  ])("rejects incomplete cleanup, completion or timer fidelity", (change) => {
    const parser = createTelemetryReceiptParser();
    parser.write(
      `${marker}${JSON.stringify({ ...validReceipt, ...change })}\n`
    );
    parser.finish();
    expect(parser.result().valid).toBe(false);
  });
});
