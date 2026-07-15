/**
 * @file idle-reader-recycle.test.ts
 * @description FEA-3132 (D4/D5) — idle reader connections are recycled so no
 * reader snapshot outlives the recycle interval and pins the WAL (the 26 GB / RSS
 * mode). The risk of the change is that recycling could corrupt the pool or drop
 * the reader PRAGMAs; this proves the pool keeps serving reads across many
 * recycle ticks AND the recycled connections still carry `query_only=ON` (so the
 * reopen re-applied `connectionPragmaStatements("reader")`). Recycling only ever
 * touches IDLE connections — an in-flight read is never torn out (that guarantee
 * is structural: `inFlight[slot]` is incremented synchronously before any await).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const READ_QUERY_ONLY = "PRAGMA query_only";
const READ_ONE = "SELECT 1 AS n";

test("idle readers recycle without breaking reads or dropping reader PRAGMAs", async () => {
  // Single reader + a fast recycle interval so several recycles happen during
  // the test; each recycle disconnects the idle reader and reopens a fresh one.
  // `onReaderRecycle` fires per completed swap, giving us an OBSERVABLE recycle
  // signal to await instead of a fixed sleep — so a regression that stops
  // recycling (interval wiring broken) fails here instead of silently passing
  // against the original reader.
  let recycles = 0;
  let firstRecycled: (() => void) | undefined;
  const firstRecycle = new Promise<void>((resolve) => {
    firstRecycled = resolve;
  });
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: 1,
    readerRecycleIntervalMs: 25,
    onReaderRecycle: () => {
      recycles += 1;
      firstRecycled?.();
    },
  });
  try {
    const before = await prisma.read((r) =>
      r.$queryRawUnsafe<{ query_only: number }[]>(READ_QUERY_ONLY)
    );
    assert.equal(before[0]?.query_only, 1);

    // Wait for a REAL recycle to happen (with a generous timeout so a slow CI
    // worker doesn't flake), then assert one actually occurred. If recycling
    // regresses, no signal fires and this rejects rather than passing green.
    await Promise.race([
      firstRecycle,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("no reader recycle observed within 5s")),
          5000
        )
      ),
    ]);
    assert.ok(recycles >= 1, "expected at least one idle-reader recycle");

    // Reads still work on the recycled connection...
    const rows = await prisma.read((r) =>
      r.$queryRawUnsafe<{ n: number }[]>(READ_ONE)
    );
    assert.equal(Number(rows[0]?.n), 1);

    // ...and the recycled connection is STILL query_only (reader PRAGMAs were
    // re-applied on reopen — a recycle that skipped them would return 0 here).
    const after = await prisma.read((r) =>
      r.$queryRawUnsafe<{ query_only: number }[]>(READ_QUERY_ONLY)
    );
    assert.equal(after[0]?.query_only, 1);
  } finally {
    await close();
  }
});

test("recycling does not tear out an in-flight read", async () => {
  const { prisma, close } = await openTestPrisma(createWriteQueue(), {
    readerPoolSize: 1,
    readerRecycleIntervalMs: 10,
  });
  try {
    // Fire many concurrent reads while the recycler is ticking aggressively; if
    // an in-flight read's connection were ever recycled out from under it, one
    // of these would reject or return a wrong result.
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        prisma.read((r) =>
          r.$queryRawUnsafe<{ n: number }[]>(`SELECT ${i} AS n`)
        )
      )
    );
    results.forEach((rows, i) => {
      assert.equal(Number(rows[0]?.n), i);
    });
  } finally {
    await close();
  }
});
