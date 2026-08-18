/**
 * Shared low-level primitives for the desktop E2E direct-SQLite seeders.
 *
 * The desktop store is a single libSQL/SQLite file (`agent-dashboard.sqlite`) in
 * the app's `--user-data-dir`, opened in WAL mode. WAL supports multi-process
 * access, so a seeder opens a SECOND `@libsql/client` connection on the SAME
 * file — exactly the connection type the app's own `openMigrationDatabase` uses.
 * Every seeder therefore needs the same four things: the store path, the app's
 * own per-connection PRAGMAs, busy-error tolerance, and a wait for the schema it
 * is about to write (the db host migrates ASYNCHRONOUSLY after launch, so the
 * file can exist before the migration that adds a given table or column has
 * run).
 *
 * Extracted from `seed-branches-db.ts` (ISS-4896) so a new seeding concern lands
 * in its own sibling module instead of growing that file further — it was
 * already well past the 500-line smell threshold. This module owns ONLY the
 * substrate; each seeder owns its own tables and row shapes.
 */

import path from "node:path";
import { createClient } from "@libsql/client";
import { MIGRATIONS } from "../../../src/main/database/migration/migrations-manifest.js";

/** The single-file libSQL store the desktop opens in the app's user-data dir. */
export const AGENT_DB_FILENAME = "agent-dashboard.sqlite";

/** The migration runner's tracking table (`migration-runner.ts`). */
export const MIGRATION_TRACKING_TABLE = "_desktop_migrations";

/** How often a schema wait re-probes while the db host migrates. */
export const SEED_SCHEMA_POLL_INTERVAL_MS = 250;

/** Default ceiling for any schema wait before it gives up and throws. */
export const SEED_SCHEMA_TIMEOUT_MS = 30_000;

const SQLITE_BUSY_ERROR = "SQLITE_BUSY";
const SQLITE_LOCKED_MESSAGE = "database is locked";
const SQLITE_MISSING_TABLE_MESSAGE = "no such table";

/** A seeder's libSQL connection to the desktop store. */
export type SeedClient = ReturnType<typeof createClient>;

/** Absolute path to the branches/agent SQLite store inside a launch's data dir. */
export function branchesDbPath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_DB_FILENAME);
}

/** Open a seeding connection to a launch's desktop store. */
export function openSeedClient(userDataDir: string): SeedClient {
  return createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(SQLITE_BUSY_ERROR) ||
    message.includes(SQLITE_LOCKED_MESSAGE)
  );
}

/**
 * Match the desktop's per-connection PRAGMAs (connection-pragmas.ts): WAL for
 * multi-process concurrency, a generous busy timeout to ride out brief writer
 * locks, and foreign keys enabled so seed batches obey the production schema.
 */
export async function applyDesktopSeedPragmas(
  client: SeedClient
): Promise<void> {
  for (const pragma of [
    "PRAGMA journal_mode=WAL",
    "PRAGMA busy_timeout=15000",
    "PRAGMA foreign_keys=ON",
  ]) {
    await client.execute(pragma);
  }
}

export async function applyDesktopBusyTimeout(
  client: SeedClient
): Promise<void> {
  await client.execute("PRAGMA busy_timeout=15000");
}

/** The `requiredColumns` a table does not (yet) carry. */
export async function getMissingColumns(
  client: SeedClient,
  tableName: string,
  requiredColumns: readonly string[]
): Promise<string[]> {
  const rs = await client.execute(`PRAGMA table_info(${tableName})`);
  const columns = new Set(rs.rows.map((row) => String(row.name)));
  return requiredColumns.filter((column) => !columns.has(column));
}

/** Block until every table in `requiredTables` exists in the store. */
export async function waitForTablesPresent(
  client: SeedClient,
  requiredTables: readonly string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const placeholders = requiredTables.map(() => "?").join(", ");
  for (;;) {
    try {
      const rs = await client.execute({
        sql: `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN (${placeholders})`,
        args: [...requiredTables],
      });
      if (rs.rows.length === requiredTables.length) {
        return;
      }
      if (Date.now() > deadline) {
        const found =
          rs.rows.map((row) => String(row.name)).join(", ") || "none";
        throw new Error(
          `required tables (${requiredTables.join(", ")}) did not appear within ${timeoutMs}ms (found: ${found})`
        );
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() > deadline) {
        throw error;
      }
    }
    await sleep(SEED_SCHEMA_POLL_INTERVAL_MS);
  }
}

/**
 * Block until `table` exists AND carries every column in `requiredColumns`.
 *
 * A table-only wait is not enough for any table whose columns arrived in LATER
 * migrations than the table itself: the db host applies migrations in order
 * asynchronously after launch, so the table can be visible while a column a
 * seeder writes is still pending. Same class of race the branch-schema wait
 * already guards for `sessions.last_activity_at`.
 */
export async function waitForColumnsPresent(
  client: SeedClient,
  table: string,
  requiredColumns: readonly string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let missing: string[] = [...requiredColumns];
    try {
      missing = await getMissingColumns(client, table, requiredColumns);
      if (missing.length === 0) {
        return;
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() > deadline) {
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${table} columns (${missing.join(", ")}) did not appear within ${timeoutMs}ms`
      );
    }
    await sleep(SEED_SCHEMA_POLL_INTERVAL_MS);
  }
}

/**
 * Block until the launched app has recorded EVERY bundled migration as applied.
 *
 * This is the only COMPLETE schema barrier a seeder can hold. A table wait, and
 * even a table-plus-column wait, is a PROXY for "the schema I need has landed",
 * and a proxy silently under-waits: `sessions` is created by `0001_init` and
 * `sessions.last_activity_at` lands in `0005`, but `sessions.repo_full_name` —
 * which `seedSessionsList` writes — does not arrive until `0029`. A caller that
 * waited on the earlier proxy could close the app 24 migrations early, freezing
 * the store mid-history; the seed then died on `table sessions has no column
 * named repo_full_name`, and every spec that seeds through that path failed.
 *
 * The runner writes a `_desktop_migrations` row for a migration only inside the
 * same transaction that executes it (`migration-runner.ts`), and refuses any
 * history that is not a contiguous prefix of the bundle, so "every bundled name
 * is recorded" is exactly "the store is fully migrated" — no proxy, and it
 * cannot go stale when a future migration adds a column a seeder writes.
 */
export async function waitForMigrationsApplied(
  client: SeedClient,
  timeoutMs: number
): Promise<void> {
  const expected = MIGRATIONS.map((migration) => migration.name);
  const deadline = Date.now() + timeoutMs;
  let missing: string[] = [...expected];
  for (;;) {
    try {
      const rs = await client.execute(
        `SELECT name FROM "${MIGRATION_TRACKING_TABLE}"`
      );
      const applied = new Set(rs.rows.map((row) => String(row.name)));
      missing = expected.filter((name) => !applied.has(name));
      if (missing.length === 0) {
        return;
      }
    } catch (error) {
      // The tracking table itself is created by the runner's first statement,
      // so "no such table" simply means the app has not opened the store yet.
      if (!(isSqliteBusyError(error) || isMissingTableError(error))) {
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the desktop store was not fully migrated within ${timeoutMs}ms — ${missing.length} of ${expected.length} migration(s) unapplied (first missing: ${missing[0] ?? "none"})`
      );
    }
    await sleep(SEED_SCHEMA_POLL_INTERVAL_MS);
  }
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SQLITE_MISSING_TABLE_MESSAGE);
}
