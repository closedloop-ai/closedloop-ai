/**
 * Shared `withDb` / GitHub mock harness for the preview-schema cleanup tests.
 *
 * The cleanup service issues one `withDb` call per DB operation
 * (listPreviewSchemas, readRegistryRow, readObservation, upsertObservation,
 * cleanupStaleObservations, the existence check in dropSchemaForBranch, and
 * executeDrop), so tests drive it by chaining `mockImplementationOnce` calls in
 * the order the sweep performs them. These helpers name each of those steps.
 *
 * The mocks themselves are `vi.hoisted()` per test file, so this module takes
 * them as arguments rather than owning them — call `createPreviewSchemaMocks`
 * once per file with that file's hoisted mocks.
 */

import { vi } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;

type MockSql = {
  strings: readonly string[];
};

export type PreviewSchemaMocks = ReturnType<typeof createPreviewSchemaMocks>;

/**
 * Reads the SQL text out of the `Prisma.sql` stand-in the test module mocks in,
 * for assertions on statement shape. Returns `""` for anything that is not that
 * shape, so a caller's `.toMatch()` fails loudly instead of throwing.
 */
export function readSqlText(query: unknown): string {
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

export function createPreviewSchemaMocks(
  mockWithDb: MockFn,
  mockListAllBranchNames: MockFn,
  mockWithDbTx: MockFn
) {
  function mockQueryRawRowsOnce<T>(rows: T[]): void {
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        $queryRaw: vi.fn().mockResolvedValue(rows),
      })
    );
  }

  function mockQueryRawOnce<T>(row: T | null): void {
    mockQueryRawRowsOnce(row ? [row] : []);
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

  /** Rejects the whole `withDb` call, as a connection-level failure would. */
  function mockWithDbRejectsOnce(message: string): void {
    mockWithDb.mockImplementationOnce((_fn: (db: unknown) => unknown) =>
      Promise.reject(new Error(message))
    );
  }

  /**
   * listPreviewSchemas: withDb(db => db.$queryRaw<{nspname}[]>(...))
   */
  function mockListSchemas(names: string[]): void {
    mockQueryRawRowsOnce(names.map((nspname) => ({ nspname })));
  }

  /** readRegistryRow: one row, or none when `null`. */
  function mockRegistryRow(
    row: { last_seen_at: string; branch?: string | null } | null
  ): void {
    mockQueryRawOnce(row);
  }

  /** readRegistryRow throwing SQLSTATE 42P01 (undefined_table). */
  function mockRegistryTableMissing(): void {
    mockWithDb.mockImplementationOnce((_fn: (db: unknown) => unknown) => {
      const err = new Error("relation does not exist") as Error & {
        code?: string;
      };
      err.code = "42P01";
      return Promise.reject(err);
    });
  }

  /** The pg_namespace existence check inside dropSchemaForBranch. */
  function mockSchemaExists(schemaName: string, exists: boolean): void {
    mockQueryRawRowsOnce(exists ? [{ nspname: schemaName }] : []);
  }

  /**
   * executeDrop: `withDb.tx(tx => { SET LOCAL …; SET LOCAL …; DROP … })`.
   *
   * The DROP runs in a transaction so `SET LOCAL lock_timeout` pins to the same
   * connection, so it consumes a `withDb.tx` call, not a `withDb` one.
   */
  function mockTransactionalDropOnce(): void {
    mockWithDbTx.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({
        $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      })
    );
  }

  /**
   * A successful drop of a TTL-expired / orphan-branch schema.
   *
   * Queues both halves of the real sequence: the `isStillDroppable` registry
   * re-read (answered with an ancient `last_seen_at`, i.e. "nothing
   * re-registered it since classification"), then the transactional DROP.
   */
  function mockDropSuccess(): void {
    mockQueryRawOnce({
      last_seen_at: new Date(0).toISOString(),
      branch: null,
    });
    mockTransactionalDropOnce();
  }

  /**
   * A successful drop of an ORPHAN schema. Same shape as
   * {@link mockDropSuccess}, but the re-read answers "still no registry row",
   * which is what clears an orphan for dropping.
   */
  function mockOrphanDropSuccess(): void {
    mockQueryRawOnce(null);
    mockTransactionalDropOnce();
  }

  /**
   * The re-verification read finding the schema was re-registered since
   * classification, so the drop must be skipped. No DROP is queued.
   */
  function mockDropBlockedByRevalidation(lastSeenAt: string): void {
    mockQueryRawOnce({ last_seen_at: lastSeenAt, branch: null });
  }

  /**
   * executeDrop rejecting with an arbitrary error, after a re-verification read
   * that clears the schema for dropping.
   */
  function mockDropFailure(message: string): void {
    mockQueryRawOnce({
      last_seen_at: new Date(0).toISOString(),
      branch: null,
    });
    mockWithDbTx.mockImplementationOnce((_fn: (tx: unknown) => unknown) =>
      Promise.reject(new Error(message))
    );
  }

  /**
   * executeDrop rejecting the way Postgres declines a busy schema: SQLSTATE
   * 55P03 (`lock_not_available`) or 57014 (`query_canceled`).
   */
  function mockDropContention(
    sqlState: "55P03" | "57014" = "55P03",
    shape: "prisma-raw" | "direct" = "prisma-raw"
  ): void {
    mockQueryRawOnce({
      last_seen_at: new Date(0).toISOString(),
      branch: null,
    });
    mockWithDbTx.mockImplementationOnce((_fn: (tx: unknown) => unknown) => {
      const err = new Error(
        "canceling statement due to lock timeout"
      ) as Error & {
        code?: string;
        meta?: { code: string };
      };
      if (shape === "prisma-raw") {
        // How Prisma actually reports a failed raw query: its own P2010 on
        // `code`, with the driver's SQLSTATE nested in `meta.code`.
        err.code = "P2010";
        err.meta = { code: sqlState };
      } else {
        // Some adapters surface the SQLSTATE directly.
        err.code = sqlState;
      }
      return Promise.reject(err);
    });
  }

  /**
   * The registry re-read `isStillDroppable` performs immediately before each
   * DROP. Pass the row the registry returns NOW (not what classification saw):
   * `null` means no row.
   */
  function mockRevalidateRegistry(
    row: { last_seen_at: string; branch?: string | null } | null
  ): void {
    mockQueryRawOnce(row);
  }

  /** readObservations: ONE $queryRaw returning every orphan's row. */
  function mockObservationsBatch(
    rows: Array<{ schema_name: string; first_observed_at: string }>
  ): void {
    mockQueryRawRowsOnce(rows);
  }

  /** upsertObservations: ONE $executeRaw for the whole batch. */
  function mockUpsertObservationsBatch(): void {
    mockExecuteRawOnce(1);
  }

  return {
    mockDropContention,
    mockRevalidateRegistry,
    mockOrphanDropSuccess,
    mockDropBlockedByRevalidation,
    mockTransactionalDropOnce,
    mockObservationsBatch,
    mockUpsertObservationsBatch,
    mockQueryRawOnce,
    mockQueryRawRowsOnce,
    mockExecuteRawOnce,
    mockExecuteRawUnsafeOnce,
    mockExecuteRawFailure,
    mockListSchemas,
    mockRegistryRow,
    mockRegistryTableMissing,
    mockSchemaExists,
    mockDropSuccess,
    mockDropFailure,
    mockObservationReadFailure: mockWithDbRejectsOnce,
    mockCleanupStaleObservationsFailure: mockExecuteRawFailure,

    /** readObservation: one row, or none when `null`. */
    mockObservationRow(row: { first_observed_at: string } | null): void {
      mockQueryRawOnce(row);
    },

    /** upsertObservation: withDb(db => db.$executeRaw(...)) */
    mockUpsertObservationSuccess(): void {
      mockExecuteRawOnce(1);
    },

    /** cleanupStaleObservations: withDb(db => db.$executeRaw(...)) */
    mockCleanupStaleObservationsSuccess(
      onQuery?: (query: unknown) => void
    ): void {
      mockExecuteRawOnce(0, onQuery);
    },

    /** listAllBranchNames resolving with the given live-branch list. */
    mockGitHubBranches(branches: string[]): void {
      mockListAllBranchNames.mockResolvedValueOnce(branches);
    },

    /** listAllBranchNames rejecting (GitHub API failure). */
    mockGitHubBranchesFailure(message: string): void {
      mockListAllBranchNames.mockRejectedValueOnce(new Error(message));
    },
  };
}
