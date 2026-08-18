/**
 * @file telemetry-db-host-exit.test.ts
 * @description ISS-5715 — the `dbHostExit` diagnostics must survive BOTH server
 * boundaries the desktop event crosses before it reaches a log sink:
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object strips unknown keys, so a counter the desktop emits
 *      but this schema does not mirror is dropped silently and the alert query
 *      that groups by it returns nothing.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass
 *      `handleTelemetryEvent` runs before logging. It rewrites several
 *      diagnostics families in place; `dbHostExit` is counters-only and must
 *      come through byte-for-byte, and must not be dropped when a SIBLING
 *      field on the same object is being scrubbed.
 *
 * Added on review (wongk, PR #4708): the desktop-side suite stopped at the
 * emitter, so nothing pinned either boundary and a schema/producer drift would
 * have surfaced only as missing Datadog data.
 */
import { describe, expect, it } from "vitest";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
} from "../telemetry/schema";

/** A well-formed payload as `reportDbHostExitedUnexpectedly` emits it. */
const VALID_DB_HOST_EXIT = {
  exitCode: 11,
  crashesInWindow: 3,
  backoffMs: 4000,
  rejectedOps: 7,
  restartAlreadyInFlight: true,
} as const;

function eventWith(dbHostExit: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.DbHostExitedUnexpectedly,
    severity: "error",
    timestamp: "2026-08-07T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { dbHostExit },
  };
}

function parsedDbHostExit(dbHostExit: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(eventWith(dbHostExit));
  return parsed.success ? parsed.data.diagnostics?.dbHostExit : undefined;
}

describe("dbHostExit diagnostics wire schema (ISS-5715)", () => {
  it("carries the category and every counter through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(VALID_DB_HOST_EXIT)
    );
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    // The facet a Datadog log monitor keys on must survive verbatim.
    expect(event?.category).toBe("desktop.db_host.exited_unexpectedly");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.dbHostExit).toEqual(VALID_DB_HOST_EXIT);
  });

  it("accepts a null exitCode", () => {
    // Electron reports no code at all when the mojo pipe disconnects first
    // (electron/electron#42283); the event's existence is the signal, so a null
    // code must validate rather than sink the whole event.
    expect(parsedDbHostExit({ ...VALID_DB_HOST_EXIT, exitCode: null })).toEqual(
      {
        ...VALID_DB_HOST_EXIT,
        exitCode: null,
      }
    );
  });

  it("accepts a zero blast radius", () => {
    // An exit that dropped no caller work is still an exit worth alerting on.
    expect(
      parsedDbHostExit({
        ...VALID_DB_HOST_EXIT,
        rejectedOps: 0,
        crashesInWindow: 0,
        backoffMs: 0,
      })
    ).toEqual({
      ...VALID_DB_HOST_EXIT,
      rejectedOps: 0,
      crashesInWindow: 0,
      backoffMs: 0,
    });
  });

  it("strips a counter the schema does not mirror", () => {
    // The drift this pins: a desktop-side field added to DbHostExitDiagnostics
    // without a matching entry here compiles fine and then vanishes on the wire.
    const result = parsedDbHostExit({
      ...VALID_DB_HOST_EXIT,
      unmirroredCounter: 42,
    });
    expect(result).toEqual(VALID_DB_HOST_EXIT);
    expect(result).not.toHaveProperty("unmirroredCounter");
  });

  it.each([
    ["a missing required counter", { exitCode: 0, crashesInWindow: 1 }],
    ["a negative rejectedOps", { ...VALID_DB_HOST_EXIT, rejectedOps: -1 }],
    ["a fractional backoff", { ...VALID_DB_HOST_EXIT, backoffMs: 1000.5 }],
    [
      "a non-boolean restartAlreadyInFlight",
      { ...VALID_DB_HOST_EXIT, restartAlreadyInFlight: "true" },
    ],
    ["a stringified exit code", { ...VALID_DB_HOST_EXIT, exitCode: "11" }],
  ])("rejects %s", (_label, dbHostExit) => {
    expect(
      desktopTelemetryEventSchema.safeParse(eventWith(dbHostExit)).success
    ).toBe(false);
  });

  it("keeps the event valid when dbHostExit is absent", () => {
    // The field is optional: every other desktop category must still validate.
    const parsed = desktopTelemetryEventSchema.safeParse({
      ...eventWith(VALID_DB_HOST_EXIT),
      diagnostics: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.diagnostics?.dbHostExit : "unset"
    ).toBeUndefined();
  });
});

describe("dbHostExit through sanitizeDesktopTelemetryDiagnostics (ISS-5715)", () => {
  it("passes the counters through unchanged", () => {
    // Counters only — no paths, SQL or row content — so the sanitizer has
    // nothing to redact and must not mangle the numbers a monitor thresholds on.
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      dbHostExit: { ...VALID_DB_HOST_EXIT },
    });
    expect(sanitized?.dbHostExit).toEqual(VALID_DB_HOST_EXIT);
  });

  it("survives alongside a sibling field that IS scrubbed", () => {
    // The sanitizer rewrites `logTail`; a shallow-copy regression there is
    // exactly how an untouched sibling gets dropped.
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      dbHostExit: { ...VALID_DB_HOST_EXIT },
      logTail: "password=hunter2\nstill here",
    });
    expect(sanitized?.dbHostExit).toEqual(VALID_DB_HOST_EXIT);
    expect(sanitized?.logTail).not.toContain("hunter2");
  });

  it("does not mutate the caller's diagnostics object", () => {
    const input = { dbHostExit: { ...VALID_DB_HOST_EXIT } };
    sanitizeDesktopTelemetryDiagnostics(input);
    expect(input.dbHostExit).toEqual(VALID_DB_HOST_EXIT);
  });

  it("round-trips the validated event through the sanitizer", () => {
    // The real server order: validate, then sanitize what validation produced.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(VALID_DB_HOST_EXIT)
    );
    const sanitized = parsed.success
      ? sanitizeDesktopTelemetryDiagnostics(parsed.data.diagnostics)
      : undefined;
    expect(sanitized?.dbHostExit).toEqual(VALID_DB_HOST_EXIT);
  });
});
