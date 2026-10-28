import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@repo/observability/log";
import { flushLogsWithDeadline } from "@repo/observability/shutdown";
import type pg from "pg";
import { errorCode } from "./error-code";

export const MIGRATION_FAILED_EVENT = "doc_sync.migration_failed";

/** `apps/doc-sync/migrations/`, beside `src/` in the repo and in the image. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations/", import.meta.url)
);

export class MigrationError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, cause: unknown) {
    super(`Doc sync migration ${migrationId} failed`, { cause });
    this.name = "MigrationError";
    this.migrationId = migrationId;
  }
}

/**
 * Applies every `*.sql` file in `dir` not yet recorded in
 * `doc_sync_migration`, in filename order, each in its own transaction with
 * its record. A session advisory lock serializes two tasks booting at once.
 * Returns the ids it applied; throws a `MigrationError` on the first failure.
 */
export async function runMigrations(
  pool: pg.Pool,
  dir: string
): Promise<string[]> {
  const client = await pool.connect();
  let unlockFailure: Error | undefined;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, dir);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          MIGRATION_LOCK_KEY,
        ]);
      } catch (error) {
        // Destroying the connection releases the session lock with it.
        unlockFailure = error instanceof Error ? error : new Error("unlock");
      }
    }
  } finally {
    client.release(unlockFailure);
  }
}

export type MigrateOrExitDeps = {
  exit: (code: number) => void;
  flushLogs: () => Promise<void>;
};

/** Boot entry: a failed migration logs `doc_sync.migration_failed`, flushes, and exits 1. */
export async function runMigrationsOrExit(
  pool: pg.Pool,
  dir: string,
  deps: MigrateOrExitDeps = {
    exit: (code) => process.exit(code),
    flushLogs: flushLogsWithDeadline,
  }
): Promise<boolean> {
  try {
    const applied = await runMigrations(pool, dir);
    log.info("Doc sync migrations applied", {
      event: "doc_sync.migrations_applied",
      applied,
    });
    return true;
  } catch (error) {
    log.error("Doc sync refused to boot: migration failed", {
      event: MIGRATION_FAILED_EVENT,
      fatal: true,
      migrationId: error instanceof MigrationError ? error.migrationId : null,
      code: errorCode(error instanceof MigrationError ? error.cause : error),
    });
    await deps.flushLogs();
    deps.exit(1);
    return false;
  }
}

async function applyPending(
  client: pg.PoolClient,
  dir: string
): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS doc_sync_migration (
       id text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const recorded = await client.query<{ id: string }>(
    "SELECT id FROM doc_sync_migration"
  );
  const done = new Set(recorded.rows.map((row) => row.id));
  const files = (await readdir(dir))
    .filter((file) => file.endsWith(SQL_EXTENSION))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const id = path.basename(file, SQL_EXTENSION);
    if (done.has(id)) {
      continue;
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    await applyOne(client, id, sql);
    applied.push(id);
  }
  return applied;
}

async function applyOne(
  client: pg.PoolClient,
  id: string,
  sql: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO doc_sync_migration (id) VALUES ($1)", [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new MigrationError(id, error);
  }
}

/** Any constant works: the database belongs to this service alone. */
export const MIGRATION_LOCK_KEY = 12_501;
const SQL_EXTENSION = ".sql";
