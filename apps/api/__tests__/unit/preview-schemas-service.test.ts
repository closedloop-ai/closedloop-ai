/**
 * Unit tests for previewSchemaCleanupService.
 *
 * All DB interactions are mocked via vi.mock("@repo/database").
 * No real database connections are made.
 *
 * withDb is called once per DB operation (listPreviewSchemas, readRegistryRow,
 * readObservation, upsertObservation, cleanupStaleObservations,
 * existence-check in dropSchemaForBranch, executeDrop). Tests chain
 * mockImplementationOnce calls to control each individual call's result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const { mockWithDb, mockListAllBranchNames } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockListAllBranchNames: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { log } from "@repo/observability/log";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets up mockWithDb to return a list of schema names from listPreviewSchemas().
 * listPreviewSchemas calls: withDb(db => db.$queryRaw<{nspname}[]>(...))
 */
function mockListSchemas(names: string[]): void {
  mockQueryRawRowsOnce(names.map((nspname) => ({ nspname })));
}

function mockQueryRawOnce<T>(row: T | null): void {
  mockQueryRawRowsOnce(row ? [row] : []);
}

function mockQueryRawRowsOnce<T>(rows: T[]): void {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      $queryRaw: vi.fn().mockResolvedValue(rows),
    })
  );
}

function mockExecuteRawOnce(
  result: number,
  onQuery?: (query: unknown) => void
): void {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      $executeRaw: vi.fn((query: unknown) => {
        onQuery?.(query);
        return Promise.resolve(result);
      }),
    })
  );
}

function mockExecuteRawUnsafeOnce(result: number): void {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      $executeRawUnsafe: vi.fn().mockResolvedValue(result),
    })
  );
}

function mockExecuteRawFailure(message: string): void {
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({
      $executeRaw: vi.fn().mockRejectedValue(new Error(message)),
    })
  );
}

/**
 * Sets up mockWithDb to return a registry row result for readRegistryRow().
 * readRegistryRow calls: withDb(db => db.$queryRaw<{last_seen_at}[]>(...))
 */
function mockRegistryRow(
  row: { last_seen_at: string; branch?: string | null } | null
): void {
  mockQueryRawOnce(row);
}

/**
 * Sets up mockWithDb to throw SQLSTATE 42P01 (undefined_table) for readRegistryRow().
 */
function mockRegistryTableMissing(): void {
  mockWithDb.mockImplementationOnce((_fn: (db: unknown) => unknown) => {
    const err = new Error("relation does not exist") as Error & {
      code?: string;
    };
    err.code = "42P01";
    return Promise.reject(err);
  });
}

/**
 * Sets up mockWithDb to simulate the existence check in dropSchemaForBranch().
 * Checks pg_namespace: returns a row if the schema exists, empty array if absent.
 */
function mockSchemaExists(schemaName: string, exists: boolean): void {
  mockQueryRawRowsOnce(exists ? [{ nspname: schemaName }] : []);
}

/**
 * Sets up mockWithDb to simulate a successful executeDrop().
 * executeDrop calls: withDb(db => db.$executeRawUnsafe(...))
 */
function mockDropSuccess(): void {
  mockExecuteRawUnsafeOnce(0);
}

/**
 * Sets up mockWithDb to simulate a failed executeDrop().
 */
function mockDropFailure(message: string): void {
  mockWithDb.mockImplementationOnce((_fn: (db: unknown) => unknown) =>
    Promise.reject(new Error(message))
  );
}

/**
 * Configures mockListAllBranchNames to resolve with the given branch list.
 */
function mockGitHubBranches(branches: string[]): void {
  mockListAllBranchNames.mockResolvedValueOnce(branches);
}

/**
 * Configures mockListAllBranchNames to reject (simulates GitHub API failure).
 */
function mockGitHubBranchesFailure(message: string): void {
  mockListAllBranchNames.mockRejectedValueOnce(new Error(message));
}

/**
 * Sets up mockWithDb to return an observation row for readObservation().
 * readObservation calls: withDb(db => db.$queryRaw<{first_observed_at}[]>(...))
 */
