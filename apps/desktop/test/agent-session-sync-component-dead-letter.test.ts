/**
 * @file agent-session-sync-component-dead-letter.test.ts
 * @description Integration coverage for ISS-4542: the component-inventory sync
 * lane must DEAD-LETTER a permanently-failing batch to the BACK of the line
 * instead of head-of-line-blocking the whole lane.
 *
 * BUG (before the fix): `runComponentSync` left the durable keyset cursor
 * UNMOVED on ANY non-2xx send (including a never-clearing 403). A permanent
 * failure on the first batch re-failed every 5s tick forever, so nothing behind
 * it ever synced.
 *
 * FIX: charge the failure against the batch's keyset boundary; after a bounded
 * number of consecutive failures, dead-letter the batch (advance the cursor past
 * it) so the lane drains everything behind it. Re-attempt dead-lettered ids ONLY
 * once the live cursor is drained AND no newer incremental has entered, on a
 * bounded backoff → quarantine. Surface the dead-lettered count in
 * `getSyncProgress().deadLetteredComponents`.
 *
 * These tests drive the private lane through the public tick surface (`start()`
 * fires the first tick, `refresh()` drives each subsequent one), mirroring
 * `agent-session-sync-component-cursor-keyset.test.ts`, with an injected
 * `sendComponents` that fails for a chosen poison id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  flush,
  laneFailureResult,
  sendResultFor,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";
import { deferred } from "./deferred.js";

const COMPUTE_TARGET = "target-dead-letter";

/** An in-memory keyset table reproducing the production read: rows sorted by
 * (last_seen_at, id) ASC, returned STRICTLY AFTER `(sinceTs, sinceId)`. */
function makeKeysetTable(getRows: () => AgentComponentCursorRow[]) {
  const norm = (ts: string | null): string => ts ?? "";
  return {
    read(sinceTs: string, sinceId: string): AgentComponentCursorRow[] {
      const sorted = [...getRows()].sort((a, b) => {
        const at = norm(a.last_seen_at);
        const bt = norm(b.last_seen_at);
        if (at !== bt) {
          return at < bt ? -1 : 1;
        }
        if (a.id === b.id) {
          return 0;
        }
        return a.id < b.id ? -1 : 1;
      });
      return sorted.filter((r) => {
        const t = norm(r.last_seen_at);
        return t > sinceTs || (t === sinceTs && r.id > sinceId);
      });
    },
  };
}

/**
 * Settle the fire-and-forget component lane on a REAL completion signal
 * (shafty023 review / FEA-2399): `whenComponentSyncSettled()` awaits the lane's
 * actual load/send/advance awaits and the single-flight guard clearing, so a tick
 * with one extra await in the production path can no longer race stale state the
 * way a fixed flush count did. One trailing `flush()` drains the microtask turn
 * for any synchronous follow-up (diag/log) after the promise settles.
 */
async function settle(service: AgentSessionSyncService): Promise<void> {
  await service.whenComponentSyncSettled();
  await flush();
}

/**
 * Drive N ticks (start fires the first). Batch size is 1 in these tests (one row
 * per distinct timestamp), so each tick sends exactly one component and the
 * poison row's boundary accumulates failures across ticks. Each tick fully
 * settles before the next, so the single-flight guard never swallows a tick.
 */
async function driveTicks(service: AgentSessionSyncService, ticks: number) {
  service.start();
  await settle(service);
  for (let i = 1; i < ticks; i++) {
    service.refresh();
    await settle(service);
  }
}

test("dead-letter: a permanently-failing item is dead-lettered to the back of the line and the lane ADVANCES (items behind it sync)", async () => {
  gatewayLog.clear();

  // Three rows at strictly-increasing timestamps → batch size 1 per tick. The
  // FIRST row ("poison") always fails to send; the two behind it must still sync.
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
    { id: "good-1", last_seen_at: "2026-07-20T11:00:00.000Z" },
    { id: "good-2", last_seen_at: "2026-07-20T12:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  const sends: string[][] = [];

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    // The poison id is rejected on EVERY send (a permanent 403 that never clears).
    sendComponents: (payload) => {
      const ids = payload.components.map((c) => c.externalId);
      sends.push(ids);
      return Promise.resolve(sendResultFor(!ids.includes("poison")));
    },
  };

  const service = new AgentSessionSyncService(options);
  // Enough ticks: THRESHOLD failed attempts on the poison boundary, then it
  // dead-letters and the two good rows page through, plus headroom.
  await driveTicks(service, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 6);
  // Sample the dead-letter count BEFORE stop(): stop() resets all source-derived
  // state (including the dead-letter tracker), so reading it afterward would see 0.
  const progress = service.getSyncProgress();
  service.stop();

  const uploaded = new Set(sends.flat());
  assert.ok(
    uploaded.has("good-1") && uploaded.has("good-2"),
    "both rows behind the poison item synced (lane advanced past the dead-letter)"
  );
  assert.equal(
    progress.deadLetteredComponents,
    1,
    "the poison item is surfaced as dead-lettered"
  );
});

