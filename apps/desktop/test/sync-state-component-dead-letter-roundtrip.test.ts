/**
 * @file sync-state-component-dead-letter-roundtrip.test.ts
 * @description ISS-8593 (migration 0080): `sync_state.dead_letter_attempts`
 * round-trips through the REAL libSQL store, not only through an in-memory fake.
 *
 * That is the whole point of the column — the component lane's per-id
 * bookkeeping (`attempts`, the tombstone flag, the absolute retry deadline) has
 * to survive a process restart, and the unit suites exercise the tracker with a
 * synthetic clock and a `Map` for a store. This one writes through
 * `advanceSyncState` and reads back through `loadSyncState`, so a column that
 * was never selected, a JSON value the driver mangles, or a parser that drops
 * the field fails here rather than in production.
 *
 * It also pins the legacy shape: a cursor written by a build that predates the
 * column has NULL there, and must load with its ids intact and no bookkeeping —
 * a reset backoff, never a lost row.
 *
 * Lives in its own file because the sibling `sqlite-agent-dashboard-database.test.ts`
 * is on the shrink-only `noExcessiveLinesPerFile` grandfather list.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const COMPONENT_STATE = {
  observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
  observedIdsAtTopUpdatedAt: ["c-last"],
  deadLetteredIds: ["c-live", "c-gone"],
  deadLetterAttempts: [
    { id: "c-live", attempts: 2, tombstoned: false, retryAfterEpochMs: 1000 },
    { id: "c-gone", attempts: 0, tombstoned: true },
  ],
};

test("ISS-8593: attempts, the tombstone flag, and the retry deadline survive the durable store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8593-roundtrip-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  const key = buildAgentComponentSyncSourceKey("target-a");
  try {
    await db.syncSource.advanceSyncState?.(key, COMPONENT_STATE);
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(key),
      COMPONENT_STATE,
      "every field round-trips, including the record that omits its deadline"
    );

    // A cursor written by a build that predates the column: the ids still
    // arrive and the field is OMITTED, not answered as an empty array — so a
    // session cursor's loaded shape is byte-identical to the pre-0080 one.
    await db.run(
      "UPDATE sync_state SET dead_letter_attempts = NULL WHERE source_key = $1",
      key
    );
    const { deadLetterAttempts: _dropped, ...withoutBookkeeping } =
      COMPONENT_STATE;
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(key),
      withoutBookkeeping,
      "a NULL dead_letter_attempts loads as no bookkeeping at all, not as a lost cursor"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8593: a record the store cannot have produced is dropped, and its id still loads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8593-roundtrip-bad-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  const key = buildAgentComponentSyncSourceKey("target-b");
  try {
    await db.syncSource.advanceSyncState?.(key, COMPONENT_STATE);
    // A hand-edited row, or one written by a defective peer: a fractional
    // attempt count beside a healthy sibling.
    await db.run(
      `UPDATE sync_state SET dead_letter_attempts = '[{"id":"c-live","attempts":1.5,"tombstoned":false},{"id":"c-gone","attempts":0,"tombstoned":true}]' WHERE source_key = $1`,
      key
    );
    const loaded = await db.syncSource.loadSyncState?.(key);
    assert.deepEqual(
      loaded?.deadLetterAttempts,
      [{ id: "c-gone", attempts: 0, tombstoned: true }],
      "the impossible record is dropped and the healthy sibling survives"
    );
    assert.deepEqual(
      loaded?.deadLetteredIds,
      ["c-live", "c-gone"],
      "and BOTH ids still load — dropping a record costs a reset backoff, never a row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
