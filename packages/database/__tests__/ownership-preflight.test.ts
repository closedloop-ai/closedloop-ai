import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  assertMigrateRoleOwnsSchema,
  OwnershipPreflightDiagnostic,
  PREFLIGHT_STATEMENT_TIMEOUT_MS,
} from "../scripts/ownership-preflight";

const PREVIEW_SCHEMA = "preview_my_branch_abc12345";
const MIGRATE_ROLE = "vercel_iam";
const PG_TABLES_RE = /pg_tables/;
const OWNERSHIP_DRIFT_RE = /schema_ownership_drift/;
const PRISMA_MIGRATIONS_RE = /_prisma_migrations/;
const STATEMENT_TIMEOUT_RE = /^SET statement_timeout = '(\d+)ms'$/;
const SET_STATEMENT_TIMEOUT = `SET statement_timeout = '${PREFLIGHT_STATEMENT_TIMEOUT_MS}ms'`;

// pg_tables drift row: a table in the target schema NOT owned by current_user.
const driftRow = (tablename: string, tableowner = "postgres") => ({
  migrate_role: MIGRATE_ROLE,
  tablename,
  tableowner,
});

// `_prisma_migrations` row shapes (same semantics as preview-at-head.test.ts).
const appliedRow = (name: string) => ({
  migration_name: name,
  finished_at: new Date("2026-01-01T00:00:00Z"),
  rolled_back_at: null,
});
const unfinishedRow = (name: string) => ({
  migration_name: name,
  finished_at: null,
  rolled_back_at: null,
});
const rolledBackRow = (name: string) => ({
  migration_name: name,
  finished_at: new Date("2026-01-01T00:00:00Z"),
  rolled_back_at: new Date("2026-01-02T00:00:00Z"),
});

function makeClient(opts: {
  ownershipRows?: unknown[];
  migrationRows?: unknown[];
  connectError?: Error;
  migrationQueryError?: Error;
  /**
   * Makes the pg_tables read block, so the ONLY thing that can settle it is the
   * session's statement_timeout (see `blockedQuery`).
   */
  blockOwnershipQuery?: boolean;
}) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let statementTimeoutMs: number | null = null;
  const client: SqlClient = {
    connect: vi.fn(() =>
      opts.connectError ? Promise.reject(opts.connectError) : Promise.resolve()
    ),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const setTimeoutMatch = STATEMENT_TIMEOUT_RE.exec(text);
      if (setTimeoutMatch) {
        statementTimeoutMs = Number(setTimeoutMatch[1]);
        return Promise.resolve({ rows: [] });
      }
      if (PG_TABLES_RE.test(text)) {
        return opts.blockOwnershipQuery
          ? blockedQuery(statementTimeoutMs)
          : Promise.resolve({ rows: opts.ownershipRows ?? [] });
      }
      if (opts.migrationQueryError) {
        return Promise.reject(opts.migrationQueryError);
      }
      return Promise.resolve({ rows: opts.migrationRows ?? [] });
    }),
  };
  return { client, calls };
}

function makeDeps(clientOpts: Parameters<typeof makeClient>[0]) {
  const { client, calls } = makeClient(clientOpts);
  const createClient = vi.fn(() => client);
  const logger = { warn: vi.fn() };
  return {
    calls,
    client,
    logger,
    deps: {
      createClient,
      listMigrationDirs: () => ["m_one", "m_two"],
      logger,
    },
    createClient,
  };
}

/**
 * Stands in for Postgres on a blocked statement: it is cancelled (SQLSTATE
 * 57014) once the session's `statement_timeout` elapses, and — the point of the
 * bound — waits FOREVER when the session never set one.
 */
function blockedQuery(statementTimeoutMs: number | null): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (statementTimeoutMs === null) {
      return;
    }
    setTimeout(
      () => reject(new Error("canceling statement due to statement timeout")),
      statementTimeoutMs
    );
  });
}

/** The pg_tables ownership read, wherever it landed among the session's SQL. */
function ownershipCall(calls: { text: string; values?: unknown[] }[]) {
  return calls.find((call) => PG_TABLES_RE.test(call.text));
}