test("dead-letter (mutation guard): while the batch stays in place below the threshold, the lane does NOT advance past the poison item", async () => {
  gatewayLog.clear();

  // Same shape, but drive FEWER ticks than the failure threshold so the poison
  // batch is still being retried in place. Reverting the fix to a bare
  // `return false` (cursor unmoved) is exactly this state — this test proves the
  // items behind the poison item do NOT sync while it is retried in place, and
  // the companion test above proves they DO once it dead-letters. Together they
  // pin the head-of-line-unblock behavior a `return false` regression would fail.
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
    { id: "good-1", last_seen_at: "2026-07-20T11:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  const sends: string[][] = [];

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      const ids = payload.components.map((c) => c.externalId);
      sends.push(ids);
      return Promise.resolve(sendResultFor(!ids.includes("poison")));
    },
  };

  const service = new AgentSessionSyncService(options);
  // Strictly fewer ticks than the threshold: the poison batch is retried in
  // place and never dead-letters, so "good-1" stays blocked behind it.
  await driveTicks(service, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD - 1);
  // Sample before stop() (which resets the tracker to 0 regardless).
  const progress = service.getSyncProgress();
  service.stop();

  const uploaded = new Set(sends.flat());
  assert.ok(
    !uploaded.has("good-1"),
    "below the threshold the cursor stays put — the item behind the poison item is still blocked"
  );
  // Every send this window was the poison batch, retried in place.
  assert.ok(
    sends.every((batch) => batch.includes("poison")),
    "the lane re-sends the same poison batch while under the retry budget"
  );
  assert.equal(
    progress.deadLetteredComponents,
    0,
    "nothing dead-lettered yet below the threshold"
  );
});

test("dead-letter: once drained, the immediately-due re-attempt clears the item when its failure resolves (never dropped)", async () => {
  gatewayLog.clear();

  // One poison row and nothing else. It fails for the in-place retry budget
  // (THRESHOLD sends), dead-letters, and — since the lane is now drained — its
  // FIRST re-attempt is due immediately. That re-attempt succeeds (the 403
  // cleared), so the id leaves the dead-letter set: eventual consistency without
  // ever hard-dropping the row. Using the immediately-due first re-attempt keeps
  // the test deterministic (no backoff window to wait on / fake timers).
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  let calls = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    // Fail for the whole in-place retry budget, then succeed — so the dead-letter
    // fires, and the drained lane's immediately-due first re-attempt clears it.
    sendComponents: () => {
      calls += 1;
      return Promise.resolve(
        sendResultFor(calls > COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD)
      );
    },
  };

  const service = new AgentSessionSyncService(options);
  await driveTicks(service, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 3);
  // Sample the CLEARED count before stop() — stop() also zeroes it, so reading
  // after stop would pass even if the re-attempt had NOT cleared the item.
  const progress = service.getSyncProgress();
  service.stop();

  assert.ok(
    calls > COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
    "the drained lane actually re-attempted the dead-lettered item"
  );
  assert.equal(
    progress.deadLetteredComponents,
    0,
    "the dead-lettered item cleared once its re-attempt succeeded (never dropped)"
  );
});

test("dead-letter: newer incremental work is NEVER starved — a dead-lettered item waits while the live cursor still has rows", async () => {
  gatewayLog.clear();

  // A poison row (fails forever) plus a stream of good rows that keep arriving:
  // the live cursor is NEVER drained while good work exists, so the dead-letter
  // re-attempt path must not run and cannot starve the live/incremental rows.
  const good: AgentComponentCursorRow[] = [
    { id: "good-1", last_seen_at: "2026-07-20T11:00:00.000Z" },
    { id: "good-2", last_seen_at: "2026-07-20T12:00:00.000Z" },
    { id: "good-3", last_seen_at: "2026-07-20T13:00:00.000Z" },
  ];
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
    ...good,
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  const reattemptedPoison: string[] = [];
  let poisonDeadLettered = false;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      const ids = payload.components.map((c) => c.externalId);
      // Once the poison id has dead-lettered, any FURTHER send of it must be a
      // drained re-attempt — record it so we can assert it only happens after the
      // good rows have all shipped, never while good rows remain.
      if (poisonDeadLettered && ids.includes("poison")) {
        reattemptedPoison.push(...ids);
      }
      return Promise.resolve(sendResultFor(!ids.includes("poison")));
    },
  };

  const service = new AgentSessionSyncService(options);
  // Drive to the threshold (poison dead-letters) while good rows still remain.
  service.start();
  await settle(service);
  for (let i = 1; i < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD; i++) {
    service.refresh();
    await settle(service);
  }
  poisonDeadLettered = true;

  // Now good rows are still pending. Drive one tick — it must page a GOOD row
  // (the live cursor still has rows), so the drained re-attempt must NOT fire.
  service.refresh();
  await settle(service);
  assert.deepEqual(
    reattemptedPoison,
    [],
    "no dead-letter re-attempt while newer/incremental rows are still pending"
  );

  service.stop();
});

