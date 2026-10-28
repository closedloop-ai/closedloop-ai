/**
 * Branch-coverage pins for app/preview-schemas/service.ts's private
 * `getDefaultTtlDays` (ISS-11280): every existing call in
 * preview-schemas-service.test.ts passes an explicit `ttlDays` argument to
 * `runDailySweep`/`runDryRun`, which bypasses the default-parameter
 * `getDefaultTtlDays()` expression entirely, and none of them set
 * `PREVIEW_SCHEMA_TTL_DAYS` — so the "env var IS set" arm (valid override, and
 * the invalid-value fallback) has never run. These tests call
 * `runDailySweep()` with no argument so the default parameter fires, and
 * prove the parsed value was actually USED (not just parsed) by classifying a
 * schema whose age falls on the DIFFERENT side of the fallback (7 days) vs.
 * the override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockWithMigratorClient,
  mockListAllBranchNames,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
  mockListAllBranchNames: vi.fn(),
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

import { createPreviewSchemaMocks } from "@/__tests__/unit/preview-schemas-mocks";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";

const {
  mockListSchemas,
  mockRegistryRow,
  mockDropSuccess,
  mockCleanupStaleObservationsSuccess,
  mockObservationsBatch,
  mockUpsertObservationsBatch,
  mockOrphanDropSuccess,
} = createPreviewSchemaMocks(
  mockWithDb,
  mockListAllBranchNames,
  mockWithMigratorClient
);

const TTL_ENV_KEY = "PREVIEW_SCHEMA_TTL_DAYS";
const GRACE_ENV_KEY = "PREVIEW_ORPHAN_GRACE_HOURS";

describe("previewSchemaCleanupService.runDailySweep — PREVIEW_SCHEMA_TTL_DAYS default", () => {
  const hadEnvOriginally = Object.hasOwn(process.env, TTL_ENV_KEY);
  const originalEnv = process.env[TTL_ENV_KEY];

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithMigratorClient.mockReset();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (hadEnvOriginally) {
      process.env[TTL_ENV_KEY] = originalEnv as string;
    } else {
      Reflect.deleteProperty(process.env, TTL_ENV_KEY);
    }
  });

  it("drops a schema the 7-day fallback would keep active, when PREVIEW_SCHEMA_TTL_DAYS overrides it lower", async () => {
    process.env[TTL_ENV_KEY] = "3";

    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_ttl_env_abc12345";
    const lastSeenAt = new Date(
      now.getTime() - 5 * 24 * 60 * 60 * 1000
    ).toISOString(); // 5 days ago: within the 7-day fallback, past a 3-day override.

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess();

    // No ttlDays argument: exercises the getDefaultTtlDays() default param.
    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.counters["ttl-expired"].dropped).toBe(1);
    expect(result.counters["ttl-expired"].kept).toBe(0);
  });

  it("falls back to the 7-day default when PREVIEW_SCHEMA_TTL_DAYS is set but not a valid positive number", async () => {
    // "0" is finite but not > 0, so it still exercises the invalid-value
    // fallback arm. A non-numeric string like "not-a-number" cannot: it
    // parses to NaN, and `lastSeenAt < new Date(NaN)` is false regardless of
    // whether the `n > 0` guard exists, so that value can never fail this
    // test.
    process.env[TTL_ENV_KEY] = "0";

    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_ttl_env_invalid_abc12345";
    const lastSeenAt = new Date(
      now.getTime() - 5 * 24 * 60 * 60 * 1000
    ).toISOString(); // 5 days ago: stays active only under the 7-day fallback.

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(result.counters["ttl-expired"].dropped).toBe(0);
  });
});

describe("previewSchemaCleanupService.runDailySweep — PREVIEW_ORPHAN_GRACE_HOURS default", () => {
  const hadEnvOriginally = Object.hasOwn(process.env, GRACE_ENV_KEY);
  const originalEnv = process.env[GRACE_ENV_KEY];

  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithMigratorClient.mockReset();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (hadEnvOriginally) {
      process.env[GRACE_ENV_KEY] = originalEnv as string;
    } else {
      Reflect.deleteProperty(process.env, GRACE_ENV_KEY);
    }
  });

  it("drops a previously-observed orphan the 48h fallback would still keep in grace, when PREVIEW_ORPHAN_GRACE_HOURS overrides it to 0", async () => {
    process.env[GRACE_ENV_KEY] = "0";

    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_grace_env_abc12345";
    // Observed 1 hour ago: well within the 48h fallback (would be KEPT), but
    // a graceHours=0 override makes any previously-observed orphan eligible.
    const firstObserved = new Date(
      now.getTime() - 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow(null); // orphaned
    mockObservationsBatch([
      { schema_name: schemaName, first_observed_at: firstObserved },
    ]);
    mockUpsertObservationsBatch();
    mockOrphanDropSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters.orphan.dropped).toBe(1);
    expect(result.counters.orphan.kept).toBe(0);
  });

  it("falls back to the 48h default when PREVIEW_ORPHAN_GRACE_HOURS is set but negative", async () => {
    process.env[GRACE_ENV_KEY] = "-5";

    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_grace_env_invalid_abc12345";
    const firstObserved = new Date(
      now.getTime() - 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow(null);
    mockObservationsBatch([
      { schema_name: schemaName, first_observed_at: firstObserved },
    ]);
    mockUpsertObservationsBatch();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters.orphan.kept).toBe(1);
    expect(result.counters.orphan.dropped).toBe(0);
  });
});