function mockObservationRow(row: { first_observed_at: string } | null): void {
  mockQueryRawOnce(row);
}

/**
 * Sets up mockWithDb to simulate a successful upsertObservation().
 * upsertObservation calls: withDb(db => db.$executeRaw(...))
 */
function mockUpsertObservationSuccess(): void {
  mockExecuteRawOnce(1);
}

/**
 * Sets up mockWithDb to simulate a successful cleanupStaleObservations().
 * cleanupStaleObservations calls: withDb(db => db.$executeRaw(...))
 */
function mockCleanupStaleObservationsSuccess(
  onQuery?: (query: unknown) => void
): void {
  mockExecuteRawOnce(0, onQuery);
}

function mockCleanupStaleObservationsFailure(message: string): void {
  mockExecuteRawFailure(message);
}

/**
 * Sets up mockWithDb to throw an error for readObservation().
 */
function mockObservationReadFailure(message: string): void {
  mockWithDb.mockImplementationOnce((_fn: (db: unknown) => unknown) =>
    Promise.reject(new Error(message))
  );
}

const TEST_BRANCH = "feat/cleanup-schemas";
const TEST_SCHEMA = deriveBranchSchemaName(
  TEST_BRANCH,
  normalizePreviewSchemaName
);

// Regex patterns for behavior and SQL-shape validation
const PREVIEW_SCHEMA_PREFIX = /^preview_/;
const CLEANUP_REGISTRY_EXISTS_GUARD_SQL =
  /to_regclass\('public\.preview_schemas'\)\s+IS\s+NOT\s+NULL/;
const CLEANUP_REGISTRY_DELETE_SQL =
  /FROM\s+public\.preview_schemas\s+AS\s+registry/;

type MockSql = {
  strings: readonly string[];
};

function readSqlText(query: unknown): string {
  if (!isMockSql(query)) {
    return "";
  }
  return query.strings.join("");
}

