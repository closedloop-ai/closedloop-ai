/**
 * @file telemetry-local-read-failed.test.ts
 * @description ISS-11351 — `desktop.local_read.failed` must reach the log sink
 * with the `read` a triager reads in the log sample (the presence monitor counts
 * the category alone, not by `read`), and a desktop newer than this deploy must
 * not cost the event.
 *
 * Fed the RAW strings the desktop producer emits, not this package's const: the
 * desktop mirrors the vocabulary with no shared import, so a case written
 * against the const would move with any edit to it.
 */
import { describe, expect, it } from "vitest";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

function parse(diagnostics: unknown) {
  return desktopTelemetryEventSchema.safeParse({
    schemaVersion: "1",
    category: "desktop.local_read.failed",
    severity: "error",
    timestamp: "2026-09-28T00:00:00.000Z",
    trace: { commandId: "", operationId: "", computeTargetId: "target-1" },
    diagnostics,
  });
}

describe("desktop.local_read.failed ingest (ISS-11351)", () => {
  it("names the category the desktop emits", () => {
    expect(TelemetryCategory.LocalReadFailed).toBe("desktop.local_read.failed");
  });

  it.each([
    "usage_aggregate",
    "analytics_aggregate",
    "component_cursor_hydrate",
    "component_cursor_read",
    "component_rows_load",
  ])("carries read %s through validation as itself", (read) => {
    const parsed = parse({ localReadFailed: { read } });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.diagnostics?.localReadFailed).toEqual({ read });
  });

  it("folds a read only a newer desktop names, keeping the event", () => {
    const parsed = parse({
      localReadFailed: { read: "read_from_a_newer_build" },
      exitCode: 3,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.diagnostics?.localReadFailed).toEqual({
      read: "unknown",
    });
    expect(parsed.data?.diagnostics?.exitCode).toBe(3);
  });

  it("validates an older desktop's event that carries no read", () => {
    const parsed = parse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data?.diagnostics?.localReadFailed).toBeUndefined();
  });
});
