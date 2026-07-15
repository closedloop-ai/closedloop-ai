/**
 * @file libsql-pragmas.test.ts
 * @description Asserts the connection PRAGMAs (cache_size, mmap_size, and the
 * reader `query_only`) are actually applied — on BOTH the boot-time migration
 * connection (`openMigrationDatabase`) AND the Prisma reader-pool connections that
 * now own the production read path (`createDesktopPrisma`, via `openTestPrisma`).
 * These are pure performance knobs with no behavioral surface, so the test pins
 * the configured values to guard against an accidental revert or a
 * silently-rejected PRAGMA on either connection role.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("connection pragmas configure cache_size and mmap_size", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "libsql-pragmas-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "t.sqlite"));

  try {
    // Negative cache_size is in KiB (not pages); we configure -16384 = 16 MiB.
    const cache = await db.query<{ cache_size: number }>("PRAGMA cache_size");
    assert.equal(cache.rows[0]?.cache_size, -16_384);

    // mmap_size is in bytes; we configure 128 MiB.
    const mmap = await db.query<{ mmap_size: number }>("PRAGMA mmap_size");
    assert.equal(mmap.rows[0]?.mmap_size, 134_217_728);

    // FEA-3132 (D5): journal_size_limit caps the persistent WAL high-water mark
    // at 64 MiB so it can never run away to the 26 GB RSS mode once readers
    // release. Returned in bytes.
    const journalLimit = await db.query<{ journal_size_limit: number }>(
      "PRAGMA journal_size_limit"
    );
    assert.equal(journalLimit.rows[0]?.journal_size_limit, 67_108_864);
  } finally {
    // Close the migration connection before test.after removes the temp dir —
    // leaves no open native handles or -wal/-shm files for rm() to trip on.
    await db.close();
  }
});

test("prisma reader connections apply the same read PRAGMAs + query_only", async () => {
  // The reader pool (not openMigrationDatabase) now serves every production read,
  // so it must carry the same tuning. Three round-robin reads cover both default
  // readers; if openPrismaConnection ever skipped connectionPragmaStatements for
  // the reader role, one of these would catch it.
  const { prisma, close } = await openTestPrisma();
  try {
    const [cache] = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ cache_size: number }[]>("PRAGMA cache_size")
    );
    assert.equal(cache?.cache_size, -16_384);

    const [mmap] = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ mmap_size: number }[]>("PRAGMA mmap_size")
    );
    assert.equal(mmap?.mmap_size, 134_217_728);

    // query_only must be ON for readers specifically (it is NOT set on the
    // writer/migration connections).
    const [queryOnly] = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ query_only: number }[]>("PRAGMA query_only")
    );
    assert.equal(queryOnly?.query_only, 1);
  } finally {
    await close();
  }
});
