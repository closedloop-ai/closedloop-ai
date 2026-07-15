/**
 * @file prisma-client-factory.test.ts
 * @description The createDesktopPrisma factory. Proves the typed client reads
 * over an already-open SQLite handle, and that
 * write(fn) routes every mutation through the shared write queue (the
 * structural enforcement of the "all Prisma writes go through the queue" rule)
 * and preserves submission order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

// query_only rejects a write with SQLITE_READONLY (extended code 8); the adapter
// surfaces it as "Raw query failed. Code: `8`. Message: `SQLITE_READONLY: …`".
const SQLITE_READONLY_PATTERN = /SQLITE_READONLY|readonly/i;

test("client reads over the existing SQLite handle without going through the queue", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    assert.equal(await prisma.client.packCatalog.count(), 0);
    // Reads must not consume the write queue.
    assert.equal(queue.runs, 0);
  } finally {
    await close();
  }
});

test("write(fn) routes through the shared queue, passes the client, returns the result", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const created = await prisma.write((client) =>
      client.packCatalog.create({
        data: {
          packId: "p1",
          displayName: "P1",
          githubUrl: "https://example.test/p1",
        },
      })
    );
    assert.equal(created.packId, "p1");
    assert.equal(queue.runs, 1);
    assert.equal(await prisma.client.packCatalog.count(), 1);
  } finally {
    await close();
  }
});

test("read() dispatches to the pool, sees committed data, and never touches the write queue", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    await prisma.write((client) =>
      client.packCatalog.create({
        data: {
          packId: "p1",
          displayName: "P1",
          githubUrl: "https://example.test/p1",
        },
      })
    );
    const runsAfterWrite = queue.runs;
    // A pooled read sees the committed row and does NOT consume the queue.
    assert.equal(await prisma.read((reader) => reader.packCatalog.count()), 1);
    assert.equal(queue.runs, runsAfterWrite);
  } finally {
    await close();
  }
});

test("read() runs on a query_only connection that rejects writes", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // query_only backstops the read-vs-write convention: ANY write faults at the
    // engine (SQLITE_READONLY / code 8), so a reader can never take the write
    // lock and block the backfill writer. DDL is a write, so it is rejected too —
    // and needs no table to exist.
    // Discriminate on the SQLITE_READONLY signal so this can ONLY pass because
    // the query_only PRAGMA rejected the write — not some unrelated rejection
    // (table-exists, client error, I/O).
    await assert.rejects(
      prisma.read((reader) =>
        reader.$queryRawUnsafe("CREATE TABLE _query_only_probe (x INTEGER)")
      ),
      SQLITE_READONLY_PATTERN
    );
  } finally {
    await close();
  }
});

test("read() reads CONCURRENTLY with an open writer transaction (WAL snapshot, not serialized)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((client) =>
      client.packCatalog.create({
        data: {
          packId: "committed",
          displayName: "Committed",
          githubUrl: "https://example.test/c",
        },
      })
    );

    let readResolvedDuringOpenTx = false;
    let countSeenDuringTx = -1;
    // Hold a writer transaction OPEN, and from inside it issue a pooled read.
    // The reader is a separate connection, so it resolves WITHOUT waiting for the
    // writer to commit (the whole point of the pool), and — WAL snapshot
    // isolation — it sees only the pre-tx committed state, not the uncommitted
    // insert. Both assertions are deterministic, not timing-dependent.
    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.packCatalog.create({
          data: {
            packId: "uncommitted",
            displayName: "Uncommitted",
            githubUrl: "https://example.test/u",
          },
        });
        countSeenDuringTx = await prisma.read((reader) =>
          reader.packCatalog.count()
        );
        readResolvedDuringOpenTx = true;
      })
    );

    assert.equal(readResolvedDuringOpenTx, true);
    assert.equal(countSeenDuringTx, 1); // committed only; not the in-flight row
    assert.equal(
      await prisma.read((reader) => reader.packCatalog.count()),
      2 // after commit, the pool sees both
    );
  } finally {
    await close();
  }
});

test("read() exposes a snapshot $transaction for multi-read consistency", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((client) =>
      client.packCatalog.create({
        data: {
          packId: "p1",
          displayName: "P1",
          githubUrl: "https://example.test/p1",
        },
      })
    );
    const result = await prisma.read((reader) =>
      reader.$transaction(async (tx) => {
        const viaDelegate = await tx.packCatalog.count();
        const viaRaw = await tx.$queryRawUnsafe<{ c: number }[]>(
          "SELECT COUNT(*) AS c FROM pack_catalog"
        );
        return { viaDelegate, viaRaw: Number(viaRaw[0]?.c ?? -1) };
      })
    );
    assert.equal(result.viaDelegate, 1);
    assert.equal(result.viaRaw, 1);
  } finally {
    await close();
  }
});

test("concurrent writes serialize in submission order", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const order: string[] = [];
    const first = prisma.write(async (client) => {
      await client.packCatalog.create({
        data: {
          packId: "a",
          displayName: "A",
          githubUrl: "https://example.test/a",
        },
      });
      order.push("a");
    });
    const second = prisma.write(async (client) => {
      await client.packCatalog.create({
        data: {
          packId: "b",
          displayName: "B",
          githubUrl: "https://example.test/b",
        },
      });
      order.push("b");
    });
    await Promise.all([first, second]);

    assert.deepEqual(order, ["a", "b"]);
    assert.equal(queue.runs, 2);
  } finally {
    await close();
  }
});
