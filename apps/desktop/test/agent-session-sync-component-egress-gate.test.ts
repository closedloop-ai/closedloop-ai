/**
 * @file agent-session-sync-component-egress-gate.test.ts
 * @description ISS-4623 (davetho review): the component-inventory sync lane
 * (`syncComponentsOnce` → `runComponentSync`) must re-check the live compute
 * target IMMEDIATELY before every POST — the normal batch send AND the
 * dead-letter recovery send — not only after it.
 *
 * Component synchronization is unconditional for an authenticated Desktop
 * target. The target check remains because a target switch during local reads
 * must never send a batch under the prior account's cursor.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
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

test("component sync continues when session metadata consent is unavailable", async () => {
  gatewayLog.clear();
  const { rows, rowsById } = oneRow();

  let tierAllowed = true;
  let sendCount = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    // `deps.isSessionMetadataSyncTierAllowed` is what app.ts wires here; flip it
    // closed mid-drain.
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
      // Session metadata consent can close while component rows load.
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
    1,
    "component inventory is delivered even when session metadata is withheld"
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

/**
 * tamsinb review on #7707: the case above starts with the tier ALLOWED and only
 * closes it inside `loadComponentRows`, so the service's poll is already armed
 * before consent matters and reverting `refresh()`'s
 * `shouldRun() || isHttpReady()` back to `!this.shouldRun()` leaves it green.
 * THIS is the case the change owes: a Desktop that boots with session-metadata
 * consent already off, for the whole run. It sends 1 with the change and 0
 * without it, because a bare `shouldRun()` stops the poll before the component
 * lane ever ticks.
 */
test("component sync runs on a Desktop that boots with session-metadata consent already off", async () => {
  gatewayLog.clear();
  const { rows, rowsById } = oneRow();

  let sendCount = 0;

  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    // Consent is off from the first tick and never opens.
    isCloudSyncTierAllowed: () => false,
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

  assert.equal(
    sendCount,
    1,
    "the component lane must tick even though the session lane never can"
  );
});
