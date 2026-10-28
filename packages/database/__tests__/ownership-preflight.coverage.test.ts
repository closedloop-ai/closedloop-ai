/**
 * ISS-11298 coverage recovery: pins branches of scripts/ownership-preflight.ts
 * left uncovered by ownership-preflight.test.ts — the malformed-result-shape
 * throws inside parseForeignOwnedRows/listPendingMigrations (both fail open,
 * caught by the outer try/catch), the pending-summary overflow suffix, the
 * non-Error catch branch, and the `deps.*` `??` fallbacks to the real
 * defaultCreateClient/defaultListMigrationDirs/console.warn.
 *
 * Two branches in the source are NOT exercised here and are left uncovered
 * deliberately: `row.error.issues[0]?.message ?? "unknown validation error"`
 * (line 144) and `foreignOwned[0]?.migrate_role ?? "<current_user>"` (line
 * 303). Both `??` fallbacks require an array element that Zod's own
 * `safeParse` never produces — a `ZodError` always has at least one issue with
 * a defined `message`, and `foreignOwned[0]` is only read after `.length > 0`
 * has already been checked, with `migrate_role` required as `z.string()` by
 * `ForeignOwnedTableRowSchema`. Forcing either fallback would mean handing the
 * function a `foreignOwned` array that never passed through real validation,
 * which is not a reachable production shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  assertMigrateRoleOwnsSchema,
  OwnershipPreflightDiagnostic,
} from "../scripts/ownership-preflight";

const mocks = vi.hoisted(() => ({
  createSqlClient: vi.fn(),
  defaultListMigrationDirs: vi.fn(),
}));

vi.mock("../scripts/db-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/db-utils")>();
  return { ...actual, createSqlClient: mocks.createSqlClient };
});

vi.mock("../scripts/preview-at-head", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../scripts/preview-at-head")>();
  return {
    ...actual,
    defaultListMigrationDirs: mocks.defaultListMigrationDirs,
  };
});

const MIGRATE_ROLE = "vercel_iam";
const STATEMENT_TIMEOUT_RE = /statement_timeout/;
const PG_TABLES_RE = /pg_tables/;

const driftRow = (tablename: string, tableowner = "postgres") => ({
  migrate_role: MIGRATE_ROLE,
  tablename,
  tableowner,
});

/** Routes a query by which of the three statements it is, by regex. */
function makeQueryRouter(
  ownershipResult: () => unknown,
  migrationResult: () => unknown
) {
  return (text: string) => {
    if (STATEMENT_TIMEOUT_RE.test(text)) {
      return Promise.resolve({ rows: [] });
    }
    if (PG_TABLES_RE.test(text)) {
      return Promise.resolve(ownershipResult());
    }
    return Promise.resolve(migrationResult());
  };
}

function makeDeps(opts: {
  ownershipResult?: unknown;
  migrationResult?: unknown;
  connectError?: unknown;
}) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client: SqlClient = {
    connect: vi.fn(() =>
      opts.connectError === undefined
        ? Promise.resolve()
        : Promise.reject(opts.connectError)
    ),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return makeQueryRouter(
        () => opts.ownershipResult ?? { rows: [] },
        () => opts.migrationResult ?? { rows: [] }
      )(text);
    }),
  };
  const logger = { warn: vi.fn() };
  return {
    calls,
    client,
    logger,
    deps: {
      createClient: () => client,
      listMigrationDirs: () => ["m_one"],
      logger,
    },
  };
}

describe("assertMigrateRoleOwnsSchema — malformed catalog shapes fail open", () => {
  it("fails open when the pg_tables query returns a non-array rows field", async () => {
    const { deps, logger } = makeDeps({ ownershipResult: { rows: "oops" } });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("fail-open");
    expect(warned).toContain("pg_tables ownership query returned no row array");
  });

  it("fails open, naming the already-detected drift, when _prisma_migrations returns a non-array rows field", async () => {
    const { deps, logger } = makeDeps({
      ownershipResult: { rows: [driftRow("public_repositories")] },
      migrationResult: { rows: "oops" },
    });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("fail-open");
    expect(warned).toContain("_prisma_migrations query returned no row array");
    expect(warned).toContain("public_repositories");
  });

  it("stringifies a non-Error thrown value from a failed connect instead of reading .message", async () => {
    const { deps, logger } = makeDeps({ connectError: "socket reset" });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("socket reset");
  });
});

describe("assertMigrateRoleOwnsSchema — pending-migration summary overflow", () => {
  it("appends an overflow count once pending migrations exceed the listed cap", async () => {
    const pendingNames = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];

    const driftClient: SqlClient = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn(
        makeQueryRouter(
          () => ({ rows: [driftRow("public_repositories")] }),
          () => ({ rows: [] })
        )
      ),
    };

    const thrown = await assertMigrateRoleOwnsSchema("postgres://x", "public", {
      createClient: () => driftClient,
      listMigrationDirs: () => pendingNames,
      logger: { warn: vi.fn() },
    }).catch((caught: unknown) => caught);

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(
      OwnershipPreflightDiagnostic.SchemaOwnershipDrift
    );
    // 7 pending names, 5 listed cap → 2 overflow.
    expect(message).toContain("m1, m2, m3, m4, m5 (+2 more)");
  });
});

describe("assertMigrateRoleOwnsSchema — deps.* fallbacks to the real defaults", () => {
  beforeEach(() => {
    mocks.createSqlClient.mockClear();
    mocks.defaultListMigrationDirs.mockClear();
  });

  it("uses defaultCreateClient when deps is {}; with no drift the migration list and logger are not reached", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const client: SqlClient = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn(
        makeQueryRouter(
          () => ({ rows: [] }),
          () => ({ rows: [] })
        )
      ),
    };
    mocks.createSqlClient.mockReturnValue(client);
    mocks.defaultListMigrationDirs.mockReturnValue(["m_default"]);

    await assertMigrateRoleOwnsSchema("postgres://x", "public", {});

    expect(mocks.createSqlClient).toHaveBeenCalledWith(
      "postgres://x",
      expect.objectContaining({ connectionTimeoutMillis: expect.any(Number) })
    );
    // No drift in this fixture, so listMigrationDirs() is never reached and no
    // warning is produced.
    expect(mocks.defaultListMigrationDirs).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("logs a real console.warn for dormant drift when deps.logger is omitted", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const client: SqlClient = {
      connect: vi.fn(() => Promise.resolve()),
      end: vi.fn(() => Promise.resolve()),
      // _prisma_migrations: the one on-disk migration is applied → dormant
      // drift, warn-only.
      query: vi.fn(
        makeQueryRouter(
          () => ({ rows: [driftRow("public_repositories")] }),
          () => ({
            rows: [
              {
                migration_name: "m_default",
                finished_at: new Date("2026-01-01T00:00:00Z"),
                rolled_back_at: null,
              },
            ],
          })
        )
      ),
    };
    mocks.createSqlClient.mockReturnValue(client);
    mocks.defaultListMigrationDirs.mockReturnValue(["m_default"]);

    await assertMigrateRoleOwnsSchema("postgres://x", "public", {});

    expect(mocks.defaultListMigrationDirs).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("public_repositories");

    warnSpy.mockRestore();
  });
});