function isMockSql(query: unknown): query is MockSql {
  if (typeof query !== "object" || query === null) {
    return false;
  }
  const candidate = query as { strings?: unknown };
  return (
    Array.isArray(candidate.strings) &&
    candidate.strings.every((part) => typeof part === "string")
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("previewSchemaCleanupService.runDailySweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty summary with zero counters when no preview schemas exist", async () => {
    mockListSchemas([]);
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep();

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters.orphan.dropped).toBe(0);
    // listPreviewSchemas (1) + cleanupStaleObservations (1)
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("preserves active schema (seen within TTL window) and does not drop it", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_active_abc12345";
    const lastSeenAt = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString(); // 2 days ago — within 7-day TTL

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockCleanupStaleObservationsSuccess(); // cleanupStaleObservations at end

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(result.counters["ttl-expired"].dropped).toBe(0);
    expect(result.counters.orphan.dropped).toBe(0);

    // listPreviewSchemas (1) + readRegistryRow (1) + cleanupStaleObservations (1) = 3 calls
    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("drops stale schema (last_seen_at older than TTL) and increments ttl-expired.dropped", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_stale_abc12345";
    const lastSeenAt = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString(); // 10 days ago — exceeds 7-day TTL

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].dropped).toBe(1);
    expect(result.counters["ttl-expired"].errored).toBe(0);

    // listPreviewSchemas (1) + readRegistryRow (1) + executeDrop (1) + cleanup (1) = 4
    expect(mockWithDb).toHaveBeenCalledTimes(4);
  });

  it("observes orphan schema on first encounter and does not drop it (grace window)", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_orphan_abc12345";

    mockListSchemas([schemaName]);
    mockRegistryRow(null); // no registry row → orphaned
    mockObservationRow(null); // first observation — no existing row
    mockUpsertObservationSuccess(); // upsert observation
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters.orphan.dropped).toBe(0);
    expect(result.counters.orphan.kept).toBe(1);

    // list (1) + readRegistry (1) + readObservation (1) + upsertObservation (1) + cleanup (1) = 5
    expect(mockWithDb).toHaveBeenCalledTimes(5);
  });

  it("drops orphan schema when grace window has elapsed", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_orphan_grace_elapsed";
    // Observed 49 hours ago — past 48-hour grace window
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow(null); // orphaned
    mockObservationRow({ first_observed_at: firstObserved }); // already observed
    mockUpsertObservationSuccess(); // upsert (idempotent)
    mockDropSuccess(); // drop the schema
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters.orphan.dropped).toBe(1);
    expect(result.counters.orphan.kept).toBe(0);
  });

  it("keeps orphan schema when within grace window on re-observation", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_orphan_in_grace";
    // Observed 24 hours ago — within 48-hour grace window
    const firstObserved = new Date(
      now.getTime() - 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow(null); // orphaned
    mockObservationRow({ first_observed_at: firstObserved }); // observed but in grace
    mockUpsertObservationSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters.orphan.kept).toBe(1);
    expect(result.counters.orphan.dropped).toBe(0);
  });

  it("drops orphan schema when registry table is missing (42P01) and grace has elapsed", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_orphan_notbl123";
    let cleanupSql = "";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryTableMissing(); // 42P01 → registryTableMissing = true → orphaned
    mockObservationRow({ first_observed_at: firstObserved });
    mockUpsertObservationSuccess();
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess((query) => {
      cleanupSql = readSqlText(query);
    });

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters.orphan.dropped).toBe(1);
    expect(cleanupSql).toMatch(CLEANUP_REGISTRY_EXISTS_GUARD_SQL);
    expect(cleanupSql).toMatch(CLEANUP_REGISTRY_DELETE_SQL);
  });

  it("increments ttl-expired.errored when drop fails and returns exitCode 1", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_stale_dropfail1";
    const lastSeenAt = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockDropFailure("DROP failed: permission denied");
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(1);
    expect(result.counters["ttl-expired"].errored).toBe(1);
    expect(result.counters["ttl-expired"].dropped).toBe(0);
  });

  it("processes mix of active, stale, and orphan schemas correctly", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const active = "preview_active_11111111";
    const stale = "preview_stale_22222222";
    const orphan = "preview_orphan_33333333";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    const recentLastSeen = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const oldLastSeen = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([active, stale, orphan]);
    mockRegistryRow({ last_seen_at: recentLastSeen }); // active
    mockRegistryRow({ last_seen_at: oldLastSeen }); // stale
    mockRegistryRow(null); // orphan (no row)
    mockDropSuccess(); // drop stale
    mockObservationRow({ first_observed_at: firstObserved }); // orphan already observed, grace elapsed
    mockUpsertObservationSuccess(); // upsert observation for orphan
    mockDropSuccess(); // drop orphan (grace elapsed)
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1); // active schema
    expect(result.counters["ttl-expired"].dropped).toBe(1); // stale schema
    expect(result.counters.orphan.dropped).toBe(1); // orphan schema (grace elapsed)

    // list (1) + 3 readRegistry (3) + drop stale (1) + readObs (1) + upsertObs (1) + drop orphan (1) + cleanup (1) = 9
    expect(mockWithDb).toHaveBeenCalledTimes(9);
  });

  it("runs cleanupStaleObservations at the end of sweep", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_active_cleanup1";
    const lastSeenAt = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockCleanupStaleObservationsSuccess();

    await previewSchemaCleanupService.runDailySweep(7);

    // Verify cleanupStaleObservations was called (the last withDb call)
    // list (1) + readRegistry (1) + cleanup (1) = 3
    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("returns a structured sweep result when cleanupStaleObservations fails", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_active_cleanup_failure";
    const lastSeenAt = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockRegistryRow({ last_seen_at: lastSeenAt });
    mockCleanupStaleObservationsFailure("cleanup query timed out");

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(1);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(result.counters.registryReadErrored).toBe(1);
    expect(result.summary).toContain("registry-read[errored=1]");
  });
});

