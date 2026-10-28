import { describe, expect, it } from "vitest";
import { SyncTelemetryAttributes, TelemetryAttribute } from "../src/attributes";
import { syncPayload } from "../src/test-fixtures";
import { SyncReason, SyncTelemetrySchema } from "../sync";

describe("SyncTelemetrySchema", () => {
  it("accepts valid sync transport-health attributes", () => {
    expect(
      SyncTelemetrySchema.parse({
        [TelemetryAttribute.SyncEvent]: "batch",
        [TelemetryAttribute.SyncOutcome]: "dead_letter",
        [TelemetryAttribute.SyncPayloadBytes]: 512,
        [TelemetryAttribute.SyncLatencyMs]: 12.5,
        [TelemetryAttribute.SyncReason]: "ack_timeout",
      })
    ).toMatchObject({
      [TelemetryAttribute.SyncEvent]: "batch",
      [TelemetryAttribute.SyncOutcome]: "dead_letter",
      [TelemetryAttribute.SyncReason]: "ack_timeout",
    });
  });

  it("accepts every closed-enum sync.reason value (FEA-3426)", () => {
    for (const reason of Object.values(SyncReason)) {
      expect(
        SyncTelemetrySchema.parse(
          syncPayload({ [TelemetryAttribute.SyncReason]: reason })
        )
      ).toMatchObject({ [TelemetryAttribute.SyncReason]: reason });
    }
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

  it("accepts a freshest-session lag in whole milliseconds (ISS-7496)", () => {
    expect(
      SyncTelemetrySchema.parse(
        syncPayload({
          [TelemetryAttribute.SyncFreshestSessionLagMs]: 934_000,
        })
      )
    ).toMatchObject({
      [TelemetryAttribute.SyncFreshestSessionLagMs]: 934_000,
    });
  });

  it("rejects a freshest-session lag that is negative, fractional, or not a number (ISS-7496)", () => {
    for (const payload of [
      syncPayload({ [TelemetryAttribute.SyncFreshestSessionLagMs]: -1 }),
      syncPayload({ [TelemetryAttribute.SyncFreshestSessionLagMs]: 1.5 }),
      syncPayload({
        [TelemetryAttribute.SyncFreshestSessionLagMs]: Number.NaN,
      }),
      syncPayload({ [TelemetryAttribute.SyncFreshestSessionLagMs]: "934000" }),
    ]) {
      expect(SyncTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });

  it("admits app.organization.id so a sync batch names the tenant it belongs to (ISS-7220)", () => {
    expect(
      SyncTelemetrySchema.parse(
        syncPayload({
          "app.organization.id": "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
        })
      )
    ).toMatchObject({
      "app.organization.id": "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
    });
  });

  it("admits app.operating_mode so an omitted org is readable as unresolved rather than absent (ISS-7220)", () => {
    expect(
      SyncTelemetrySchema.parse(
        syncPayload({ "app.operating_mode": "multiplayer" })
      )
    ).toMatchObject({ "app.operating_mode": "multiplayer" });
    expect(
      SyncTelemetrySchema.parse(
        syncPayload({ "app.operating_mode": "single_player" })
      )
    ).toMatchObject({ "app.operating_mode": "single_player" });
    expect(
      SyncTelemetrySchema.safeParse(
        syncPayload({ "app.operating_mode": "enterprise" })
      ).success
    ).toBe(false);
  });

  it("rejects an organization id that is empty, over-length, or carries control characters (ISS-7220)", () => {
    for (const organizationId of ["", "o".repeat(65), "org\u0001id"]) {
      expect(
        SyncTelemetrySchema.safeParse(
          syncPayload({ "app.organization.id": organizationId })
        ).success
      ).toBe(false);
    }
    expect(
      SyncTelemetrySchema.safeParse(
        syncPayload({ "app.organization.id": "o".repeat(64) })
      ).success
    ).toBe(true);
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
      syncPayload({ [TelemetryAttribute.SyncReason]: "nope" }),
      syncPayload({ "sync.session_id": "session-123" }),
    ]) {
      expect(SyncTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("SyncTelemetryAttributes", () => {
  it("advertises exactly the key set SyncTelemetrySchema admits (ISS-7220)", () => {
    expect(new Set<string>(SyncTelemetryAttributes)).toEqual(
      new Set(Object.keys(SyncTelemetrySchema.shape))
    );
  });

  it("names the two ISS-7220 org-attribution keys, so the published inventory is not a stale answer", () => {
    // Literal strings rather than `TelemetryAttribute.*`: a deleted enum member
    // evaluates to `undefined` on BOTH sides of a reference-based comparison,
    // which is exactly the shape of assertion that cannot fail.
    expect(new Set<string>(SyncTelemetryAttributes)).toContain(
      "app.organization.id"
    );
    expect(new Set<string>(SyncTelemetryAttributes)).toContain(
      "app.operating_mode"
    );
  });
});
