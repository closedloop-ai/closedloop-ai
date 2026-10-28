import { describe, expect, it } from "vitest";
import { DeadEndPhase } from "../app";
import {
  DeadEndRateRecordSchema,
  IpcQueryExecution,
  IpcQueryRefusal,
  IpcQuerySource,
  IpcTelemetrySchema,
} from "../ipc";
import { TelemetryAttribute } from "../src/attributes";
import {
  ipcPayload,
  ipcPayloadWithoutSessionCount,
} from "../src/test-fixtures";

describe("IpcTelemetrySchema", () => {
  it("accepts a valid IPC perf wide event", () => {
    expect(
      IpcTelemetrySchema.parse(
        ipcPayload({ [TelemetryAttribute.IpcOperation]: "detail" })
      )
    ).toMatchObject({
      [TelemetryAttribute.IpcOperation]: "detail",
      [TelemetryAttribute.DurationMs]: 42,
      [TelemetryAttribute.IpcMatchedCount]: 250,
      [TelemetryAttribute.IpcPayloadBytes]: 2048,
      [TelemetryAttribute.IpcQueryExecution]:
        IpcQueryExecution.HydratedFallback,
      [TelemetryAttribute.IpcQuerySource]: IpcQuerySource.Canonical,
      [TelemetryAttribute.IpcResultCount]: 25,
      [TelemetryAttribute.IpcScannedCount]: 500,
      [TelemetryAttribute.IpcSessionCount]: 1280,
    });
  });

  it("accepts every published operation value", () => {
    for (const operation of ["list", "detail", "usage", "page_data"]) {
      expect(
        IpcTelemetrySchema.safeParse(
          ipcPayload({ [TelemetryAttribute.IpcOperation]: operation })
        ).success
      ).toBe(true);
    }
  });

  it("accepts every published query source and execution value", () => {
    for (const source of Object.values(IpcQuerySource)) {
      expect(
        IpcTelemetrySchema.safeParse(
          ipcPayload({ [TelemetryAttribute.IpcQuerySource]: source })
        ).success
      ).toBe(true);
    }
    for (const execution of Object.values(IpcQueryExecution)) {
      expect(
        IpcTelemetrySchema.safeParse(
          ipcPayload({ [TelemetryAttribute.IpcQueryExecution]: execution })
        ).success
      ).toBe(true);
    }
  });

  it("accepts every bounded query refusal separately from error.type", () => {
    for (const refusal of Object.values(IpcQueryRefusal)) {
      expect(
        IpcTelemetrySchema.safeParse(
          ipcPayload({
            [TelemetryAttribute.ErrorType]: "SessionListQueryRefusedError",
            [TelemetryAttribute.IpcQueryRefusal]: refusal,
          })
        ).success
      ).toBe(true);
    }
  });

  it("accepts the optional error.type for failed calls", () => {
    expect(
      IpcTelemetrySchema.safeParse(
        ipcPayload({ [TelemetryAttribute.ErrorType]: "DesktopMigrationError" })
      ).success
    ).toBe(true);
  });

  it("accepts large non-negative counts and zero values", () => {
    expect(
      IpcTelemetrySchema.safeParse(
        ipcPayload({
          [TelemetryAttribute.DurationMs]: 0,
          [TelemetryAttribute.IpcPayloadBytes]: 2_000_000_000,
          [TelemetryAttribute.IpcMatchedCount]: 750_000,
          [TelemetryAttribute.IpcResultCount]: 0,
          [TelemetryAttribute.IpcScannedCount]: 1_000_000,
          [TelemetryAttribute.IpcSessionCount]: 1_000_000,
        })
      ).success
    ).toBe(true);
  });

  it("accepts a failed call whose session count could not be measured", () => {
    // ISS-8773: `ipc.session_count` comes from a COUNT the handler runs
    // afterwards, and a db-host distressed enough to fail the handler fails that
    // COUNT with it. The producer omits the dimension rather than fabricating a
    // 0, so requiring it here threw away the whole event — including the
    // `error.type` the failed call exists to record.
    const parsed = IpcTelemetrySchema.parse(
      ipcPayloadWithoutSessionCount({
        [TelemetryAttribute.ErrorType]: "DbHostExitError",
      })
    );
    expect(parsed[TelemetryAttribute.ErrorType]).toBe("DbHostExitError");
    expect(parsed[TelemetryAttribute.IpcSessionCount]).toBeUndefined();
  });

  it("rejects payloads missing any dimension the handler itself measures", () => {
    for (const key of [
      TelemetryAttribute.IpcOperation,
      TelemetryAttribute.DurationMs,
      TelemetryAttribute.IpcPayloadBytes,
      TelemetryAttribute.IpcResultCount,
    ]) {
      const payload = ipcPayload();
      delete (payload as Record<string, unknown>)[key];
      expect(IpcTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects invalid enums, non-integers, negatives, over-cap durations, and unknown attributes", () => {
    for (const payload of [
      ipcPayload({ [TelemetryAttribute.IpcOperation]: "analytics" }),
      ipcPayload({ [TelemetryAttribute.IpcOperation]: 1 }),
      ipcPayload({ [TelemetryAttribute.DurationMs]: -1 }),
      ipcPayload({ [TelemetryAttribute.DurationMs]: 1.5 }),
      ipcPayload({ [TelemetryAttribute.DurationMs]: 86_400_001 }),
      ipcPayload({ [TelemetryAttribute.IpcPayloadBytes]: -1 }),
      ipcPayload({ [TelemetryAttribute.IpcQueryExecution]: "future_path" }),
      ipcPayload({ [TelemetryAttribute.IpcQueryRefusal]: "future_refusal" }),
      ipcPayload({ [TelemetryAttribute.IpcQuerySource]: "future_source" }),
      ipcPayload({ [TelemetryAttribute.IpcResultCount]: 2.5 }),
      ipcPayload({ [TelemetryAttribute.IpcSessionCount]: "1280" }),
      ipcPayload({ [TelemetryAttribute.ErrorType]: "" }),
      ipcPayload({ "ipc.duration_ns": 1 }),
    ]) {
      expect(IpcTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });

  it.each([
    [TelemetryAttribute.IpcMatchedCount, -1],
    [TelemetryAttribute.IpcMatchedCount, 1.5],
    [TelemetryAttribute.IpcMatchedCount, Number.POSITIVE_INFINITY],
    [TelemetryAttribute.IpcMatchedCount, Number.MAX_SAFE_INTEGER + 1],
    [TelemetryAttribute.IpcScannedCount, -1],
    [TelemetryAttribute.IpcScannedCount, 1.5],
    [TelemetryAttribute.IpcScannedCount, Number.POSITIVE_INFINITY],
    [TelemetryAttribute.IpcScannedCount, Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects invalid query population %s=%s", (key, value) => {
    expect(
      IpcTelemetrySchema.safeParse(ipcPayload({ [key]: value })).success
    ).toBe(false);
  });
});

// ISS-12039: the panel tells rate records from `dead_end.treatment` records
// only by `-@dead_end.treatment:*`, so these arms must stay strict.
describe("DeadEndRateRecordSchema", () => {
  it("accepts an IPC call or a rendered dead end, one key each", () => {
    expect(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.IpcOperation]: "page_data",
      }).success
    ).toBe(true);
    expect(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.DeadEndPhase]: DeadEndPhase.Rendered,
      }).success
    ).toBe(true);
  });

  it("rejects a record carrying dead_end.treatment", () => {
    expect(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.DeadEndPhase]: DeadEndPhase.Rendered,
        [TelemetryAttribute.DeadEndTreatment]: "session_detail_not_found",
      }).success
    ).toBe(false);
  });

  it("rejects ipc.operation and dead_end.phase together", () => {
    expect(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.IpcOperation]: "list",
        [TelemetryAttribute.DeadEndPhase]: DeadEndPhase.Rendered,
      }).success
    ).toBe(false);
  });

  it("rejects a dead end in any phase but rendered", () => {
    expect(
      DeadEndRateRecordSchema.safeParse({
        [TelemetryAttribute.DeadEndPhase]: DeadEndPhase.RetryAttempted,
      }).success
    ).toBe(false);
  });
});