test("dead-letter durability: a poison item survives a cold restart — persisted onto the cursor row and re-driven by a fresh service instance", async () => {
  gatewayLog.clear();

  // A single poison row that fails forever. It dead-letters, the cursor advances
  // PAST it and persists deadLetteredIds. A brand-new service instance (cold
  // restart) hydrates from that persisted state, re-seeds its tracker, and — lane
  // drained — re-attempts the poison. Proves eventual consistency across restart:
  // the item is never stranded past the monotonic cursor.
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);

  // Minimal in-memory persisting source shared across the two instances. Only
  // loadSyncState/advanceSyncState are exercised by the component lane; the rest
  // of `AgentSessionSyncSource` is unused, so we build just those two and expose
  // it through `getSource` with a single cast (test-local).
  const store = new Map<string, PersistedSyncState>();
  const source: Pick<
    AgentSessionSyncSource,
    "loadSyncState" | "advanceSyncState"
  > = {
    loadSyncState: (key: string) => store.get(key) ?? null,
    advanceSyncState: (key: string, state: PersistedSyncState) => {
      store.set(key, state);
    },
  };

  const makeOptions = (sends: string[][]): AgentSessionSyncServiceOptions => ({
    isHttpReady: () => true,
    getSource: () => source as AgentSessionSyncSource,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      const ids = payload.components.map((c) => c.externalId);
      sends.push(ids);
      return Promise.resolve(sendResultFor(!ids.includes("poison")));
    },
  });

  // First instance: dead-letter the poison item and persist.
  const sends1: string[][] = [];
  const service1 = new AgentSessionSyncService(makeOptions(sends1));
  await driveTicks(service1, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 2);
  assert.equal(
    service1.getSyncProgress().deadLetteredComponents,
    1,
    "poison dead-lettered on the first instance"
  );
  service1.stop();
  assert.deepEqual(
    store.get(buildAgentComponentSyncSourceKey(COMPUTE_TARGET))
      ?.deadLetteredIds,
    ["poison"],
    "the dead-letter id was persisted onto the durable cursor row"
  );

  // Second instance (cold restart): hydrate + re-seed + re-attempt the poison.
  const sends2: string[][] = [];
  const service2 = new AgentSessionSyncService(makeOptions(sends2));
  await driveTicks(service2, 3);
  const progress2 = service2.getSyncProgress();
  service2.stop();

  assert.ok(
    sends2.some((batch) => batch.includes("poison")),
    "the restarted instance re-drove the dead-lettered poison item (never stranded)"
  );
  assert.equal(
    progress2.deadLetteredComponents,
    1,
    "still tracked as dead-lettered after restart (failure persists) — not dropped"
  );
});

test("lane-failure: a lane-wide send failure (401/403/network/5xx) does NOT dead-letter or advance the cursor", async () => {
  gatewayLog.clear();

  // A single row whose EVERY send returns a lane-wide failure (e.g. an expired
  // token → 401, or a server outage → 5xx). Before the shafty023 fix this bare
  // `false` would, after THRESHOLD ticks, dead-letter the row and walk the cursor
  // forward — stranding it despite the failure being lane-wide, not the row's
  // fault. It must instead stay in place: never dead-lettered, cursor never moved.
  const rows: AgentComponentCursorRow[] = [
    { id: "healthy", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  const sends: string[][] = [];

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    // EVERY send is a lane-wide failure — the outage/denial never clears.
    sendComponents: (payload) => {
      sends.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(laneFailureResult());
    },
  };

  const service = new AgentSessionSyncService(options);
  // Drive WELL PAST the dead-letter threshold: a boolean-era regression would
  // have dead-lettered by now. The typed LaneFailure must never charge the budget.
  await driveTicks(service, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 4);
  const progress = service.getSyncProgress();
  service.stop();

  assert.equal(
    progress.deadLetteredComponents,
    0,
    "a lane-wide failure must NEVER dead-letter — nothing charged the poison budget"
  );
  assert.ok(
    sends.length > COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
    "the same batch kept retrying in place (cursor never advanced past it)"
  );
  assert.ok(
    sends.every((batch) => batch.length === 1 && batch[0] === "healthy"),
    "every retry re-sent the SAME healthy row — the cursor did not walk forward"
  );
});

test("live-path clear: a dead-lettered row that re-enters the live cursor and succeeds has its dead-letter entry cleared (no stale Settings count, no re-send)", async () => {
  gatewayLog.clear();

  // One row that fails until it dead-letters, then we bump its last_seen_at so it
  // re-enters the LIVE keyset path ahead of the cursor and this time succeeds.
  const poison: AgentComponentCursorRow = {
    id: "flaky",
    last_seen_at: "2026-07-20T10:00:00.000Z",
  };
  let failSend = true;
  const rows: AgentComponentCursorRow[] = [poison];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: () => Promise.resolve(sendResultFor(!failSend)),
  };

  const service = new AgentSessionSyncService(options);
  // Drive enough ticks to dead-letter the poison row (it fails every send).
  await driveTicks(service, COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 1);
  assert.equal(
    service.getSyncProgress().deadLetteredComponents,
    1,
    "the row dead-lettered after repeated failures"
  );

  // Now its last_seen_at advances (a natural change) and sends start succeeding —
  // it re-enters the LIVE keyset path ahead of the cursor and syncs.
  poison.last_seen_at = "2026-07-20T20:00:00.000Z";
  failSend = false;
  service.refresh();
  await settle(service);
  service.refresh();
  await settle(service);

  const progress = service.getSyncProgress();
  service.stop();
  assert.equal(
    progress.deadLetteredComponents,
    0,
    "the live-path success cleared the row's dead-letter entry (no stale count / re-send)"
  );
});

