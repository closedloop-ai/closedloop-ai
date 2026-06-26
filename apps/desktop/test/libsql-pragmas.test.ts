/**
 * @file libsql-pragmas.test.ts
 * @description Asserts the read-path connection PRAGMAs (cache_size, mmap_size)
 * are actually applied by `openLibsqlDatabase`. These are pure performance knobs
 * with no behavioral surface, so the test pins the configured values to guard
 * against an accidental revert or a silently-rejected PRAGMA.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openLibsqlDatabase } from "../src/main/database/libsql-executor.js";

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("connection pragmas configure cache_size and mmap_size", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "libsql-pragmas-"));
  tempDirs.push(dir);
  const { db } = await openLibsqlDatabase(path.join(dir, "t.sqlite"));

  try {
    // Negative cache_size is in KiB (not pages); we configure -16384 = 16 MiB.
    const cache = await db.query<{ cache_size: number }>("PRAGMA cache_size");
    assert.equal(cache.rows[0]?.cache_size, -16_384);

    // mmap_size is in bytes; we configure 128 MiB.
    const mmap = await db.query<{ mmap_size: number }>("PRAGMA mmap_size");
    assert.equal(mmap.rows[0]?.mmap_size, 134_217_728);
  } finally {
    // Close the writer + reader connections before test.after removes the temp
    // dir — leaves no open native handles or -wal/-shm files for rm() to trip on.
    await db.close();
  }
});
