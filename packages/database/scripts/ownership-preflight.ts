/**
 * Deploy-time table-ownership preflight for NON-preview schemas (ISS-5952).
 *
 * WHY: on 2026-08-11 every api-stage `main` deploy wedged because
 * `public_repositories` on stage was owned by `postgres` (a 2026-05-18 manual
 * re-apply), not by `vercel_iam`, the role every deploy migrates as. The first
 * migration to ALTER that table in 85 days failed mid-file with SQLSTATE 42501
 * (`must be owner of table …`) AFTER its first statement had committed —
 * `prisma migrate deploy` applies bare statements per-statement, with no
 * wrapping transaction (deliberate and load-bearing, for
 * `CREATE INDEX CONCURRENTLY`) — and the P3009 recovery's resolve-rolled-back →
 * retry then hit 42701 on the half-applied statement and stopped with
 * `partial_committed_ddl_artifact`. Unwedging required manual DB surgery.
 *
 * Ownership drift is only OBSERVABLE on a live long-lived schema: previews, CI,
 * and local dev create every table as the single migrate role, so no pre-merge
 * environment can reproduce it. This preflight therefore runs at the only seam
 * that can see it — immediately before `migrate deploy`, on the deploy's own
 * connection — and turns the partial-commit wedge into a clean failure BEFORE
 * any DDL runs:
 *
 *  - foreign-owned tables + PENDING migrations → throw (fail the deploy pre-DDL,
 *    naming each table/owner and the one-line `ALTER … OWNER TO` remedy);
 *  - foreign-owned tables + at head → warn only. Dormant drift must not become
 *    a deploy lockout (same philosophy as the ISS-4601 invalid-index sweep);
 *  - any error of the preflight's own (connect, catalog read, an unparseable
 *    catalog row, `_prisma_migrations` read — including the table not existing
 *    yet on a brand-new database) → warn and FAIL OPEN. Only positively-detected
 *    drift with positively-known pending work may fail a deploy. Fail-open is
 *    only reachable if the preflight can actually FAIL, so both the connect and
 *    the queries are bounded; an unbounded wait would hang the deploy instead.
 *
 * The schema checked is resolved URL-FIRST (`resolveSweepSchema`), not from the
 * `schema` argument: `addSchemaToUrl` leaves an existing `?schema=` in place, so
 * that parameter is what Prisma migrates regardless of the argument.
 *
 * Scope is `pg_tables` (ordinary tables) only: ALTER/DROP/CREATE INDEX against
 * an existing table is the DDL class migrations emit against pre-existing
 * objects, and indexes/sequences follow their table's ownership. Membership in
 * the owning role would also satisfy Postgres; this check compares direct
 * ownership, which is the invariant the infrastructure actually maintains
 * (`postgresql_default_privileges` pins `owner = vercel_iam`) — a false
 * positive from an exotic membership setup surfaces as one warn/fail naming the
 * exact tables, not a silent pass.
 *
 * Sibling-lib pattern (preview-at-head.ts / migration-lock.ts): no I/O at module
 * load; the pg client and the migrations-dir reader are injected so the decision
 * matrix is unit-testable without a database.
 */

import { z } from "zod";
import {
  createSqlClient,
  endQuietly,
  MigrationRowSchema,
  quoteIdentifier,
  type SqlClient,
} from "./db-utils";
// The canonical URL-first schema resolver, imported rather than re-derived: a
// second resolution order free to disagree with this one is the very bug this
// guard exists to prevent (see the call site).
import { resolveSweepSchema } from "./invalid-index-sweep";
import { defaultListMigrationDirs } from "./preview-at-head";
import { isPreviewSchema } from "./preview-schema";

export const OwnershipPreflightDiagnostic = {
  SchemaOwnershipDrift: "schema_ownership_drift",
} as const;

export type OwnershipPreflightDiagnostic =
  (typeof OwnershipPreflightDiagnostic)[keyof typeof OwnershipPreflightDiagnostic];

/**
 * Bounds the preflight's connect: pg's default is wait-forever, which on the
 * deploy critical path is a hang rather than an error (see db-utils.ts).
 */
const PREFLIGHT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Bounds the preflight's QUERIES. The connect timeout above stops at the
 * handshake, so without this both catalog reads can block indefinitely — behind
 * an operator's `ALTER TABLE`/`DROP INDEX` holding AccessExclusive, say — and an
 * unbounded query never reaches the fail-open catch below: it HANGS the deploy
 * instead of failing open, which is strictly worse than the drift being guarded
 * against. Same bound as the connect; two catalog reads need nothing near it.
 */
