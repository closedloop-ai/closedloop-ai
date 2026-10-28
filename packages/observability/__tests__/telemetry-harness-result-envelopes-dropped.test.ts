/**
 * @file telemetry-harness-result-envelopes-dropped.test.ts
 * @description ISS-7332 — the `harnessResultEnvelopesDropped` diagnostics must
 * survive both server boundaries the desktop event crosses before it reaches a
 * log sink, because a monitor on this category groups by `reason` and thresholds
 * on `count`:
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object strips unknown keys, so a field the desktop emits but
 *      this schema does not mirror is dropped silently and the alert query that
 *      groups by it returns nothing. Worse for the enum: the desktop mirrors
 *      `HarnessResultEnvelopeDropReason` as its own declaration with no shared
 *      import, so a reason only the producer knows about makes this schema reject
 *      the WHOLE event as `telemetry.validation_failed`.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass
 *      `handleTelemetryEvent` runs before logging. This family is a bounded enum
 *      and a count, so it must come through byte-for-byte, including when a
 *      SIBLING field on the same object is being scrubbed.
 */
import { describe, expect, it } from "vitest";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { HarnessResultEnvelopeDropReason } from "../telemetry/harness-result-envelope-drop-reason";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A well-formed payload as `reportHarnessResultEnvelopesDropped` emits it. */
const VALID_DROP = {
  reason: HarnessResultEnvelopeDropReason.CorruptPersistedRow,
  count: 3,
} as const;

function eventWith(harnessResultEnvelopesDropped: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.HarnessResultEnvelopesDropped,
    severity: "error",
    timestamp: "2026-08-20T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { harnessResultEnvelopesDropped },
  };
}

function parsedDrop(harnessResultEnvelopesDropped: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(harnessResultEnvelopesDropped)
  );
  return parsed.success
    ? parsed.data.diagnostics?.harnessResultEnvelopesDropped
    : undefined;
}

describe("harnessResultEnvelopesDropped wire schema (ISS-7332)", () => {
  it("carries the category, severity, reason and count through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(eventWith(VALID_DROP));
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    // The facets a Datadog log monitor keys on must survive verbatim.
    expect(event?.category).toBe("cost.harness_result_envelopes_dropped");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.harnessResultEnvelopesDropped).toEqual(
      VALID_DROP
    );
  });

  it("rejects a zero count", () => {
    // A drop report that says zero describes a drop that did not happen — a
    // producer whose tally ran outside the reject branch must fail loudly here
    // rather than inflate the alert.
    expect(parsedDrop({ ...VALID_DROP, count: 0 })).toBeUndefined();
  });

  it("rejects a reason this schema does not mirror", () => {
    // The desktop declares its own copy of the enum. A value only the producer
    // knows about must be caught here, because the failure mode is the WHOLE
    // event being dropped as `telemetry.validation_failed`.
    expect(
      parsedDrop({ ...VALID_DROP, reason: "a_reason_from_the_future" })
    ).toBeUndefined();
  });

  it("survives the sanitizer beside a field being scrubbed", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      harnessResultEnvelopesDropped: { ...VALID_DROP },
      logTail: "sk_live_0123456789abcdef should not reach a log sink",
    });

    expect(sanitized?.harnessResultEnvelopesDropped).toEqual(VALID_DROP);
  });
});