describe("previewSchemaCleanupService.runDailySweep — orphan error isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts observation read failure as orphan.errored while remaining orphans proceed", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanFail = "preview_orphan_fail1111";
    const orphanOk = "preview_orphan_ok222222";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([orphanFail, orphanOk]);
    // Both are orphaned (no registry row)
    mockRegistryRow(null);
    mockRegistryRow(null);
    // First orphan: observation read fails
    mockObservationReadFailure("connection lost during observation read");
    // Second orphan: observation read succeeds, grace elapsed → drop
    mockObservationRow({ first_observed_at: firstObserved });
    mockUpsertObservationSuccess();
    mockDropSuccess();
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.counters.orphan.errored).toBe(1);
    expect(result.counters.orphan.dropped).toBe(1);
    expect(result.exitCode).toBe(1); // errored > 0
  });
});

describe("previewSchemaCleanupService.dropSchemaForBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  it("drops schema and returns dropped=true when schema exists", async () => {
    mockSchemaExists(TEST_SCHEMA, true);
    mockDropSuccess();

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.schemaName).toBe(TEST_SCHEMA);
    expect(result.dropped).toBe(true);
    expect(result.alreadyGone).toBe(false);
    expect(result.error).toBeNull();

    // existence check (1) + executeDrop (1) = 2 calls
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("returns alreadyGone=true and does not call DROP when schema does not exist", async () => {
    mockSchemaExists(TEST_SCHEMA, false);

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.schemaName).toBe(TEST_SCHEMA);
    expect(result.dropped).toBe(false);
    expect(result.alreadyGone).toBe(true);
    expect(result.error).toBeNull();

    // Only the existence check — no drop call
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — re-calling after schema is already gone returns alreadyGone=true without error", async () => {
    // First call: schema gone
    mockSchemaExists(TEST_SCHEMA, false);
    const first =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    // Second call: schema still gone
    mockSchemaExists(TEST_SCHEMA, false);
    const second =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(first.alreadyGone).toBe(true);
    expect(first.error).toBeNull();
    expect(second.alreadyGone).toBe(true);
    expect(second.error).toBeNull();
  });

  it("derived schema name always starts with preview_ for any branch input", async () => {
    // The service derives the schema name via normalizePreviewSchemaName which
    // always produces a preview_-prefixed name. This test verifies the guard
    // is never triggered for valid branch inputs and confirms the derived name
    // is always safe for DROP operations.
    const branches = [
      "feat/cleanup-schemas",
      "main",
      "dependabot/npm_and_yarn/lodash-4.17.21",
      "release/2.0.0",
    ];

    for (const branch of branches) {
      vi.clearAllMocks();
      const derived = deriveBranchSchemaName(
        branch,
        normalizePreviewSchemaName
      );
      expect(derived).toMatch(PREVIEW_SCHEMA_PREFIX);

      // Service should proceed to existence check (not return with guard error)
      mockSchemaExists(derived, false);
      const result =
        await previewSchemaCleanupService.dropSchemaForBranch(branch);
      expect(result.error).toBeNull();
      expect(result.schemaName).toMatch(PREVIEW_SCHEMA_PREFIX);
    }
  });

  it("returns error in result and does not throw when drop fails", async () => {
    mockSchemaExists(TEST_SCHEMA, true);
    mockDropFailure("connection lost during DROP");

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.dropped).toBe(false);
    expect(result.alreadyGone).toBe(false);
    expect(result.error).toBe("connection lost during DROP");
  });
});

