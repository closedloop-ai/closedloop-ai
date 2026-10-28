/**
 * @file telemetry-db-host-telemetry-refused.test.ts
 * @description ISS-7201 — the `dbHostTelemetryRefused` diagnostics must survive
 * both server boundaries the desktop event crosses before it reaches a log sink.
 *
 * This is the half the desktop suite cannot cover. `apps/desktop` has no
 * dependency on this package — the two `TelemetryCategory` declarations are
 * deliberate mirrors with no shared import — so the desktop test proves only that
 * main EMITS the refusal. If this schema does not mirror the category and the
 * reason enum, that emit is dropped server-side as `telemetry.validation_failed`
 * and the signal is dark with nothing failing anywhere. Which is precisely the
 * defect ISS-7201 exists to end, reproduced one layer further out.
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object strips unknown keys, so a field the desktop emits but
 *      this schema does not mirror vanishes silently and a monitor grouping by
 *      `reason` returns nothing. Worse for the enum: a reason only the producer
 *      knows about makes this schema reject the WHOLE event.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass
 *      `handleTelemetryEvent` runs before logging. This family is a single
 *      bounded enum, so it must come through byte-for-byte, including when a
 *      SIBLING field on the same object is being scrubbed.
 */
import { describe, expect, it } from "vitest";
import { DbHostTelemetryRefusalReason } from "../telemetry/db-host-telemetry-refusal-reason";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A well-formed payload as `reportRefusedChildTelemetry` emits it. */
const VALID_REFUSAL = {
  reason: DbHostTelemetryRefusalReason.InvalidSeverity,
} as const;

function eventWith(dbHostTelemetryRefused: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.DbHostTelemetryRefused,
    severity: "error",
    timestamp: "2026-08-20T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { dbHostTelemetryRefused },
  };
}

function parsedRefusal(dbHostTelemetryRefused: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(dbHostTelemetryRefused)
  );
  return parsed.success
    ? parsed.data.diagnostics?.dbHostTelemetryRefused
    : undefined;
}

describe("dbHostTelemetryRefused wire schema (ISS-7201)", () => {
  it("carries the category, severity and reason through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(VALID_REFUSAL)
    );
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    // The facets a Datadog log monitor keys on must survive verbatim.
    expect(event?.category).toBe("desktop.db_host.telemetry_refused");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.dbHostTelemetryRefused).toEqual(VALID_REFUSAL);
  });

  it("accepts every reason this schema declares", () => {
    // Scoped deliberately. This loop reads the INGEST enum and feeds it back
    // into the ingest schema, so it proves only that every declared member
    // survives `z.enum` + `.strip()` — it is true by construction for the
    // desktop mirror and CANNOT see a producer-only member (`apps/desktop` is
    // not importable from this package). The desktop↔ingest mirror is enforced
    // by the `no-unmirrored-desktop-telemetry-enum` source gate, not here;
    // claiming otherwise in this comment would be exactly the false-green the
    // gate exists to prevent.
    for (const reason of Object.values(DbHostTelemetryRefusalReason)) {
      expect(parsedRefusal({ reason })).toEqual({ reason });
    }
  });

  it("rejects a reason this schema does not mirror", () => {
    expect(parsedRefusal({ reason: "missing_sevrity" })).toBeUndefined();
  });

  it("strips a field the schema does not mirror", () => {
    // The content guard, enforced by the schema rather than by review: the
    // refused event's own category and message are exactly what failed
    // validation, so a producer that "helpfully" attached them to aid debugging
    // must not get them onto the wire.
    const result = parsedRefusal({
      ...VALID_REFUSAL,
      refusedMessage: "transcript text that must not travel",
      refusedCategory: "/Users/someone/.claude/projects/x",
    });
    expect(result).toEqual(VALID_REFUSAL);
    expect(result).not.toHaveProperty("refusedMessage");
    expect(result).not.toHaveProperty("refusedCategory");
  });

  it("keeps the event valid when the family is absent", () => {
    // The field is optional: every other desktop category must still validate.
    const parsed = desktopTelemetryEventSchema.safeParse({
      ...eventWith(VALID_REFUSAL),
      diagnostics: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.diagnostics?.dbHostTelemetryRefused : "unset"
    ).toBeUndefined();
  });
});

describe("dbHostTelemetryRefused through sanitizeDesktopTelemetryDiagnostics (ISS-7201)", () => {
  it("survives alongside a sibling field that IS scrubbed", () => {
    // The sanitizer rewrites `logTail`; a shallow-copy regression there is
    // exactly how an untouched sibling gets dropped.
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      dbHostTelemetryRefused: { ...VALID_REFUSAL },
      logTail: "password=hunter2\nstill here",
    });
    expect(sanitized?.dbHostTelemetryRefused).toEqual(VALID_REFUSAL);
    expect(sanitized?.logTail).not.toContain("hunter2");
  });
});
