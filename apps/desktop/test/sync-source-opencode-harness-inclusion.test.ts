/**
 * @file sync-source-opencode-harness-inclusion.test.ts
 * @description ISS-4627 — OpenCode sessions must not be silently stranded from
 * cloud sync or the desktop Sessions/sync-progress UI.
 *
 * The bulk session-sync driver enumerates sync-eligible sessions through the
 * SQLite-backed `AgentSessionSyncSource.listAllSessionCursorRows()` cursor walk
 * (`initializeBackfillQueueIfNeeded` → `listInitialCursorRows`), and the
 * Sessions list / sync-progress harness facet is populated from the
 * `getSharedAgentSessionUsage` `byHarness` rollup (`GROUP BY sessions.harness`).
 * Both are — and must stay — CONTENT-BLIND to the harness value: an OpenCode
 * session enqueues for sync and is counted exactly like a Claude or Codex one.
 *
 * This suite drives the REAL SQLite → sync-source boundary and asserts:
 *   1. an OpenCode-harness session IS enumerated by `listAllSessionCursorRows`
 *      (so it CAN enqueue for cloud sync — not filtered out before enqueue), and
 *      is counted in the `byHarness` usage rollup (so it appears in the Sessions
 *      harness facet + sync UI counts);
 *   2. version-skew: an UNKNOWN/future harness value degrades to INCLUDED
 *      (enumerated + counted), never silently dropped.
 *
 * Mutation guard: adding a `WHERE harness IN ('claude', …)` allow-list that
 * omits OpenCode (or any future harness) to the cursor walk or the harness
 * rollup would drop the seeded rows here and fail this test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Harness } from "@repo/lib/harness/types";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";

test("ISS-4627: an OpenCode session is enumerated by the sync cursor and counted in the harness rollup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4627-opencode-"));
  try {
    const dataDir = path.join(dir, "agent-dashboard.pgdata");
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "api",
      now: () => "2026-07-29T12:00:00.000Z",
    });
    try {
      // A Claude session (the known-working harness) plus an OpenCode session,
      // so the assertion proves OpenCode is included ALONGSIDE Claude rather
      // than the corpus being empty.
      await insertSession(db, {
        id: "s-claude",
        harness: Harness.Claude,
        startedAt: "2026-03-10T10:00:00.000Z",
      });
      await insertSession(db, {
        id: "s-opencode",
        harness: Harness.OpenCode,
        startedAt: "2026-03-11T10:00:00.000Z",
      });

      // (1) Sync eligibility: the bulk-sync driver's cursor walk enumerates the
      // OpenCode session, so it CAN enqueue for cloud sync.
      const cursorRows = await db.syncSource.listAllSessionCursorRows();
      const cursorIds = new Set(cursorRows.map((row) => row.id));
      assert.ok(
        cursorIds.has("s-opencode"),
        "the OpenCode session must be enumerated by listAllSessionCursorRows (sync-eligible)"
      );
      assert.ok(
        cursorIds.has("s-claude"),
        "the Claude session is enumerated too (sanity: the walk is not empty)"
      );

      // (2) UI visibility: the OpenCode session is counted in the byHarness
      // rollup that sources the Sessions harness facet + sync-progress counts.
      const usage = await getSharedAgentSessionUsage(db.syncSource);
      assert.equal(
        harnessCount(usage.byHarness, Harness.OpenCode),
        1,
        "the OpenCode session must be counted in the byHarness rollup (visible in the Sessions/sync UI)"
      );
      assert.equal(
        harnessCount(usage.byHarness, Harness.Claude),
        1,
        "the Claude session is counted too (content-blind rollup)"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4627: an unknown/future harness degrades to INCLUDED, not silently dropped (version-skew)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4627-unknown-"));
  try {
    const dataDir = path.join(dir, "agent-dashboard.pgdata");
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "api",
      now: () => "2026-07-29T12:00:00.000Z",
    });
    try {
      await insertSession(db, {
        id: "s-future",
        harness: unknownFutureHarness,
        startedAt: "2026-03-12T10:00:00.000Z",
      });

      const cursorRows = await db.syncSource.listAllSessionCursorRows();
      assert.ok(
        cursorRows.some((row) => row.id === "s-future"),
        "an unknown harness must still be enumerated for sync (default-include, never dropped)"
      );

      const usage = await getSharedAgentSessionUsage(db.syncSource);
      assert.equal(
        harnessCount(usage.byHarness, unknownFutureHarness),
        1,
        "an unknown harness must still be counted in the byHarness rollup (visible, not omitted)"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

// A harness value this build does not know (a newer Desktop/CLI shipping a
// harness before this build learned it). It must degrade to INCLUDED, not
// silently dropped — the whole ISS-4627 complaint is silent omission.
const unknownFutureHarness = "future-cli";

async function insertSession(
  db: SqliteDb,
  seed: { id: string; harness: string; startedAt: string }
): Promise<void> {
  // The desktop SQLite `sessions.status` column stores raw lowercase harness
  // lifecycle strings ('completed'/'error'/'abandoned' — see session-maintenance
  // and sqlite.ts); there is no app-side status enum for this local store, and
  // the app-side SESSION_STATUS uses uppercase values that this store rejects.
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, $2, $3, 'api')`,
    seed.id,
    seed.startedAt,
    seed.harness
  );
}

function harnessCount(
  byHarness: readonly { harness: string; sessionCount: number }[],
  harness: string
): number {
  return byHarness.find((row) => row.harness === harness)?.sessionCount ?? 0;
}
