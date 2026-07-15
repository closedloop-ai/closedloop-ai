import { describe, expect, it } from "vitest";
import { IpcTelemetrySchema } from "../ipc";
import { TelemetryAttribute } from "../src/attributes";
import { ipcPayload } from "../src/test-fixtures";

describe("IpcTelemetrySchema", () => {
  it("accepts a valid IPC perf wide event", () => {
    expect(
      IpcTelemetrySchema.parse(
        ipcPayload({ [TelemetryAttribute.IpcOperation]: "detail" })
      )
    ).toMatchObject({
      [TelemetryAttribute.IpcOperation]: "detail",
      [TelemetryAttribute.DurationMs]: 42,
      [TelemetryAttribute.IpcPayloadBytes]: 2048,
      [TelemetryAttribute.IpcResultCount]: 25,
      [TelemetryAttribute.IpcSessionCount]: 1280,
    });
  });

  it("accepts every published operation value", () => {
    for (const operation of ["list", "detail", "usage"]) {
      expect(
        IpcTelemetrySchema.safeParse(
          ipcPayload({ [TelemetryAttribute.IpcOperation]: operation })
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
          [TelemetryAttribute.IpcResultCount]: 0,
          [TelemetryAttribute.IpcSessionCount]: 1_000_000,
        })
      ).success
    ).toBe(true);
  });

  it("rejects payloads missing any required core dimension", () => {
    for (const key of [
      TelemetryAttribute.IpcOperation,
      TelemetryAttribute.DurationMs,
      TelemetryAttribute.IpcPayloadBytes,
      TelemetryAttribute.IpcResultCount,
      TelemetryAttribute.IpcSessionCount,
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
      ipcPayload({ [TelemetryAttribute.IpcResultCount]: 2.5 }),
      ipcPayload({ [TelemetryAttribute.IpcSessionCount]: "1280" }),
      ipcPayload({ [TelemetryAttribute.ErrorType]: "" }),
      ipcPayload({ "ipc.duration_ns": 1 }),
    ]) {
      expect(IpcTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});
