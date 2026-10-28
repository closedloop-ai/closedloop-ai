/**
 * @file telemetry-collector-records-dropped.test.ts
 * @description ISS-6417 — the `collectorRecordsDropped` diagnostics must survive
 * both server boundaries the desktop event crosses before it reaches a log sink,
 * because a monitor on this category groups by `reason` and thresholds on
 * `count`:
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object strips unknown keys, so a field the desktop emits but
 *      this schema does not mirror is dropped silently and the alert query that
 *      groups by it returns nothing. The enum used to be worse still: the desktop
 *      mirrors `CollectorRecordsDroppedReason` as its own declaration with no
 *      shared import, and a reason only the producer knew made this schema reject
 *      the WHOLE event as `telemetry.validation_failed`. Since ISS-7488 it
 *      coarsens onto `Unknown` instead, so the event and its count survive.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass
 *      `handleTelemetryEvent` runs before logging. This family is a bounded enum
 *      and a count, so it must come through byte-for-byte, including when a
 *      SIBLING field on the same object is being scrubbed.
 */
import { describe, expect, it } from "vitest";
import { CollectorRecordsDroppedReason } from "../telemetry/collector-records-dropped-reason";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A well-formed payload as `reportCollectorRecordsDropped` emits it. */
const VALID_DROP = {
  reason: CollectorRecordsDroppedReason.UnreadableTimestamp,
  count: 2,
} as const;

function eventWith(collectorRecordsDropped: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.CollectorRecordsDropped,
    severity: "error",
    timestamp: "2026-08-17T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { collectorRecordsDropped },
  };
}

function parsedDrop(collectorRecordsDropped: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(collectorRecordsDropped)
  );
  return parsed.success
    ? parsed.data.diagnostics?.collectorRecordsDropped
    : undefined;
}

describe("collectorRecordsDropped wire schema (ISS-6417)", () => {
  it("carries the category, severity, reason and count through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(eventWith(VALID_DROP));
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    // The facets a Datadog log monitor keys on must survive verbatim.
    expect(event?.category).toBe("collector.records_dropped");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.collectorRecordsDropped).toEqual(VALID_DROP);
  });

  it("rejects a zero count", () => {
    // A drop report that says zero describes a drop that did not happen. The
    // schema is where a producer whose tally ran outside the branch that
    // actually dropped something becomes visible, instead of quietly padding the
    // alert with events about nothing.
    expect(parsedDrop({ ...VALID_DROP, count: 0 })).toBeUndefined();
  });

  it("folds a reason this schema does not mirror, keeping the event", () => {
    // ISS-7488 CHANGED THIS EXPECTATION. It asserted rejection, on the reasoning
    // that a producer-side reason landing alone must be loud. In production it
    // was not loud, it was dark: rejection sank the WHOLE event as
    // telemetry.validation_failed — 8 of them over the 30 days to 2026-09-14 —
    // so the drop alert went blind exactly while a newly added drop path was the
    // thing firing. The reason now coarsens and the count still arrives; the
    // drift itself is caught at CI by
    // `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts`.
    expect(parsedDrop({ ...VALID_DROP, reason: "unreadable_stamp" })).toEqual({
      reason: CollectorRecordsDroppedReason.Unknown,
      count: VALID_DROP.count,
    });
  });

  it("strips a field the schema does not mirror", () => {
    // A desktop-side field added without a matching entry here compiles fine and
    // then vanishes on the wire; better it vanish than carry transcript content.
    const result = parsedDrop({
      ...VALID_DROP,
      transcriptPath: "/Users/someone/.claude/projects/x/subagents/a.jsonl",
    });
    expect(result).toEqual(VALID_DROP);
    expect(result).not.toHaveProperty("transcriptPath");
  });

  it("keeps the event valid when the family is absent", () => {
    // The field is optional: every other desktop category must still validate.
    const parsed = desktopTelemetryEventSchema.safeParse({
      ...eventWith(VALID_DROP),
      diagnostics: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success
        ? parsed.data.diagnostics?.collectorRecordsDropped
        : "unset"
    ).toBeUndefined();
  });
});

describe("collectorRecordsDropped through sanitizeDesktopTelemetryDiagnostics (ISS-6417)", () => {
  it("survives alongside a sibling field that IS scrubbed", () => {
    // The sanitizer rewrites `logTail`; a shallow-copy regression there is
    // exactly how an untouched sibling gets dropped.
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      collectorRecordsDropped: { ...VALID_DROP },
      logTail: "password=hunter2\nstill here",
    });
    expect(sanitized?.collectorRecordsDropped).toEqual(VALID_DROP);
    expect(sanitized?.logTail).not.toContain("hunter2");
  });
});
