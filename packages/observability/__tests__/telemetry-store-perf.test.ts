/**
 * @file telemetry-store-perf.test.ts
 * @description ISS-6339 — the `storePerf` and `migrationStep` diagnostics must
 * survive `desktopTelemetryEventSchema`, the wire validator every desktop
 * telemetry event crosses.
 *
 * Two distinct failure shapes are pinned here, and they are not the same bug:
 *
 *  1. The top-level diagnostics object STRIPS unknown keys, so a field the
 *     desktop emits and this schema does not mirror vanishes in silence — the
 *     dashboard is simply empty and nothing errors.
 *  2. A bounded field's `z.enum` REJECTS an unmirrored member, and that failure
 *     is not scoped to the field: the whole event is dropped. A single new
 *     statement family known only to the producer would therefore take every
 *     store-performance sample with it.
 *
 * The producer-side suite stops at the emitter, so without this nothing pins
 * either boundary.
 */
import { describe, expect, it } from "vitest";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import {
  MigrationStepOutcome,
  SqlStatementFamily,
} from "../telemetry/store-integrity";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A sample shaped exactly as `reportStorePerfSample` emits it. */
const VALID_STORE_PERF = {
  windowMs: 1_800_000,
  slowQueryThresholdMs: 100,
  bucketBoundsMs: [1, 5, 10, 50, 100, 500, 1000],
  families: [
    {
      family: SqlStatementFamily.Select,
      count: 4210,
      slowCount: 3,
      maxDurationMs: 1477,
      buckets: [3800, 300, 60, 40, 7, 2, 0, 1],
    },
  ],
  dbSizeBytes: 2_147_483_648,
  walSizeBytes: 4_194_304,
} as const;

const VALID_MIGRATION_STEP = {
  name: "0042_iss4586_session_status_ends_with_error",
  outcome: MigrationStepOutcome.Applied,
  durationMs: 812,
} as const;

function eventWith(diagnostics: Record<string, unknown>, category: string) {
  return {
    schemaVersion: "1",
    category,
    severity: "info",
    timestamp: "2026-08-19T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics,
  };
}

function parsedStorePerf(storePerf: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith({ storePerf }, TelemetryCategory.StorePerfSample)
  );
  return parsed.success ? parsed.data.diagnostics?.storePerf : undefined;
}

describe("storePerf diagnostics wire schema (ISS-6339)", () => {
  it("carries every gauge, bucket and family label through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(
        { storePerf: VALID_STORE_PERF },
        TelemetryCategory.StorePerfSample
      )
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.category).toBe(
      TelemetryCategory.StorePerfSample
    );
    // Deep-equal, not a field spot-check: a stripped key is the failure mode,
    // and asserting only the fields someone remembered is how it stays hidden.
    expect(parsedStorePerf(VALID_STORE_PERF)).toEqual(VALID_STORE_PERF);
  });

  it("accepts a sample whose size gauges could not be read", () => {
    const { dbSizeBytes, walSizeBytes, ...withoutSizes } = VALID_STORE_PERF;
    expect(dbSizeBytes).toBeGreaterThan(0);
    expect(walSizeBytes).toBeGreaterThan(0);
    const parsed = parsedStorePerf(withoutSizes);
    expect(parsed).toEqual(withoutSizes);
    // OMITTED, never coerced to 0 — a zero here would read as an empty store.
    expect(parsed && "dbSizeBytes" in parsed).toBe(false);
    expect(parsed && "walSizeBytes" in parsed).toBe(false);
  });

  it("every statement family the producer can emit validates", () => {
    for (const family of Object.values(SqlStatementFamily)) {
      const parsed = parsedStorePerf({
        ...VALID_STORE_PERF,
        families: [{ ...VALID_STORE_PERF.families[0], family }],
      });
      expect(parsed?.families[0]?.family).toBe(family);
    }
  });

  it("drops the WHOLE event for a statement family this schema does not mirror", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(
        {
          storePerf: {
            ...VALID_STORE_PERF,
            families: [{ ...VALID_STORE_PERF.families[0], family: "vacuum" }],
          },
        },
        TelemetryCategory.StorePerfSample
      )
    );
    // Not "the family field was dropped" — the entire event fails to parse.
    // This is the consequence `no-unmirrored-desktop-telemetry-enum` exists to
    // stop, asserted rather than described.
    expect(parsed.success).toBe(false);
  });

  it("rejects a family row that reports zero statements", () => {
    // A family that ran nothing is omitted by the producer entirely. A zero row
    // here means the producer materialized the row before it counted anything,
    // which would dilute every rate computed over `families`.
    //
    // The positive control is load-bearing: `undefined` is also what a REMOVED
    // `storePerf` field returns, so without it this case would stay green while
    // the schema knew nothing about the payload at all.
    expect(parsedStorePerf(VALID_STORE_PERF)).toBeDefined();
    expect(
      parsedStorePerf({
        ...VALID_STORE_PERF,
        families: [{ ...VALID_STORE_PERF.families[0], count: 0 }],
      })
    ).toBeUndefined();
  });

  it("cannot carry more families than the enum has members", () => {
    const families = Object.values(SqlStatementFamily).map((family) => ({
      ...VALID_STORE_PERF.families[0],
      family,
    }));
    expect(parsedStorePerf({ ...VALID_STORE_PERF, families })).toBeDefined();
    expect(
      parsedStorePerf({
        ...VALID_STORE_PERF,
        families: [...families, families[0]],
      })
    ).toBeUndefined();
  });
});

describe("migrationStep diagnostics wire schema (ISS-6339)", () => {
  it("carries the migration name, outcome and duration through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(
        { migrationStep: VALID_MIGRATION_STEP },
        TelemetryCategory.StoreMigrationStep
      )
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.diagnostics?.migrationStep).toEqual(
      VALID_MIGRATION_STEP
    );
  });

  it("every outcome the producer can emit validates", () => {
    for (const outcome of Object.values(MigrationStepOutcome)) {
      const parsed = desktopTelemetryEventSchema.safeParse(
        eventWith(
          { migrationStep: { ...VALID_MIGRATION_STEP, outcome } },
          TelemetryCategory.StoreMigrationStep
        )
      );
      expect(
        parsed.success && parsed.data.diagnostics?.migrationStep?.outcome
      ).toBe(outcome);
    }
  });

  it("drops the WHOLE event for an outcome this schema does not mirror", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(
        { migrationStep: { ...VALID_MIGRATION_STEP, outcome: "skipped" } },
        TelemetryCategory.StoreMigrationStep
      )
    );
    expect(parsed.success).toBe(false);
  });
});
