import { describe, expect, it } from "vitest";
import { TelemetryAttribute } from "../src/attributes";
import { syncPayload } from "../src/test-fixtures";
import { SyncTelemetrySchema } from "../sync";

describe("SyncTelemetrySchema", () => {
  it("accepts valid sync transport-health attributes", () => {
    expect(
      SyncTelemetrySchema.parse({
        [TelemetryAttribute.SyncEvent]: "batch",
        [TelemetryAttribute.SyncOutcome]: "dead_letter",
        [TelemetryAttribute.SyncPayloadBytes]: 512,
        [TelemetryAttribute.SyncLatencyMs]: 12.5,
      })
    ).toMatchObject({
      [TelemetryAttribute.SyncEvent]: "batch",
      [TelemetryAttribute.SyncOutcome]: "dead_letter",
    });
  });

  it("accepts an empty payload because every sync attribute is optional", () => {
    expect(SyncTelemetrySchema.parse({})).toEqual({});
  });

  it("accepts non-negative numeric values above legacy review caps", () => {
    expect(
      SyncTelemetrySchema.parse(
        syncPayload({
          [TelemetryAttribute.SyncPayloadBytes]: 2_000_000_000,
          [TelemetryAttribute.SyncLatencyMs]: 90_000_000,
        })
      )
    ).toMatchObject({
      [TelemetryAttribute.SyncPayloadBytes]: 2_000_000_000,
      [TelemetryAttribute.SyncLatencyMs]: 90_000_000,
    });
  });

  it("rejects invalid enums, wrong primitive types, invalid numbers, and unknown attributes", () => {
    for (const payload of [
      syncPayload({ [TelemetryAttribute.SyncEvent]: "session" }),
      syncPayload({ [TelemetryAttribute.SyncOutcome]: "partial" }),
      syncPayload({ [TelemetryAttribute.SyncPayloadBytes]: -1 }),
      syncPayload({ [TelemetryAttribute.SyncPayloadBytes]: 1.5 }),
      syncPayload({ [TelemetryAttribute.SyncPayloadBytes]: "128" }),
      syncPayload({ [TelemetryAttribute.SyncLatencyMs]: -1 }),
      syncPayload({ [TelemetryAttribute.SyncLatencyMs]: Number.NaN }),
      syncPayload({ [TelemetryAttribute.SyncLatencyMs]: "12" }),
      syncPayload({ "sync.session_id": "session-123" }),
    ]) {
      expect(SyncTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});
