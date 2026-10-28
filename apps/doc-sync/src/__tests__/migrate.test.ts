import type * as NodeFsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "@repo/observability/log";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_FAILED_EVENT,
  MIGRATION_LOCK_KEY,
  MigrationError,
  runMigrations,
  runMigrationsOrExit,
} from "../storage/migrate";

const readdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  readdirMock.mockImplementation(actual.readdir);
  return { ...actual, readdir: readdirMock };
});

const MIGRATION_ID = "0001_first";
const MIGRATION_SQL = "CREATE TABLE first_probe (id integer);";

let dir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("runMigrations", () => {
  it("surfaces the MigrationError with its id when the connection drops mid-migration and the rollback fails", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "doc-sync-migrate-"));
    await writeFile(path.join(dir, `${MIGRATION_ID}.sql`), MIGRATION_SQL);
    const dropped = new Error("Connection terminated unexpectedly");
    let connected = true;
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockImplementation((text: unknown) => {
      if (text === MIGRATION_SQL) {
        connected = false;
      }
      return connected
        ? Promise.resolve({ rows: [] })
        : Promise.reject(dropped);
    });
    const pool = new pg.Pool();
    vi.spyOn(pool, "connect").mockImplementation(() => Promise.resolve(client));

    const failure = await runMigrations(pool, dir).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({
      name: "MigrationError",
      message: `Doc sync migration ${MIGRATION_ID} failed`,
      migrationId: MIGRATION_ID,
      cause: dropped,
    });
  });
});

const UNLOCK_SQL = "SELECT pg_advisory_unlock($1)";
const RECORDED_SQL = "SELECT id FROM doc_sync_migration";

async function migrationsDir(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "doc-sync-migrate-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql);
  }
  return dir;
}

/** A pool whose client answers from `reply` and records every statement. */
function stubbedPool(reply: (text: string) => unknown = () => ({ rows: [] })) {
  const statements: string[] = [];
  const release = vi.fn();
  const client = Object.assign(new pg.Client(), { release });
  vi.spyOn(client, "query").mockImplementation((text: unknown) => {
    statements.push(String(text));
    const result = reply(String(text));
    return result instanceof Error || typeof result === "string"
      ? Promise.reject(result)
      : Promise.resolve(result ?? { rows: [] });
  });
  const pool = new pg.Pool();
  vi.spyOn(pool, "connect").mockImplementation(() => Promise.resolve(client));
  return { pool, statements, release };
}

