/**
 * ISS-11381: opening the store while another connection holds its lock must
 * wait out the busy timeout, not fail on the first PRAGMA. A second process
 * holds an EXCLUSIVE lock on a fresh store file and releases it only once the
 * production open path (`openMigrationDatabase`) has set its busy timeout, so
 * every statement the opener runs before that point meets the held lock. The
 * db-host does not retry a non-timeout open failure, so a SQLITE_BUSY here
 * leaves the app with no migrated store at all.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type * as Libsql from "@libsql/client";
import { afterEach, test, vi } from "vitest";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";

const opener = vi.hoisted(() => ({ onBusyTimeoutSet: () => {} }));

vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof Libsql>();
  return {
    ...actual,
    createClient: (config: Libsql.Config): Libsql.Client => {
      const client = actual.createClient(config);
      const execute = client.execute.bind(client);
      client.execute = async (
        stmt: Libsql.InStatement,
        args?: Libsql.InArgs
      ) => {
        if (typeof stmt !== "string") {
          return execute(stmt);
        }
        const result = await execute(stmt, args);
        if (BUSY_TIMEOUT_PRAGMA.test(stmt)) {
          opener.onBusyTimeoutSet();
        }
        return result;
      };
      return client;
    },
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  opener.onBusyTimeoutSet = () => {};
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("the store opens once a concurrent lock holder releases, instead of failing SQLITE_BUSY", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pragma-busy-order-"));
  tempDirs.push(dir);
  const file = path.join(dir, "agent-dashboard.sqlite");
  const holder = await holdExclusiveLock(file);
  // On a file already in WAL the opener's WAL switch does not contend for the
  // held lock, and this test would pass on either PRAGMA order.
  assert.notEqual(holder.journalMode, "wal");
  opener.onBusyTimeoutSet = holder.release;

  try {
    const { db } = await openMigrationDatabase(file);
    try {
      const mode = await db.query<{ journal_mode: string }>(
        "PRAGMA journal_mode"
      );
      assert.equal(mode.rows[0]?.journal_mode, "wal");
    } finally {
      await db.close();
    }
  } finally {
    holder.release();
    await holder.exited;
  }
}, 30_000);

type LockHolder = {
  /** The holder's journal mode, read while it holds the lock. */
  journalMode: string;
  /** Commit and exit. Idempotent. */
  release: () => void;
  exited: Promise<void>;
};

/**
 * Spawn a process that takes an EXCLUSIVE lock on `file` and holds it until
 * `release()`. Resolves once the lock is held.
 */
function holdExclusiveLock(file: string): Promise<LockHolder> {
  const child = spawn(process.execPath, ["-e", HOLDER_SCRIPT], {
    env: { ...process.env, HOLD_FILE: file, HOLD_LIBSQL: LIBSQL_CLIENT_PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`lock holder exited with code ${code}`))
    );
  });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      child.stdin.end(RELEASE_SIGNAL);
    }
  };
  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const locked = LOCKED_LINE.exec(stdout);
      if (locked?.[1]) {
        resolve({ exited, journalMode: locked[1], release });
      }
    });
    exited.then(
      () => reject(new Error(`lock holder exited before locking: ${stderr}`)),
      reject
    );
  });
}

const BUSY_TIMEOUT_PRAGMA = /^PRAGMA busy_timeout=/i;

const LIBSQL_CLIENT_PATH = createRequire(import.meta.url).resolve(
  "@libsql/client"
);

const LOCKED_LINE = /^locked (\w+)$/m;

const RELEASE_SIGNAL = "release\n";

const HOLDER_SCRIPT = `
const { createClient } = require(process.env.HOLD_LIBSQL);
(async () => {
  const client = createClient({ url: "file:" + process.env.HOLD_FILE });
  await client.execute("BEGIN EXCLUSIVE");
  await client.execute("CREATE TABLE held (x)");
  const mode = await client.execute("PRAGMA journal_mode");
  process.stdin.once("data", async () => {
    await client.execute("COMMIT");
    client.close();
    process.exit(0);
  });
  process.stdout.write("locked " + mode.rows[0].journal_mode + "\\n");
})().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
`;
