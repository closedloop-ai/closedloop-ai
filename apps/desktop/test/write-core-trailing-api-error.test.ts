import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const NOW = "2026-07-10T12:00:00.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function querySession(
  db: Db,
  sessionId: string
): Promise<{ status: string; ended_at: string | null } | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ status: string; ended_at: string | null }>
  >("SELECT status, ended_at FROM sessions WHERE id = $1", sessionId);
  return rows[0];
}

describe("FEA-2930: trailing unrecovered API error → SessionEnd handler", () => {
  test("SessionEnd with trailing API error in transcript → finalStatus=error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-hook-err-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
      extractTranscript: () => ({
        tokensByModel: new Map(),
        latestModel: null,
        compactionCount: 0,
        records: [],
        hasTrailingApiError: true,
      }),
    });
    try {
      const sessionId = "sess-hook-trail";
      await db.processEvent(
        "SessionStart",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      await db.processEvent(
        "SessionEnd",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      const session = await querySession(db, sessionId);
      assert.equal(
        session?.status,
        "error",
        "SessionEnd with trailing error → error"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SessionEnd without trailing error → finalStatus=inactive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-hook-ok-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
      extractTranscript: () => ({
        tokensByModel: new Map(),
        latestModel: null,
        compactionCount: 0,
        records: [],
        hasTrailingApiError: false,
      }),
    });
    try {
      const sessionId = "sess-hook-ok";
      await db.processEvent(
        "SessionStart",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      await db.processEvent(
        "SessionEnd",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      const session = await querySession(db, sessionId);
      assert.equal(
        session?.status,
        "inactive",
        "SessionEnd without trailing error → inactive"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SessionEnd with no transcript → finalStatus=inactive (safe default)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-hook-null-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
    });
    try {
      const sessionId = "sess-hook-null";
      await db.processEvent(
        "SessionStart",
        { session_id: sessionId },
        "claude"
      );
      await db.processEvent("SessionEnd", { session_id: sessionId }, "claude");
      const session = await querySession(db, sessionId);
      assert.equal(session?.status, "inactive", "no transcript → inactive");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SessionEnd preserves pre-existing ERROR from Stop hook", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wc-hook-stop-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
      extractTranscript: () => ({
        tokensByModel: new Map(),
        latestModel: null,
        compactionCount: 0,
        records: [],
        hasTrailingApiError: false,
      }),
    });
    try {
      const sessionId = "sess-hook-stop";
      await db.processEvent(
        "SessionStart",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      await db.processEvent(
        "Stop",
        {
          session_id: sessionId,
          stop_reason: "error",
          transcript_path: "/fake/path.jsonl",
        },
        "claude"
      );
      await db.processEvent(
        "SessionEnd",
        { session_id: sessionId, transcript_path: "/fake/path.jsonl" },
        "claude"
      );
      const session = await querySession(db, sessionId);
      assert.equal(
        session?.status,
        "error",
        "Stop(error) + SessionEnd → error preserved"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
