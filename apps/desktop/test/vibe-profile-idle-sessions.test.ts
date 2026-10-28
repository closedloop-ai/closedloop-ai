import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, describe, it } from "vitest";
import { closeIdleSessions } from "../scripts/vibe-profile/build-golden-store";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const NOW = "2026-10-07T03:00:00.000Z";
const IMPORT_CLOCK = "2026-10-07T02:59:00.000Z";
const MONTHS_AGO = "2026-07-01T09:30:00.000Z";
const MINUTES_AGO = "2026-10-07T02:40:00.000Z";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("closeIdleSessions", () => {
  it("closes a corpus session idle for months at its last activity and keeps a recent one active", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-idle-sessions-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      for (const [id, startedAt] of [
        ["old", MONTHS_AGO],
        ["recent", MINUTES_AGO],
      ] as const) {
        await insertSqliteSession(db, id, {
          status: SESSION_STATUS.ACTIVE,
          startedAt,
          updatedAt: IMPORT_CLOCK,
        });
      }

      const result = await closeIdleSessions(db, NOW);

      assert.equal(result.swept, 1);
      const rows = await db.prisma.client.session.findMany({
        select: { id: true, status: true, endedAt: true, updatedAt: true },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(rows, [
        {
          id: "old",
          status: SESSION_STATUS.INACTIVE,
          endedAt: MONTHS_AGO,
          updatedAt: NOW,
        },
        {
          id: "recent",
          status: SESSION_STATUS.ACTIVE,
          endedAt: null,
          updatedAt: MINUTES_AGO,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});
