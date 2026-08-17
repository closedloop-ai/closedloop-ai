/**
 * @file agent-session-sync-component-single-flight.test.ts
 * @description Regression coverage for FEA-3448: the component-inventory sync
 * lane must single-flight.
 *
 * BUG: the lane (`syncComponentsOnce`) is launched fire-and-forget from the 5s
 * `syncOnce` tick with no re-entrancy guard of its own (only the parallel
 * SESSION lane was single-flighted via `this.syncing`). When one component
 * upload takes longer than the tick interval, the next tick starts a SECOND
 * concurrent run that reads the SAME in-memory keyset cursor, re-reads the SAME
 * batch, and re-POSTs it — duplicate uploads plus a racy cursor advance.
 *
 * FIX: a `componentSyncing` boolean set on entry and cleared in a `finally`,
 * mirroring the session lane's `this.syncing`. A tick that fires while a prior
 * run is still in flight bails before reading the cursor.
 *
 * These tests drive the private lane through the public tick surface (`start()`
 * fires the first tick, `refresh()` drives each subsequent one), mirroring
 * `agent-session-sync-component-cursor-keyset.test.ts`. A deferred
 * `sendComponents` keeps the first run in flight while later ticks fire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComponentSyncSendResult } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentComponentCursorRow } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  flush,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const COMPUTE_TARGET = "target-single-flight";

/** A promise plus its resolver, so a test can hold `sendComponents` in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("component single-flight: a tick that fires while a prior upload is in flight does not start a second concurrent run", async () => {
  gatewayLog.clear();

  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" },
    { id: "b", last_seen_at: "2026-07-20T11:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  let cursorReadCount = 0;
  let sendCount = 0;
  const sends: string[][] = [];
  // The first send is held open; later sends (if the bug were present) resolve
  // immediately so a leaked concurrent run would still be observable.
  const firstSend = deferred<ComponentSyncSendResult>();

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) => {
      cursorReadCount++;
      const after = rows.filter(
        (r) =>
          (r.last_seen_at ?? "") > sinceTs ||
          ((r.last_seen_at ?? "") === sinceTs && r.id > sinceId)
      );
      return Promise.resolve(after);
    },
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      sends.push(payload.components.map((c) => c.externalId));
      sendCount++;
      return sendCount === 1
        ? firstSend.promise
        : Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);

  // Tick 1 begins and blocks awaiting the (deferred) first send.
  service.start();
  await flush();

  assert.equal(sends.length, 1, "first tick issues exactly one send");
  assert.equal(cursorReadCount, 1, "first tick reads the cursor exactly once");

  // Two more ticks fire while the first send is still in flight. Without the
  // single-flight guard, each would re-read the cursor and re-send the same
  // batch (duplicate uploads + racy cursor advance).
  service.refresh();
  await flush();
  service.refresh();
  await flush();

  assert.equal(
    cursorReadCount,
    1,
    "ticks that fire during an in-flight run must not re-read the cursor"
  );
  assert.equal(
    sends.length,
    1,
    "ticks that fire during an in-flight run must not launch a second send"
  );

  // Let the in-flight run finish; it advances the cursor and releases the guard.
  firstSend.resolve(acceptedResult());
  await flush();

  // The guard released: a subsequent tick runs again and pages the next row.
  service.refresh();
  await flush();
  service.stop();

  assert.equal(
    cursorReadCount,
    2,
    "after the in-flight run completes, the next tick reads the cursor again (guard released)"
  );

  const flatSends = sends.flat();
  assert.deepEqual(
    flatSends,
    [...new Set(flatSends)],
    "no component id is uploaded more than once"
  );
});

test("component single-flight: stop() mid-flight clears the guard so a restart of the same instance still syncs", async () => {
  gatewayLog.clear();

  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  let cursorReadCount = 0;
  let sendCount = 0;
  // The first send is held open so `stop()` fires while the guard is still set.
  const firstSend = deferred<ComponentSyncSendResult>();

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) => {
      cursorReadCount++;
      const after = rows.filter(
        (r) =>
          (r.last_seen_at ?? "") > sinceTs ||
          ((r.last_seen_at ?? "") === sinceTs && r.id > sinceId)
      );
      return Promise.resolve(after);
    },
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: () => {
      sendCount++;
      return sendCount === 1
        ? firstSend.promise
        : Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);

  // Tick 1 begins and blocks awaiting the deferred first send (guard is set).
  service.start();
  await flush();
  assert.equal(cursorReadCount, 1, "first tick reads the cursor once");

  // Stop while the upload is still in flight — resetSourceState() must clear the
  // single-flight guard so it cannot be inherited by a later lifecycle.
  service.stop();
  // Let the orphaned in-flight send settle (its finally also clears the guard).
  firstSend.resolve(acceptedResult());
  await flush();

  // Restart the same instance: without the guard reset a stale `true` would make
  // every tick bail before reading the cursor and the lane would never sync.
  service.start();
  await flush();
  service.stop();

  assert.equal(
    cursorReadCount,
    2,
    "after stop() mid-flight, a restart still reads the cursor (guard was reset)"
  );
});