describe("previewSchemaCleanupService.runDryRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty report with no schemas", async () => {
    mockListSchemas([]);

    const result = await previewSchemaCleanupService.runDryRun();

    expect(result.wouldDropStale).toEqual([]);
    expect(result.wouldDropOrphaned).toEqual([]);
    expect(result.wouldKeepInGrace).toEqual([]);
    expect(result.keptActive).toEqual([]);
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("classifies stale schema into wouldDropStale without issuing any DROP", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const staleSchema = "preview_stale_dryrun11";
    const oldLastSeen = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([staleSchema]);
    mockRegistryRow({ last_seen_at: oldLastSeen });

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropStale).toEqual([staleSchema]);
    expect(result.wouldDropOrphaned).toEqual([]);
    expect(result.wouldKeepInGrace).toEqual([]);
    expect(result.keptActive).toEqual([]);

    // list (1) + readRegistryRow (1) = 2; no DROP calls, no observation reads for non-orphans
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("classifies orphan with elapsed grace into wouldDropOrphaned", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanSchema = "preview_orphan_dryrun22";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([orphanSchema]);
    mockRegistryRow(null); // orphaned
    mockObservationRow({ first_observed_at: firstObserved }); // grace elapsed

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphaned).toEqual([orphanSchema]);
    expect(result.wouldKeepInGrace).toEqual([]);

    // list (1) + readRegistry (1) + readObservation (1) = 3; no mutations
    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("classifies orphan within grace into wouldKeepInGrace", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanSchema = "preview_orphan_grace_dr";
    const firstObserved = new Date(
      now.getTime() - 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([orphanSchema]);
    mockRegistryRow(null); // orphaned
    mockObservationRow({ first_observed_at: firstObserved }); // within grace

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldKeepInGrace).toEqual([orphanSchema]);
    expect(result.wouldDropOrphaned).toEqual([]);

    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("classifies never-observed orphan into wouldKeepInGrace", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanSchema = "preview_orphan_new_dry1";

    mockListSchemas([orphanSchema]);
    mockRegistryRow(null); // orphaned
    mockObservationRow(null); // never observed

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldKeepInGrace).toEqual([orphanSchema]);
    expect(result.wouldDropOrphaned).toEqual([]);

    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("classifies active schema into keptActive without issuing any DROP", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const activeSchema = "preview_active_dryrun33";
    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([activeSchema]);
    mockRegistryRow({ last_seen_at: recentLastSeen });

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.keptActive).toEqual([activeSchema]);
    expect(result.wouldDropStale).toEqual([]);
    expect(result.wouldDropOrphaned).toEqual([]);
    expect(result.wouldKeepInGrace).toEqual([]);

    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("performs zero DB mutations across a mix of schema categories", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const active = "preview_active_mix11111";
    const stale = "preview_stale_mix222222";
    const orphanNew = "preview_orphan_mix33333";
    const orphanOld = "preview_orphan_mix44444";

    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();
    const oldLastSeen = new Date(
      now.getTime() - 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const firstObservedOld = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([active, stale, orphanNew, orphanOld]);
    mockRegistryRow({ last_seen_at: recentLastSeen }); // active
    mockRegistryRow({ last_seen_at: oldLastSeen }); // stale
    mockRegistryRow(null); // orphanNew
    mockRegistryRow(null); // orphanOld
    mockObservationRow(null); // orphanNew: never observed
    mockObservationRow({ first_observed_at: firstObservedOld }); // orphanOld: grace elapsed

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.keptActive).toEqual([active]);
    expect(result.wouldDropStale).toEqual([stale]);
    expect(result.wouldKeepInGrace).toEqual([orphanNew]);
    expect(result.wouldDropOrphaned).toEqual([orphanOld]);

    // list (1) + 4 registry reads (4) + 2 observation reads (2) = 7 total; no DROP/upsert calls
    expect(mockWithDb).toHaveBeenCalledTimes(7);
  });

  it("includes wouldKeepInGrace count in dry-run summary", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanSchema = "preview_orphan_summ1111";

    mockListSchemas([orphanSchema]);
    mockRegistryRow(null);
    mockObservationRow(null); // first observation → would keep in grace

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.summary).toContain("would-keep-in-grace=1");
    expect(result.summary).toContain("would-drop=0");
  });

  it("keeps dry-run going when an orphan observation read fails", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const failingOrphan = "preview_orphan_dry_fail";
    const oldOrphan = "preview_orphan_dry_old";
    const firstObserved = new Date(
      now.getTime() - 49 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([failingOrphan, oldOrphan]);
    mockRegistryRow(null);
    mockRegistryRow(null);
    mockObservationReadFailure("observation table unavailable");
    mockObservationRow({ first_observed_at: firstObserved });

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldKeepInGrace).toEqual([failingOrphan]);
    expect(result.wouldDropOrphaned).toEqual([oldOrphan]);
    expect(result.counters.orphan.errored).toBe(1);
    expect(result.summary).toContain("observation-read[errored=1]");
  });

  it("returns wouldDropOrphanBranch with schemas whose branch no longer exists on GitHub", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanBranchSchema = "preview_dead_dryrun4444";
    const activeSchema = "preview_live_dryrun5555";
    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([orphanBranchSchema, activeSchema]);
    mockGitHubBranches(["main", "feat/still-open"]); // "feat/deleted" is absent
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/deleted",
    }); // orphanBranchSchema → deleted branch
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/still-open",
    }); // activeSchema → live branch

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual([orphanBranchSchema]);
    expect(result.keptActive).toEqual([activeSchema]);
    expect(result.wouldDropStale).toEqual([]);
    expect(result.wouldDropOrphaned).toEqual([]);

    // list (1) + 2 registry reads (2) = 3 total; no DROP calls
    expect(mockWithDb).toHaveBeenCalledTimes(3);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
  });

  it("returns empty wouldDropOrphanBranch when GitHub API fails (graceful degradation)", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const schemaName = "preview_branchfail_dry5";
    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockGitHubBranchesFailure("GitHub API 503");
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/some-branch",
    });
    // GitHub failed → liveBranches is null → branch-aware pass skipped
    // schema stays active (TTL says active, no reclassification)

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual([]);
    expect(result.keptActive).toEqual([schemaName]);
    expect(result.wouldDropStale).toEqual([]);
    expect(result.wouldDropOrphaned).toEqual([]);

    // list (1) + 1 registry read (1) = 2 total; no DROP calls
    expect(mockWithDb).toHaveBeenCalledTimes(2);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
  });

  it("buildDryRunSummary includes orphan-branch count in the summary string", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-15T00:00:00.000Z");
    vi.setSystemTime(now);

    const orphanBranchSchema = "preview_dead_summary111";
    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([orphanBranchSchema]);
    mockGitHubBranches(["main"]); // "feat/gone" is absent
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/gone",
    });

    const result = await previewSchemaCleanupService.runDryRun(7);

    expect(result.wouldDropOrphanBranch).toEqual([orphanBranchSchema]);
    // Summary must mention orphan-branch count
    expect(result.summary).toContain("orphan-branch=1");
    // Total would-drop should account for the orphan-branch
    expect(result.summary).toContain("would-drop=1");
  });
});

