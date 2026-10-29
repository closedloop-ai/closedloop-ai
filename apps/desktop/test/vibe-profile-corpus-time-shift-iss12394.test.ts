import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCorpusIdleGaps,
  KEPT_IDLE_GAP_MS,
  parseIsoInstant,
  shiftEmbeddedSessionInstants,
  shiftStoreTimestamps,
} from "../scripts/vibe-profile/corpus-time-shift";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const IMPORT_STARTED_AT = "2026-10-07T00:00:00.000Z";
const SHIFT_MS = 60 * 60 * 1000;
const START = "2026-07-01T09:00:00.000Z";
const NOT_ISO_RE = /^x must be an ISO-8601 instant, got 2026-13-45T10:00Z$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openStore(): Promise<SqliteAgentDatabase> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-shift-12394-"));
  dirs.push(dir);
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
    retentionDays: 36_500,
  });
}

describe("parseIsoInstant", () => {
  it("refuses a shape-valid instant whose date does not exist", () => {
    expect(() => parseIsoInstant("2026-13-45T10:00Z", "x")).toThrow(NOT_ISO_RE);
  });
});

describe("findCorpusIdleGaps ordering", () => {
  it("orders same-start spans longest first, so the longer span's end bounds the next gap", () => {
    const later = new Date(Date.parse(START) + 5 * DAY_MS).toISOString();
    const gaps = findCorpusIdleGaps([
      { startedAt: START, lastActivityAt: START },
      {
        startedAt: START,
        lastActivityAt: new Date(Date.parse(START) + DAY_MS).toISOString(),
      },
      { startedAt: later, lastActivityAt: later },
    ]);

    expect(gaps).toEqual([
      { beforeIso: later, closeMs: 4 * DAY_MS - KEPT_IDLE_GAP_MS },
    ]);
  });
});

describe("shiftStoreTimestamps without idle gaps", () => {
  it("moves every corpus instant by the shift alone and leaves import-stamped ones", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "old", {
        startedAt: START,
        updatedAt: IMPORT_STARTED_AT,
      });

      const result = await shiftStoreTimestamps(
        db.prisma,
        SHIFT_MS,
        IMPORT_STARTED_AT
      );

      expect(result.columnsShifted).toBeGreaterThan(0);
      const [row] = await db.prisma.client.session.findMany({
        select: { startedAt: true, updatedAt: true },
      });
      expect(row).toEqual({
        startedAt: new Date(Date.parse(START) + SHIFT_MS).toISOString(),
        updatedAt: IMPORT_STARTED_AT,
      });
    } finally {
      await db.close();
    }
  });
});

describe("shiftEmbeddedSessionInstants skips", () => {
  it("counts only JSON values that changed, ignoring non-JSON text and JSON with nothing to shift", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "json", {
        startedAt: START,
        metadata: JSON.stringify({ at: START }),
      });
      await insertSqliteSession(db, "plain", {
        startedAt: START,
        metadata: START,
      });
      await insertSqliteSession(db, "nothing", {
        startedAt: START,
        metadata: JSON.stringify({ note: "no instants" }),
      });

      const shifted = await shiftEmbeddedSessionInstants(
        db.prisma,
        SHIFT_MS,
        IMPORT_STARTED_AT
      );

      expect(shifted).toBe(1);
      const rows = await db.prisma.client.$queryRawUnsafe<
        { id: string; metadata: string }[]
      >("SELECT id, metadata FROM sessions ORDER BY id");
      expect(rows).toEqual([
        {
          id: "json",
          metadata: JSON.stringify({
            at: new Date(Date.parse(START) + SHIFT_MS).toISOString(),
          }),
        },
        { id: "nothing", metadata: JSON.stringify({ note: "no instants" }) },
        { id: "plain", metadata: START },
      ]);
    } finally {
      await db.close();
    }
  });
});
