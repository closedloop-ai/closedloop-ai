/**
 * @file libsql-single-connection.test.ts
 * @description Regression tests for the exit-code-5 crash-storm RCA: the stock
 * `@libsql/client.transaction()` detaches the client's native connection
 * (leaking it until GC) and silently sheds every per-connection PRAGMA on the
 * lazily recreated replacement. The patched client
 * (patches/@libsql__client@0.17.3.patch) keeps BEGIN/COMMIT on the one
 * persistent connection instead, so:
 *
 *  1. PRAGMAs survive interactive transactions — asserted here via
 *     `busy_timeout` on the writer, `query_only` on a reader (the engine-level
 *     write backstop, a SECURITY property), and the migration handle.
 *  2. Transactions do not leak file descriptors — asserted by fd-count
 *     stability across a burst of `$transaction`s (each leaked native
 *     connection holds ~2 fds, so a burst of N would grow /dev/fd by ~2N
 *     under the stock client).
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const BUSY_TIMEOUT_MS = 15_000;
const READONLY_ERROR = /readonly|READONLY/;

function fdCount(): number | null {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
}

test("writer keeps its connection PRAGMAs across an interactive $transaction", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const readBusyTimeout = async () => {
      const rows = await prisma.client.$queryRawUnsafe<
        { timeout: number | bigint }[]
      >("PRAGMA busy_timeout");
      return Number(rows[0]?.timeout);
    };
    assert.equal(await readBusyTimeout(), BUSY_TIMEOUT_MS);

    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
      })
    );

    // Under the stock client the $transaction detaches the native connection
    // and the replacement resets busy_timeout to 0 — the WAL-contention
    // failure mode the 15 s timeout exists to absorb.
    assert.equal(await readBusyTimeout(), BUSY_TIMEOUT_MS);
  } finally {
    await close();
  }
});

test("reader keeps query_only=ON across a snapshot $transaction", async () => {
  // Pool size 1 makes every read hit the same reader connection, so the
  // post-transaction assertions observe the SAME connection the transaction
  // ran on.
  const { prisma, close } = await openTestPrisma(undefined, {
    readerPoolSize: 1,
  });
  try {
    await prisma.read((reader) =>
      reader.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
      })
    );

    const [queryOnly] = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ query_only: number | bigint }[]>(
        "PRAGMA query_only"
      )
    );
    assert.equal(Number(queryOnly?.query_only), 1);

    // The engine backstop itself: a write smuggled through the reader's raw
    // read escape hatch must fault (SQLITE_READONLY), even after a
    // transaction has run on this connection.
    await assert.rejects(
      prisma.read((reader) =>
        reader.$queryRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES ('ro-probe', 'running')"
        )
      ),
      READONLY_ERROR
    );
  } finally {
    await close();
  }
});

test("a burst of interactive transactions does not leak file descriptors", {
  // /dev/fd exists on darwin + linux (all CI/dev platforms for the desktop app).
  skip: fdCount() === null,
}, async () => {
  const before = fdCount() as number;
  const { prisma, close } = await openTestPrisma();
  try {
    const ROUNDS = 40;
    for (let i = 0; i < ROUNDS; i++) {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT OR REPLACE INTO sessions (id, status) VALUES ('fd-${i}', 'running')`
          );
        })
      );
      await prisma.read((reader) =>
        reader.$transaction(async (tx) => {
          await tx.$queryRawUnsafe("SELECT COUNT(*) AS n FROM sessions");
        })
      );
    }
    const after = fdCount();
    assert.ok(after !== null, "fd count readable after run");
    // Stock client: ~2 leaked fds per transaction → ~160 here. Patched
    // client: zero growth; the slack absorbs unrelated runtime fds.
    assert.ok(
      (after as number) - before < 20,
      `fd count grew from ${before} to ${after} across 40×2 transactions`
    );
  } finally {
    await close();
  }
});

test("migration handle keeps its PRAGMAs across db.transaction()", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "libsql-single-conn-"));
  try {
    const { db } = await openMigrationDatabase(path.join(dir, "t.sqlite"));
    try {
      await db.exec(
        "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)"
      );
      await db.transaction(async (tx) => {
        await tx.exec("INSERT INTO probe (id) VALUES (1)");
      });
      const result = await db.query<{ timeout: number }>("PRAGMA busy_timeout");
      assert.equal(Number(result.rows[0]?.timeout), BUSY_TIMEOUT_MS);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client.executeMultiple inside a caller-owned transaction does not roll it back", async () => {
  // The patch's `ownedTransaction` guard in Sqlite3Client.executeMultiple: no
  // production caller runs a script while holding an open transaction() today
  // (in-transaction scripts route through Sqlite3Transaction.executeMultiple),
  // but with the shared connection the upstream unconditional finally-ROLLBACK
  // would silently destroy such a caller's transaction. This exercises the
  // guard directly so it has real coverage, not just a comment.
  const dir = await mkdtemp(path.join(os.tmpdir(), "libsql-single-conn-"));
  try {
    const client = createClient({
      url: `file:${path.join(dir, "t.sqlite")}`,
      intMode: "number",
    });
    try {
      await client.execute(
        "CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)"
      );
      const tx = await client.transaction("deferred");
      await tx.execute("INSERT INTO probe (id, note) VALUES (1, 'in-txn')");
      // Runs on the SAME connection while the transaction is open; upstream's
      // unconditional rollback here would abort the transaction and make the
      // commit below fail with "cannot commit - no transaction is active".
      await client.executeMultiple(
        "CREATE TABLE IF NOT EXISTS side_a (id INTEGER); CREATE TABLE IF NOT EXISTS side_b (id INTEGER);"
      );
      await tx.commit();
      const rows = await client.execute("SELECT COUNT(*) AS n FROM probe");
      assert.equal(Number(rows.rows[0]?.n), 1);
    } finally {
      client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
