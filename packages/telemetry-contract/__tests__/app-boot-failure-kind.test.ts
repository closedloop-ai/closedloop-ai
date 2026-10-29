import { describe, expect, it } from "vitest";
import { AppTelemetrySchema } from "../app";
import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "../app-boot-failure-kind";
import { TelemetryAttribute } from "../src/attributes";

describe("AppBootFailureOutcome member set (ISS-9259)", () => {
  it("is exactly the two outcomes monitor 319264706's exclusion names", () => {
    // Literals, not `Object.values(AppBootFailureOutcome)` compared against
    // itself: this test's whole job is to fail when the union changes, and a
    // fixture read off the union under test cannot do that.
    expect(Object.values(AppBootFailureOutcome)).toEqual([
      "failed",
      "recovered",
    ]);
  });

  it("keeps the outcome out of the kind, which stays the four ISS-8907 causes", () => {
    // The pairing is the point: a third KIND is a taxonomy change, a third
    // OUTCOME is a cross-repo change. Widening either by editing the other
    // would slip past a test that only pinned one.
    expect(Object.values(AppBootFailureKind)).toEqual([
      "migration_refusal",
      "module_resolution",
      "store_open_timeout",
      "unknown",
    ]);
  });
});

describe("AppTelemetrySchema boot-failure outcome (ISS-9259)", () => {
  it("carries a recovered store-open timeout and a failed one as distinct records", () => {
    const recovered = AppTelemetrySchema.parse({
      [TelemetryAttribute.AppBootFailureKind]:
        AppBootFailureKind.StoreOpenTimeout,
      [TelemetryAttribute.AppBootFailureOutcome]:
        AppBootFailureOutcome.Recovered,
    });
    const failed = AppTelemetrySchema.parse({
      [TelemetryAttribute.AppBootFailureKind]:
        AppBootFailureKind.StoreOpenTimeout,
      [TelemetryAttribute.AppBootFailureOutcome]: AppBootFailureOutcome.Failed,
    });

    expect(recovered[TelemetryAttribute.AppBootFailureOutcome]).toBe(
      "recovered"
    );
    expect(failed[TelemetryAttribute.AppBootFailureOutcome]).toBe("failed");
    // Same kind on both: the ambiguity ISS-9259 exists to resolve is that the
    // kind alone cannot separate these two, so a test that let the kinds differ
    // would prove nothing about the outcome.
    expect(recovered[TelemetryAttribute.AppBootFailureKind]).toBe(
      failed[TelemetryAttribute.AppBootFailureKind]
    );
  });

  it("rejects an outcome outside the closed pair, and the rejection costs the whole record", () => {
    const parsed = AppTelemetrySchema.safeParse({
      [TelemetryAttribute.AppBootFailureKind]:
        AppBootFailureKind.StoreOpenTimeout,
      [TelemetryAttribute.AppBootFailureOutcome]: "retried",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.data).toBeUndefined();
  });

  it("stays omitted rather than defaulted when an older producer sends no outcome", () => {
    // The version-skew shape: an installed build that predates this emits the
    // kind alone. Reading absence as `failed` would recreate the defect, so the
    // record must carry no outcome key at all rather than a filled-in one.
    const parsed = AppTelemetrySchema.parse({
      [TelemetryAttribute.AppBootFailureKind]:
        AppBootFailureKind.StoreOpenTimeout,
    });

    expect(TelemetryAttribute.AppBootFailureOutcome in parsed).toBe(false);
  });
});