export const PREFLIGHT_STATEMENT_TIMEOUT_MS = 15_000;

/** Cap the pending-migration names printed in the failure message. */
const MAX_LISTED_PENDING_MIGRATIONS = 5;

const FOREIGN_OWNED_TABLES_SQL = [
  "SELECT current_user AS migrate_role, tablename, tableowner",
  "FROM pg_catalog.pg_tables",
  "WHERE schemaname = $1 AND tableowner <> current_user",
  "ORDER BY tablename",
].join("\n");

const ForeignOwnedTableRowSchema = z.object({
  migrate_role: z.string(),
  tablename: z.string(),
  tableowner: z.string(),
});

type ForeignOwnedTableRow = z.infer<typeof ForeignOwnedTableRowSchema>;

type OwnershipPreflightLogger = {
  warn: (message: string) => void;
};

export type OwnershipPreflightDeps = {
  /** pg client factory — defaults to `createSqlClient` with a bounded connect. */
  createClient?: (databaseUrl: string) => SqlClient;
  /** Migration directory names — defaults to reading prisma/migrations off cwd. */
  listMigrationDirs?: () => string[];
  logger?: OwnershipPreflightLogger;
};

function defaultCreateClient(databaseUrl: string): SqlClient {
  return createSqlClient(databaseUrl, {
    connectionTimeoutMillis: PREFLIGHT_CONNECT_TIMEOUT_MS,
  });
}

/**
 * Parses the foreign-owned-tables result. A rejected row THROWS, like a
 * malformed result shape, so the caller's fail-open path handles it: every row
 * here is a drift row, so dropping the one that failed to parse would turn the
 * sole piece of evidence for drift into a clean, silent pass. An unparseable row
 * is an internal preflight error, never proof that nothing drifted.
 */
function parseForeignOwnedRows(result: unknown): ForeignOwnedTableRow[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw new Error("pg_tables ownership query returned no row array");
  }
  const parsed: ForeignOwnedTableRow[] = [];
  for (const [index, raw] of rows.entries()) {
    const row = ForeignOwnedTableRowSchema.safeParse(raw);
    if (!row.success) {
      throw new Error(
        `pg_tables ownership query returned an unparseable row at index ${index}: ${
          row.error.issues[0]?.message ?? "unknown validation error"
        }`
      );
    }
    parsed.push(row.data);
  }
  return parsed;
}

/**
 * The migrations `migrate deploy` still has work for on this schema: every
 * on-disk migration without a finished, non-rolled-back row. Malformed rows
 * conservatively do not count as applied.
 */
async function listPendingMigrations(
  client: SqlClient,
  schemaName: string,
  allMigrationDirs: readonly string[]
): Promise<string[]> {
  const qualifiedTable = `${quoteIdentifier(schemaName)}."_prisma_migrations"`;
  const result = await client.query(
    `SELECT "migration_name", "finished_at", "rolled_back_at" FROM ${qualifiedTable}`
  );
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw new Error("_prisma_migrations query returned no row array");
  }

  const applied = new Set<string>();
  for (const raw of rows) {
    const parsed = MigrationRowSchema.safeParse(raw);
    if (
      parsed.success &&
      parsed.data.finished_at !== null &&
      parsed.data.rolled_back_at === null
    ) {
      applied.add(parsed.data.migration_name);
    }
  }
  return allMigrationDirs.filter((name) => !applied.has(name));
}

function formatForeignOwnedTableLines(
  schemaName: string,
  foreignOwned: readonly ForeignOwnedTableRow[]
): string[] {
  return foreignOwned.map(
    (row) =>
      `  - ${quoteIdentifier(schemaName)}.${quoteIdentifier(row.tablename)} (owner: ${row.tableowner})`
  );
}

function formatPendingSummary(pending: readonly string[]): string {
  const listed = pending.slice(0, MAX_LISTED_PENDING_MIGRATIONS).join(", ");
  const overflow = pending.length - MAX_LISTED_PENDING_MIGRATIONS;
  return overflow > 0 ? `${listed} (+${overflow} more)` : listed;
}

