/**
 * @file prisma-client-raw-coercion.test.ts
 * @description FEA-1791 / PLN-886 Phase 3 — direct coverage for the raw-SQL
 * compatibility shim that `createDesktopPrisma` wraps around the Prisma libSQL
 * client (`wrapRawCoercion`). The converted write paths rely on this shim for
 * two transforms the legacy `libsql-executor.ts` applied to every raw call but
 * the Prisma adapter drops: `$N`→`?N` placeholder translation and per-arg bind
 * coercion. These tests exercise the real factory over a real on-disk libSQL
 * database (no mocks) so a regression in either transform fails here instead of
 * silently corrupting an import/backfill transaction.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openLibsqlDatabase } from "../src/main/database/libsql-executor.js";
import {
  createDesktopPrisma,
  type DesktopPrisma,
} from "../src/main/database/prisma-client.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";

async function openProbe(): Promise<{
  prisma: DesktopPrisma;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prisma-raw-coercion-"));
  const { db, config } = await openLibsqlDatabase(
    path.join(dir, "probe.sqlite")
  );
  const prisma = createDesktopPrisma(config, createWriteQueue());
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `CREATE TABLE probe (
         id TEXT PRIMARY KEY,
         flag INTEGER,
         ts TEXT,
         payload TEXT,
         note TEXT
       )`
    )
  );
  return {
    prisma,
    close: async () => {
      await prisma.disconnect();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("translates $N placeholders to ?N so out-of-order params bind by index", async () => {
  const { prisma, close } = await openProbe();
  try {
    // $2/$3 appear textually before $1. SQLite treats `$N` as a NAMED parameter
    // numbered by order of first appearance, so without translateNumberedParams
    // the positional args would misbind ($2←arg0, $3←arg1, $1←arg2). The shim
    // rewrites these to `?N`, which bind by explicit 1-based index regardless of
    // textual order — the contract the converted `$N`-style SQL assumes.
    const rows = await prisma.client.$queryRawUnsafe<
      { b_first: number | bigint; c_second: string; a_third: string }[]
    >("SELECT $2 AS b_first, $3 AS c_second, $1 AS a_third", "A", 2, "C");
    assert.equal(Number(rows[0]?.b_first), 2);
    assert.equal(rows[0]?.c_second, "C");
    assert.equal(rows[0]?.a_third, "A");
  } finally {
    await close();
  }
});

test("coerces boolean/Date/object/undefined/bigint binds inside a $transaction", async () => {
  const { prisma, close } = await openProbe();
  try {
    const ts = new Date("2026-06-24T00:00:00.000Z");
    // The adapter binds args straight to the driver, which only accepts numbers,
    // strings, bigints, buffers, and null. Each of these would otherwise throw
    // "SQLite3 can only bind ..." and roll back the whole transaction. The shim
    // re-wraps the interactive-transaction `tx`, so coercion applies on `tx`
    // too — boolean→0/1, Date→ISO, object→JSON (bigint-safe), undefined→null.
    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO probe (id, flag, ts, payload, note)
           VALUES ($1, $2, $3, $4, $5)`,
          "row-coerce",
          true,
          ts,
          { kind: "x", big: 123n },
          undefined
        );
      })
    );

    const rows = await prisma.client.$queryRawUnsafe<
      {
        flag: number | bigint;
        ts: string;
        payload: string;
        note: string | null;
      }[]
    >("SELECT flag, ts, payload, note FROM probe WHERE id = $1", "row-coerce");
    const row = rows[0];
    assert.equal(Number(row?.flag), 1);
    assert.equal(row?.ts, ts.toISOString());
    assert.deepEqual(JSON.parse(row?.payload ?? "null"), {
      kind: "x",
      big: 123,
    });
    assert.equal(row?.note, null);
  } finally {
    await close();
  }
});

test("coerces a boolean false bind to 0 on the read escape hatch outside a transaction", async () => {
  const { prisma, close } = await openProbe();
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO probe (id, flag) VALUES ($1, $2)",
        "row-false",
        false
      )
    );
    // The read escape hatch (`prisma.client.$queryRawUnsafe`) is wrapped too, so
    // a boolean bind in a WHERE coerces to 0/1 and matches the stored value.
    const rows = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM probe WHERE flag = $1",
      false
    );
    assert.equal(rows[0]?.id, "row-false");
  } finally {
    await close();
  }
});