test("supersession: a send that resolves AFTER stop() (identity reset) does not write stale boundary/cursor state back", async () => {
  gatewayLog.clear();

  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);

  // Hold the send open so we can stop() the service (bumping the source-state
  // generation and clearing the tracker) BEFORE the send resolves. If the
  // supersession guard were missing, the resolved send would charge the poison
  // budget on the now-cleared tracker.
  const heldSend = deferred<ReturnType<typeof laneFailureResult>>();

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: () => heldSend.promise,
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  await flush();

  // The send is now in flight. Stop the service — resetSourceState() bumps the
  // generation and clears the dead-letter tracker + cursor.
  service.stop();

  // Resolve the in-flight send as a BatchRejected (the class that WOULD charge the
  // poison budget were the run not superseded), then let it settle.
  heldSend.resolve({
    outcome: "batch-rejected",
    firstUnsentChunkIndex: 0,
    chunkCount: 1,
  });
  await settle(service);

  // A fresh instance for the same identity must see a clean slate — the stale
  // resolved send left NO boundary failure count and NO dead-letter behind.
  const service2 = new AgentSessionSyncService(options);
  const progress = service2.getSyncProgress();
  service2.stop();
  assert.equal(
    progress.deadLetteredComponents,
    0,
    "the superseded send did not write a dead-letter into the cleared/new tracker"
  );
});

test("settle identity: a second tick while a slow send is held open does NOT let whenComponentSyncSettled resolve early (shafty023 review)", async () => {
  gatewayLog.clear();

  const rows: AgentComponentCursorRow[] = [
    { id: "slow", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const table = makeKeysetTable(() => rows);
  const sends: string[][] = [];

  // Hold the first send open. A refresh() tick that arrives while it is still in
  // flight is bounced by the single-flight guard; before the identity fix it
  // replaced the real run promise with an already-resolved one, so
  // whenComponentSyncSettled() could resolve before the held send completed.
  const held = deferred<ReturnType<typeof sendResultFor>>();
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(table.read(sinceTs, sinceId).slice(0, 1)),
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      sends.push(payload.components.map((c) => c.externalId));
      return held.promise;
    },
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  await flush();
  // The real run's send is now held open. Fire a second tick that the guard bounces.
  service.refresh();
  await flush();

  // Race the settle signal against a resolved marker: while the send is held, the
  // marker must win — settle must NOT resolve early off the bounced tick's promise.
  const marker = Symbol("not-settled");
  const settledFlag = { done: false };
  const settlePromise = service.whenComponentSyncSettled().then(() => {
    settledFlag.done = true;
  });
  const raced = await Promise.race([
    settlePromise.then(() => "settled" as const),
    Promise.resolve(marker),
  ]);
  assert.equal(
    raced,
    marker,
    "whenComponentSyncSettled resolved before the held-open send completed"
  );
  assert.equal(
    settledFlag.done,
    false,
    "settle must still be pending while the real send is in flight"
  );

  // Resolve the held send; now settle completes and exactly ONE send ran (the
  // bounced tick never launched a second concurrent run).
  held.resolve(sendResultFor(true));
  await settlePromise;
  await flush();
  assert.equal(
    settledFlag.done,
    true,
    "settle resolves once the real send lands"
  );
  assert.equal(
    sends.length,
    1,
    "the bounced tick did not launch a second concurrent send"
  );
  service.stop();
});