function formatOwnershipPreflightError(input: {
  schemaName: string;
  migrateRole: string;
  foreignOwned: readonly ForeignOwnedTableRow[];
  pending: readonly string[];
}): string {
  return [
    `Migration ownership preflight failed: ${input.foreignOwned.length} table(s) in schema "${input.schemaName}" are not owned by the migrate role "${input.migrateRole}", and ${input.pending.length} migration(s) are pending.`,
    `Diagnosis: ${OwnershipPreflightDiagnostic.SchemaOwnershipDrift}`,
    "prisma migrate deploy applies bare statements without a wrapping transaction, so a mid-file ALTER on a foreign-owned table fails with SQLSTATE 42501 AFTER earlier statements have committed and wedges every later deploy (partial_committed_ddl_artifact). Failing BEFORE any DDL runs instead.",
    "Foreign-owned tables:",
    ...formatForeignOwnedTableLines(input.schemaName, input.foreignOwned),
    `Pending migrations: ${formatPendingSummary(input.pending)}`,
    "Fix, as a role that can transfer ownership (e.g. the master role), then redeploy:",
    ...input.foreignOwned.map(
      (row) =>
        `  ALTER TABLE ${quoteIdentifier(input.schemaName)}.${quoteIdentifier(row.tablename)} OWNER TO ${quoteIdentifier(input.migrateRole)};`
    ),
    "No DDL was executed and _prisma_migrations was not modified.",
  ].join("\n");
}

function formatDormantDriftWarning(input: {
  schemaName: string;
  migrateRole: string;
  foreignOwned: readonly ForeignOwnedTableRow[];
}): string {
  return [
    `⚠️ Ownership drift in schema "${input.schemaName}" (${OwnershipPreflightDiagnostic.SchemaOwnershipDrift}): ${input.foreignOwned.length} table(s) are not owned by the migrate role "${input.migrateRole}". Nothing is pending, so this deploy proceeds — but the FIRST migration to ALTER one of these tables will wedge deploys. Transfer ownership now:`,
    ...formatForeignOwnedTableLines(input.schemaName, input.foreignOwned),
  ].join("\n");
}

/**
 * Fails (throws) when the connecting role does not own every table in the
 * target non-preview schema AND migrations are pending — BEFORE `migrate
 * deploy` has run any DDL. Warns on dormant drift (nothing pending) and on any
 * internal preflight error (fail-open). No-op for preview schemas.
 */
export async function assertMigrateRoleOwnsSchema(
  databaseUrl: string,
  schema: string | null,
  deps: OwnershipPreflightDeps = {}
): Promise<void> {
  // URL-FIRST, exactly like the sweep: `addSchemaToUrl` only sets `schema` when
  // the URL does not already carry one, so an existing `?schema=` is what
  // `migrate deploy` targets no matter what this argument says. Deciding what to
  // check — or whether to skip as a preview — from the argument would let this
  // guard inspect schema A, or skip entirely, while the DDL it is protecting
  // lands on schema B. A guard that reports on a different object than the one
  // at risk is worse than no guard.
  const schemaName = resolveSweepSchema(databaseUrl, schema);
  if (isPreviewSchema(schemaName)) {
    return;
  }

  const logger = deps.logger ?? { warn: console.warn };
  const createClient = deps.createClient ?? defaultCreateClient;
  const listMigrationDirs = deps.listMigrationDirs ?? defaultListMigrationDirs;

  let foreignOwned: ForeignOwnedTableRow[] = [];
  let pending: string[] | null = null;
  let client: SqlClient | null = null;
  try {
    client = createClient(databaseUrl);
    await client.connect();
    // Bounds the two catalog reads below; see the constant.
    await client.query(
      `SET statement_timeout = '${PREFLIGHT_STATEMENT_TIMEOUT_MS}ms'`
    );
    foreignOwned = parseForeignOwnedRows(
      await client.query(FOREIGN_OWNED_TABLES_SQL, [schemaName])
    );
    if (foreignOwned.length > 0) {
      pending = await listPendingMigrations(
        client,
        schemaName,
        listMigrationDirs()
      );
    }
  } catch (error) {
    // Fail-open: the preflight's own failure must never block a deploy. If
    // drift was already detected, still surface it so the signal is not lost.
    const detail = error instanceof Error ? error.message : String(error);
    const driftNote =
      foreignOwned.length > 0
        ? ` Drift WAS detected (${foreignOwned
            .map((row) => row.tablename)
            .join(", ")}) but the pending-migration state is unknown.`
        : "";
    logger.warn(
      `⚠️ Ownership preflight for schema "${schemaName}" errored (fail-open, continuing to migrate): ${detail}.${driftNote}`
    );
    return;
  } finally {
    await endQuietly(client);
  }

  if (foreignOwned.length === 0) {
    return;
  }
  const migrateRole = foreignOwned[0]?.migrate_role ?? "<current_user>";
  if (pending === null || pending.length === 0) {
    logger.warn(
      formatDormantDriftWarning({ schemaName, migrateRole, foreignOwned })
    );
    return;
  }
  throw new Error(
    formatOwnershipPreflightError({
      schemaName,
      migrateRole,
      foreignOwned,
      pending,
    })
  );
}
