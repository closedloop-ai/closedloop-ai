import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  findCorpusIdleGaps,
  KEPT_IDLE_GAP_MS,
  shiftEmbeddedSessionInstants,
  shiftStoreTimestamps,
} from "../scripts/vibe-profile/corpus-time-shift";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const OLD_START = "2026-07-01T09:00:00.000Z";
const NEW_START = "2026-07-30T08:00:00.000Z";
const IMPORT_STARTED_AT = "2026-10-07T00:00:00.000Z";
const SHIFT_MS = 60 * 60 * 1000;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("shiftStoreTimestamps with idle gaps", () => {
  it("moves instants before a closed gap forward by the gap and the rest by the shift alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-store-shift-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, "old", { startedAt: OLD_START });
      await insertSqliteSession(db, "new", { startedAt: NEW_START });
      const gaps = findCorpusIdleGaps([
        { startedAt: OLD_START, lastActivityAt: OLD_START },
        { startedAt: NEW_START, lastActivityAt: NEW_START },
      ]);

      await shiftStoreTimestamps(db.prisma, SHIFT_MS, IMPORT_STARTED_AT, gaps);

      const rows = await db.prisma.client.session.findMany({
        select: { id: true, startedAt: true },
        orderBy: { id: "asc" },
      });
      const started = new Map(rows.map((row) => [row.id, row.startedAt]));
      assert.equal(
        started.get("new"),
        new Date(Date.parse(NEW_START) + SHIFT_MS).toISOString()
      );
      assert.equal(
        Date.parse(started.get("new") ?? "") -
          Date.parse(started.get("old") ?? ""),
        KEPT_IDLE_GAP_MS
      );
    } finally {
      await db.close();
    }
  });

  it("moves the instants inside a session's JSON with the session (ISS-12135)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-store-shift-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, "old", {
        startedAt: OLD_START,
        metadata: JSON.stringify({
          messages: [{ role: "user", timestamp: OLD_START }],
          importedAt: IMPORT_STARTED_AT,
        }),
      });
      await insertSqliteSession(db, "new", { startedAt: NEW_START });
      const gaps = findCorpusIdleGaps([
        { startedAt: OLD_START, lastActivityAt: OLD_START },
        { startedAt: NEW_START, lastActivityAt: NEW_START },
      ]);

      await shiftStoreTimestamps(db.prisma, SHIFT_MS, IMPORT_STARTED_AT, gaps);
      await shiftEmbeddedSessionInstants(
        db.prisma,
        SHIFT_MS,
        IMPORT_STARTED_AT,
        gaps
      );

      const old = await db.prisma.client.session.findUniqueOrThrow({
        where: { id: "old" },
        select: { startedAt: true, metadata: true },
      });
      assert.deepEqual(JSON.parse(old.metadata ?? "{}"), {
        messages: [{ role: "user", timestamp: old.startedAt }],
        importedAt: IMPORT_STARTED_AT,
      });
    } finally {
      await db.close();
    }
  });
});
