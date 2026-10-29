/**
 * Branch-coverage pin for app/preview-schemas/service.ts's orphan-drop error
 * fold (ISS-11280): `preview-schemas-queue-ttl.test.ts` already covers every
 * CONTENTION shape (`isDropContentionError(dropErr)` true, folded to
 * `orphan.kept`) across all six SQLSTATE/envelope combinations, but no
 * existing test drives a GENERIC (non-contention) failure through this same
 * catch block, so the `isDropContentionError(dropErr)` false arm — the one
 * that actually increments `orphan.errored` — has never run.
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

const mockLogError = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

import { createPreviewSchemaMocks } from "@/__tests__/unit/preview-schemas-mocks";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";

const {
  mockListSchemas,
  mockRegistryRow,
  mockObservationsBatch,
  mockUpsertObservationsBatch,
  mockCleanupStaleObservationsSuccess,
  mockQueryRawOnce,
} = createPreviewSchemaMocks(
  mockWithDb,
  mockListAllBranchNames,
  mockWithMigratorClient
);

describe("previewSchemaCleanupService.runDailySweep — orphan drop generic failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockReset();
    mockWithMigratorClient.mockReset();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a non-contention drop failure as errored, not kept", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_orphan_drop_boom";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString(); // past the 48h grace fallback, so a drop is attempted.

    mockListSchemas([schemaName]);
    mockRegistryRow(null); // orphaned at classification
    mockObservationsBatch([
      { schema_name: schemaName, first_observed_at: firstObserved },
    ]);
    mockUpsertObservationsBatch();
    // isStillDroppable re-check: still no registry row, so the drop proceeds.
    mockQueryRawOnce(null);
    mockWithMigratorClient.mockImplementationOnce(() =>
      Promise.reject(new Error("connection reset"))
    );
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters.orphan.errored).toBe(1);
    expect(result.counters.orphan.dropped).toBe(0);
    expect(result.counters.orphan.kept).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(mockLogError).toHaveBeenCalledWith(
      "[preview-schema-cleanup] Failed to drop orphan schema",
      expect.objectContaining({ schemaName })
    );
  });
});