describe("runMigrations ordering and lock", () => {
  it("applies pending .sql files in filename order, skips recorded ids and other files, and unlocks", async () => {
    const migrations = await migrationsDir({
      "0002_second.sql": "SELECT 2;",
      "0001_first.sql": "SELECT 1;",
      "0003_third.sql": "SELECT 3;",
      "README.md": "not a migration",
    });
    readdirMock.mockResolvedValueOnce([
      "0003_third.sql",
      "README.md",
      "0002_second.sql",
      "0001_first.sql",
    ]);
    const { pool, statements, release } = stubbedPool((text) =>
      text === RECORDED_SQL ? { rows: [{ id: "0002_second" }] } : { rows: [] }
    );

    const applied = await runMigrations(pool, migrations);

    expect(readdirMock).toHaveBeenCalledWith(migrations);
    expect(applied).toEqual(["0001_first", "0003_third"]);
    expect(statements).not.toContain("SELECT 2;");
    expect(statements).not.toContain("not a migration");
    expect(statements.indexOf("SELECT 1;")).toBeLessThan(
      statements.indexOf("SELECT 3;")
    );
    expect(statements.at(-1)).toBe(UNLOCK_SQL);
    expect(release).toHaveBeenCalledWith(undefined);
    const firstApply = statements.indexOf("SELECT 1;");
    expect(statements.slice(firstApply - 1, firstApply + 3)).toEqual([
      "BEGIN",
      "SELECT 1;",
      "INSERT INTO doc_sync_migration (id) VALUES ($1)",
      "COMMIT",
    ]);
    expect(statements[1]).toContain(
      "CREATE TABLE IF NOT EXISTS doc_sync_migration"
    );
  });

  it("takes the advisory lock with the service's key before anything else", async () => {
    const migrations = await migrationsDir({});
    const { pool } = stubbedPool();
    const querySpy = vi.mocked((await pool.connect()).query);

    await runMigrations(pool, migrations);

    expect(querySpy.mock.calls[0]).toEqual([
      "SELECT pg_advisory_lock($1)",
      [MIGRATION_LOCK_KEY],
    ]);
    expect(querySpy.mock.calls.at(-1)).toEqual([
      UNLOCK_SQL,
      [MIGRATION_LOCK_KEY],
    ]);
  });

  it("destroys the connection with the unlock error when the unlock fails", async () => {
    const migrations = await migrationsDir({});
    const unlockError = new Error("unlock failed");
    const { pool, release } = stubbedPool((text) =>
      text === UNLOCK_SQL ? unlockError : { rows: [] }
    );

    await expect(runMigrations(pool, migrations)).resolves.toEqual([]);
    expect(release).toHaveBeenCalledWith(unlockError);
  });

  it("destroys the connection with a stand-in Error when the unlock rejects with a non-Error", async () => {
    const migrations = await migrationsDir({});
    const { pool, release } = stubbedPool((text) =>
      text === UNLOCK_SQL ? "dropped" : { rows: [] }
    );

    await runMigrations(pool, migrations);

    const released = release.mock.calls[0]?.[0];
    expect(released).toBeInstanceOf(Error);
    expect(released).toMatchObject({ message: "unlock" });
  });
});

describe("runMigrations records", () => {
  it("records each applied id as the statement parameter", async () => {
    const migrations = await migrationsDir({ "0001_first.sql": "SELECT 1;" });
    const { pool } = stubbedPool();
    const querySpy = vi.mocked((await pool.connect()).query);

    await runMigrations(pool, migrations);

    expect(querySpy).toHaveBeenCalledWith(
      "INSERT INTO doc_sync_migration (id) VALUES ($1)",
      ["0001_first"]
    );
  });
});

describe("runMigrationsOrExit", () => {
  it("is true and exits nothing when migrations apply (default deps)", async () => {
    const migrations = await migrationsDir({ "0001_first.sql": "SELECT 1;" });
    const { pool } = stubbedPool();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("must not exit");
    });
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);

    await expect(runMigrationsOrExit(pool, migrations)).resolves.toBe(true);

    expect(exit).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("Doc sync migrations applied", {
      event: "doc_sync.migrations_applied",
      applied: ["0001_first"],
    });
  });

  it("logs the failed migration's id and its cause's code, flushes, then exits 1", async () => {
    const migrations = await migrationsDir({ "0001_first.sql": "BAD SQL;" });
    const { pool, statements } = stubbedPool((text) =>
      text === "BAD SQL;"
        ? Object.assign(new Error("syntax"), { code: "42601" })
        : { rows: [] }
    );
    const order: string[] = [];
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      order.push("log");
    });
    const flushLogs = vi.fn(() => {
      order.push("flush");
      return Promise.resolve();
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });

    await expect(
      runMigrationsOrExit(pool, migrations, { exit, flushLogs })
    ).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith(
      "Doc sync refused to boot: migration failed",
      {
        event: MIGRATION_FAILED_EVENT,
        fatal: true,
        migrationId: "0001_first",
        code: "42601",
      }
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual(["log", "flush", "exit"]);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("logs a null migration id and the error's own code when the failure is not a MigrationError", async () => {
    const pool = new pg.Pool();
    vi.spyOn(pool, "connect").mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
      )
    );
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();

    await expect(
      runMigrationsOrExit(pool, "/nonexistent", {
        exit,
        flushLogs: () => Promise.resolve(),
      })
    ).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith(
      "Doc sync refused to boot: migration failed",
      expect.objectContaining({ migrationId: null, code: "ECONNREFUSED" })
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