describe("assertMigrateRoleOwnsSchema (ISS-5952)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops for preview schemas without opening a connection", async () => {
    const { deps, createClient } = makeDeps({});
    await assertMigrateRoleOwnsSchema("postgres://x", PREVIEW_SCHEMA, deps);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("passes silently when the migrate role owns every table, without reading _prisma_migrations", async () => {
    const { deps, calls, client, logger } = makeDeps({ ownershipRows: [] });
    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toBe(SET_STATEMENT_TIMEOUT);
    expect(calls[1]?.values).toEqual(["public"]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("targets the default public schema when schema is null", async () => {
    const { deps, calls } = makeDeps({ ownershipRows: [] });
    await assertMigrateRoleOwnsSchema("postgres://x", null, deps);
    expect(ownershipCall(calls)?.values).toEqual(["public"]);
  });

  it("throws BEFORE any DDL when drift coincides with pending migrations, naming the table, owner, and remedy", async () => {
    const { deps, client } = makeDeps({
      ownershipRows: [driftRow("public_repositories")],
      migrationRows: [appliedRow("m_one")],
    });

    const error: unknown = await assertMigrateRoleOwnsSchema(
      "postgres://x",
      "public",
      deps
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      OwnershipPreflightDiagnostic.SchemaOwnershipDrift
    );
    expect(message).toContain(
      '"public"."public_repositories" (owner: postgres)'
    );
    expect(message).toContain(
      'ALTER TABLE "public"."public_repositories" OWNER TO "vercel_iam";'
    );
    expect(message).toContain("m_two");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("counts an unresolved (started, unfinished) migration row as pending — the wedge's steady state", async () => {
    const { deps } = makeDeps({
      ownershipRows: [driftRow("public_repositories")],
      migrationRows: [appliedRow("m_one"), unfinishedRow("m_two")],
    });
    await expect(
      assertMigrateRoleOwnsSchema("postgres://x", "public", deps)
    ).rejects.toThrow(OWNERSHIP_DRIFT_RE);
  });

  it("counts a rolled-back migration row as pending", async () => {
    const { deps } = makeDeps({
      ownershipRows: [driftRow("public_repositories")],
      migrationRows: [appliedRow("m_one"), rolledBackRow("m_two")],
    });
    await expect(
      assertMigrateRoleOwnsSchema("postgres://x", "public", deps)
    ).rejects.toThrow(OWNERSHIP_DRIFT_RE);
  });

  it("only WARNS on dormant drift (everything applied) so drift cannot become a deploy lockout", async () => {
    const { deps, logger } = makeDeps({
      ownershipRows: [driftRow("public_repositories")],
      migrationRows: [appliedRow("m_one"), appliedRow("m_two")],
    });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain(OwnershipPreflightDiagnostic.SchemaOwnershipDrift);
    expect(warned).toContain("public_repositories");
  });

  it("fails open with a warning when the connection itself fails", async () => {
    const { deps, logger } = makeDeps({
      connectError: new Error("connection refused"),
    });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("fail-open");
  });

  it("fails open but still names detected drift when the _prisma_migrations read errors", async () => {
    const { deps, logger, calls } = makeDeps({
      ownershipRows: [driftRow("public_repositories")],
      migrationQueryError: new Error("relation does not exist"),
    });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(calls.some((call) => PRISMA_MIGRATIONS_RE.test(call.text))).toBe(
      true
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("fail-open");
    expect(warned).toContain("public_repositories");
  });

  it("checks the schema the URL names, not the argument, when DATABASE_URL carries its own schema", async () => {
    const { deps, calls, createClient } = makeDeps({ ownershipRows: [] });

    await assertMigrateRoleOwnsSchema(
      "postgres://h/db?schema=app",
      PREVIEW_SCHEMA,
      deps
    );

    // `addSchemaToUrl` leaves the url's own `schema=app` in place, so Prisma
    // migrates "app" — skipping as a preview on the argument would leave the
    // schema actually at risk unchecked.
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(ownershipCall(calls)?.values).toEqual(["app"]);
  });

  it("checks the url's schema over a non-preview argument naming a different schema", async () => {
    const { deps, calls } = makeDeps({ ownershipRows: [] });

    await assertMigrateRoleOwnsSchema(
      "postgres://h/db?schema=app",
      "public",
      deps
    );

    expect(ownershipCall(calls)?.values).toEqual(["app"]);
  });

  it("still no-ops when the URL itself names a preview schema", async () => {
    const { deps, createClient } = makeDeps({});

    await assertMigrateRoleOwnsSchema(
      `postgres://h/db?schema=${PREVIEW_SCHEMA}`,
      null,
      deps
    );

    expect(createClient).not.toHaveBeenCalled();
  });

  it("bounds the query path: a blocked catalog read is cancelled by statement_timeout and fails open instead of hanging the deploy", async () => {
    vi.useFakeTimers();
    const { deps, calls, logger } = makeDeps({ blockOwnershipQuery: true });

    const preflight = assertMigrateRoleOwnsSchema(
      "postgres://x",
      "public",
      deps
    );
    await vi.advanceTimersByTimeAsync(PREFLIGHT_STATEMENT_TIMEOUT_MS);
    await preflight;

    expect(calls[0]?.text).toBe(SET_STATEMENT_TIMEOUT);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("fail-open");
    expect(warned).toContain("statement timeout");
  }, 5000);

  it("treats an unparseable drift row as an internal preflight error, never as a clean pass", async () => {
    const { deps, logger } = makeDeps({
      // The ONE row proving drift, with a null owner the schema rejects.
      ownershipRows: [{ ...driftRow("public_repositories"), tableowner: null }],
      migrationRows: [],
    });

    await assertMigrateRoleOwnsSchema("postgres://x", "public", deps);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warned = logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("fail-open");
    expect(warned).toContain("unparseable row at index 0");
  });
});
