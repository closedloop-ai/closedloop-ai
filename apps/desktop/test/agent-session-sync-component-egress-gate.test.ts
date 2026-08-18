/**
 * @file agent-session-sync-component-egress-gate.test.ts
 * @description ISS-4623 (shafty023 review): the component-inventory sync lane
 * (`syncComponentsOnce` → `runComponentSync`) must re-check the LIVE egress gate
 * and compute target IMMEDIATELY before every POST — the normal batch send AND
 * the dead-letter recovery send — not only after it.
 *
 * BUG: the lane sampled the gate + target once at entry, then awaited
 * `listComponentCursorRows` / `loadComponentRows` (DB reads) before sending, with
 * the freshness guard (`isCurrentComponentState`) only re-read AFTER the send (to
 * gate the cursor advance). The guard also only folded in generation + `started`,
 * not the org-policy egress gate or the compute target. So a policy true→false
 * close, or an account/target switch, landing during those reads would still POST
 * the batch under a just-closed gate or the previous target.
 *
 * FIX: `isCurrentComponentState` now ANDs the live `isCloudSyncTierAllowed` (which
 * folds in the org-policy gate) and an unchanged `getSyncComputeTargetId`, and the
 * lane re-checks it right BEFORE both sends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentComponentCursorRow } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  flush,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const COMPUTE_TARGET = "target-egress-gate";

function oneRow(): {
  rows: AgentComponentCursorRow[];
  rowsById: Map<string, AgentComponentCursorRow>;
} {
  const rows: AgentComponentCursorRow[] = [
    { id: "a", last_seen_at: "2026-07-20T10:00:00.000Z" },
  ];
  return { rows, rowsById: new Map(rows.map((r) => [r.id, r])) };
}

test("component egress gate: an org-policy close during the row load aborts the send BEFORE it POSTs", async () => {
  gatewayLog.clear();
  const { rows, rowsById } = oneRow();

  let tierAllowed = true;
  let sendCount = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    // The org-policy gate is ANDed into this in app.ts; flip it closed mid-drain.
    isCloudSyncTierAllowed: () => tierAllowed,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) => {
      const after = rows.filter(
        (r) =>
          (r.last_seen_at ?? "") > sinceTs ||
          ((r.last_seen_at ?? "") === sinceTs && r.id > sinceId)
      );
      return Promise.resolve(after);
    },
    loadComponentRows: (ids) => {
      // The gate closes (policy true→false) while the row load is in flight.
      tierAllowed = false;
      return Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      );
    },
    sendComponents: () => {
      sendCount += 1;
      return Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  await service.whenComponentSyncSettled();
  await flush();
  service.stop();

  assert.equal(
    sendCount,
    0,
    "the batch must not POST once the egress gate closed during the load"
  );
});

test("component egress gate: a compute-target switch during the row load aborts the send BEFORE it POSTs", async () => {
  gatewayLog.clear();
  const { rows, rowsById } = oneRow();

  let target: string | null = COMPUTE_TARGET;
  let sendCount = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => target,
    isCloudSyncTierAllowed: () => true,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) => {
      const after = rows.filter(
        (r) =>
          (r.last_seen_at ?? "") > sinceTs ||
          ((r.last_seen_at ?? "") === sinceTs && r.id > sinceId)
      );
      return Promise.resolve(after);
    },
    loadComponentRows: (ids) => {
      // The online target reconnects to a NEW id mid-drain (account switch).
      target = "target-egress-gate-2";
      return Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      );
    },
    sendComponents: () => {
      sendCount += 1;
      return Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  await service.whenComponentSyncSettled();
  await flush();
  service.stop();

  assert.equal(
    sendCount,
    0,
    "the batch must not POST once the compute target switched during the load"
  );
});

test("component egress gate: a permitted, same-target drain still POSTs (no false abort)", async () => {
  gatewayLog.clear();
  const { rows, rowsById } = oneRow();

  let sendCount = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    isCloudSyncTierAllowed: () => true,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) => {
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
      sendCount += 1;
      return Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  await service.whenComponentSyncSettled();
  await flush();
  service.stop();

  assert.equal(sendCount, 1, "a permitted drain sends exactly once");
});
