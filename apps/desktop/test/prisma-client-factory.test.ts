/**
 * @file prisma-client-factory.test.ts
 * @description FEA-1791 / PLN-886 Phase 3 — the createDesktopPrisma factory.
 * Proves the typed client reads over an already-open SQLite handle, and that
 * write(fn) routes every mutation through the shared write queue (the
 * structural enforcement of the "all Prisma writes go through the queue" rule)
 * and preserves submission order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

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
