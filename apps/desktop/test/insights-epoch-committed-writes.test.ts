/**
 * @file insights-epoch-committed-writes.test.ts
 * @description ISS-7110 — `onCommittedWrite` must fire for EVERY committed
 * write-queue task, against REAL SQLite.
 *
 * The FEA-2055 insights cache invalidates by a data epoch, and before ISS-7110
 * the bump rode only the live-hook `emit` — so the first-launch backfill filled
 * the store without ever advancing the epoch, and the dashboard re-served
 * responses computed over the pre-backfill (empty) store on every refetch (the
 * onboarding zeros). This pins the new seam at the store boundary: a committed
 * write fires it, a rejected write does not, and a read never touches it. The
 * worker-side wiring of this seam to `bumpDataEpoch` is pinned separately by
 * `db-host-insights-epoch-wiring.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

test("ISS-7110: committed writes fire onCommittedWrite; rejected writes and reads do not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7110-epoch-"));
  let commits = 0;
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-18T12:00:00.000Z",
      onCommittedWrite: () => {
        commits += 1;
      },
    });
    try {
      // Boot maintenance writes through the same queue — let it settle so the
      // deltas below are attributable to this test's own statements.
      await db.whenBootMaintenanceSettled();
      const base = commits;

      // An ordinary importer-shaped write (no live hook involved) fires it.
      await db.run(
        `INSERT INTO agent_session_sync_outbox
           (source_key, external_session_id, status, sync_class, attempt_count,
            next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, ?, 'pending', 'backfill', 0, NULL, NULL, ?, ?)`,
        "agent_sessions:ct-7110",
        "session-7110",
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z"
      );
      assert.equal(commits, base + 1, "a committed write must fire the seam");

      // A rejected write (NOT NULL violation) must not fire it.
      await assert.rejects(
        db.run(
          "INSERT INTO agent_session_sync_outbox (source_key) VALUES (?)",
          "agent_sessions:ct-7110"
        )
      );
      assert.equal(
        commits,
        base + 1,
        "a rejected write must not fire the seam"
      );

      // A read never takes the write queue, so it must not fire it either.
      await db.getSummary();
      assert.equal(commits, base + 1, "a read must not fire the seam");
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