// ---------------------------------------------------------------------------
// Branch-aware sweep tests
// ---------------------------------------------------------------------------

describe("previewSchemaCleanupService — branch-aware sweep (partitionDecisionsWithBranch / fetchLiveBranches)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllBranchNames.mockResolvedValue(["main"]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schema with a branch that no longer exists on GitHub is categorized as orphan-branch and dropped", async () => {
    const schemaName = "preview_stale_b1111111";
    const recentLastSeen = new Date(
      new Date("2026-01-15T00:00:00.000Z").getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString(); // 2 days ago — active TTL-wise

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", "develop"]); // deleted-branch is absent
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "deleted-branch",
    });
    mockDropSuccess(); // orphan-branch drop
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["orphan-branch"].dropped).toBe(1);
    expect(result.counters["ttl-expired"].kept).toBe(0);
    // list (1) + readRegistryRow (1) + executeDrop (1) + cleanup (1)
    expect(mockWithDb).toHaveBeenCalledTimes(4);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
  });

  it("schema with a branch that still exists on GitHub remains active", async () => {
    const schemaName = "preview_active_b2222222";
    const recentLastSeen = new Date(
      new Date("2026-01-15T00:00:00.000Z").getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString(); // 1 day ago — active TTL-wise

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main", "feat/still-open"]);
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/still-open",
    });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(result.counters["orphan-branch"].dropped).toBe(0);
    // list (1) + readRegistryRow (1) + cleanup (1); no drop call
    expect(mockWithDb).toHaveBeenCalledTimes(3);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
  });

  it("schema with NULL branch is skipped by the branch-aware pass and left for TTL handling", async () => {
    const schemaName = "preview_nobranch_333333";
    const recentLastSeen = new Date(
      new Date("2026-01-15T00:00:00.000Z").getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString(); // within TTL — should be kept active

    mockListSchemas([schemaName]);
    mockGitHubBranches(["main"]); // null-branch schema is not reclassified
    mockRegistryRow({ last_seen_at: recentLastSeen, branch: null });
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1); // kept by TTL logic
    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("GitHub API failure causes fetchLiveBranches to return null and the branch-aware pass is skipped entirely", async () => {
    const schemaName = "preview_branchfail_4444";
    const recentLastSeen = new Date(
      new Date("2026-01-15T00:00:00.000Z").getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();

    mockListSchemas([schemaName]);
    mockGitHubBranchesFailure("GitHub API 503");
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "some-branch",
    });
    // GitHub failed → liveBranches is null → branch-aware pass skipped
    // schema is kept as active (TTL says active, no branch reclassification)
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(1);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
    // list (1) + readRegistryRow (1) + cleanup (1); no drop
    expect(mockWithDb).toHaveBeenCalledTimes(3);
  });

  it("runDailySweep integration: branch-aware pass correctly separates live, deleted-branch, and null-branch schemas", async () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const recentLastSeen = new Date(
      now.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const oldLastSeen = new Date(
      now.getTime() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();

    const liveBranchSchema = "preview_live_b5555555";
    const deadBranchSchema = "preview_dead_b6666666";
    const nullBranchSchema = "preview_null_b7777777";
    const staleSchema = "preview_stale_b8888888";

    mockListSchemas([
      liveBranchSchema,
      deadBranchSchema,
      nullBranchSchema,
      staleSchema,
    ]);
    mockGitHubBranches(["main", "feat/live-branch"]);

    // registry rows in schema order
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/live-branch",
    }); // liveBranchSchema → active (branch still exists)
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: "feat/deleted-branch",
    }); // deadBranchSchema → orphan-branch (branch gone)
    mockRegistryRow({
      last_seen_at: recentLastSeen,
      branch: null,
    }); // nullBranchSchema → active (null branch skips branch check)
    mockRegistryRow({
      last_seen_at: oldLastSeen,
      branch: "feat/old",
    }); // staleSchema → stale (TTL expired)

    mockDropSuccess(); // drop staleSchema (ttl-expired)
    mockDropSuccess(); // drop deadBranchSchema (orphan-branch)
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(2); // liveBranchSchema + nullBranchSchema
    expect(result.counters["ttl-expired"].dropped).toBe(1); // staleSchema
    expect(result.counters["orphan-branch"].dropped).toBe(1); // deadBranchSchema
    expect(result.counters.orphan.dropped).toBe(0);

    // list (1) + 4 registry reads (4) + 2 drops (2) + cleanup (1) = 8 calls
    expect(mockWithDb).toHaveBeenCalledTimes(8);
    expect(mockListAllBranchNames).toHaveBeenCalledTimes(1);
  });

  it("skips the branch-aware pass when orphan candidates exceed the mass-drop cap", async () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const recentLastSeen = new Date(
      now.getTime() - 1 * 24 * 60 * 60 * 1000
    ).toISOString();
    const schemaNames = Array.from(
      { length: 12 },
      (_unused, index) =>
        `preview_mass_cap_${index.toString().padStart(2, "0")}`
    );

    mockListSchemas(schemaNames);
    mockGitHubBranches([
      "main",
      "feat/live-0",
      "feat/live-1",
      "feat/live-2",
      "feat/live-3",
      "feat/live-4",
    ]);

    for (let index = 0; index < schemaNames.length; index += 1) {
      mockRegistryRow({
        last_seen_at: recentLastSeen,
        branch:
          index < 5 ? `feat/live-${index}` : `refs/heads/feat/live-${index}`,
      });
    }
    mockCleanupStaleObservationsSuccess();

    const result = await previewSchemaCleanupService.runDailySweep(7);

    expect(result.exitCode).toBe(0);
    expect(result.counters["orphan-branch"].dropped).toBe(0);
    expect(result.counters["ttl-expired"].kept).toBe(12);
    expect(mockWithDb).toHaveBeenCalledTimes(14);
    expect(log.warn).toHaveBeenCalledWith(
      "[preview-schema-cleanup] Skipping branch-aware pass: orphan-branch candidates exceed mass-drop cap",
      expect.objectContaining({
        branchAwareCandidateCount: 12,
        orphanBranchCandidateCount: 7,
      })
    );
  });
});
