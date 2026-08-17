/**
 * @file agent-session-sync-component-diag.test.ts
 * @description Instrumentation coverage for the component-inventory sync lane's
 * transition-based diagnostics in {@link AgentSessionSyncService}
 * (`noteComponentSyncDiag` → `componentSyncDiag.note`). Mirrors the client-side
 * instrumentation tests in `desktop-component-sync-wiring.test.ts`: it asserts
 * each pre-send skip / failure branch names itself, that the transition logger
 * logs a stuck outcome exactly once (no per-tick spam), and that it re-logs
 * after a recovery.
 *
 * The lane is private (`syncComponentsOnce`), so — like the Gap B wiring test —
 * these drive it through the service's public tick: `start()` runs the first
 * tick, and `refresh()` drives each subsequent one. Between ticks we flush
 * microtasks so the async component lane settles before the next tick.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentComponentCursorRow } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  batchRejectedResult,
} from "./agent-session-sync-component-test-utils.js";

const TAG = "agent-session-sync";
const NOW = "2026-07-11T00:00:00.000Z";
const COMPUTE_TARGET = "target-diag";

function laneLogMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((e) => e.tag === TAG && e.message.includes("component sync lane"))
    .map((e) => e.message);
}

const CURSOR_ROW: AgentComponentCursorRow = {
  id: "comp-abc",
  last_seen_at: NOW,
};

const SYNCED_COMPONENT = {
  externalId: "comp-abc",
  componentKind: "mcp",
  componentKey: "myserver",
  harness: null,
  name: null,
  version: null,
  description: null,
  sourceUrl: null,
  installPath: null,
  packId: null,
  scope: null,
  projectPath: null,
  metadata: null,
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  uninstalledAt: null,
};

/**
 * Baseline options that fully wire the component lane (all three readers +
 * sender present, so `syncComponentsOnce` is NOT a no-op). Individual tests
 * override the branch they exercise.
 */
function serviceOptions(
  overrides: Partial<AgentSessionSyncServiceOptions> = {}
): AgentSessionSyncServiceOptions {
  return {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: () => Promise.resolve([CURSOR_ROW]),
    loadComponentRows: () => Promise.resolve([SYNCED_COMPONENT]),
    sendComponents: () => Promise.resolve(acceptedResult()),
    ...overrides,
  };
}

/** Flush queued microtasks/immediates so the async component lane settles. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Run the component lane `ticks` times through the public tick surface:
 * `start()` fires the first tick, then `refresh()` drives each subsequent one.
 */
async function runLane(
  service: AgentSessionSyncService,
  ticks: number
): Promise<void> {
  service.start();
  await flush();
  for (let i = 1; i < ticks; i++) {
    service.refresh();
    await flush();
  }
  service.stop();
}

test("component diag: missing compute target logs a named skip reason (no longer a silent return)", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({ getSyncComputeTargetId: () => null })
  );

  await runLane(service, 1);

  const messages = laneLogMessages();
  assert.ok(
    messages.some((m) => m.includes("no compute target")),
    `expected a 'no compute target' skip log, got: ${JSON.stringify(messages)}`
  );
});

test("component diag: empty cursor logs a named 'nothing to upload' reason", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({ listComponentCursorRows: () => Promise.resolve([]) })
  );

  await runLane(service, 1);

  const messages = laneLogMessages();
  assert.ok(
    messages.some((m) => m.includes("nothing to upload")),
    `expected a 'nothing to upload' log, got: ${JSON.stringify(messages)}`
  );
});

test("component diag: a cursor read throw is named (cursor-read-failed), not swallowed silently", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({
      listComponentCursorRows: () => Promise.reject(new Error("db is locked")),
    })
  );

  await runLane(service, 1);

  const messages = laneLogMessages();
  assert.ok(
    messages.some(
      (m) =>
        m.includes("component cursor read failed") && m.includes("db is locked")
    ),
    `expected a named cursor-read failure log, got: ${JSON.stringify(messages)}`
  );
});

test("component diag: a sendComponents throw is named (send-threw), not swallowed silently", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({
      sendComponents: () => Promise.reject(new Error("socket hang up")),
    })
  );

  await runLane(service, 1);

  const messages = laneLogMessages();
  assert.ok(
    messages.some(
      (m) => m.includes("sendComponents threw") && m.includes("socket hang up")
    ),
    `expected a named send-threw log, got: ${JSON.stringify(messages)}`
  );
});

test("component diag: a BatchRejected send is named (not-accepted) on the lane", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({
      sendComponents: () => Promise.resolve(batchRejectedResult()),
    })
  );

  await runLane(service, 1);

  const messages = laneLogMessages();
  assert.ok(
    messages.some((m) => m.includes("rejected")),
    `expected a 'not-accepted' lane log, got: ${JSON.stringify(messages)}`
  );
});

test("component diag: transition-based logging does not repeat the same stuck skip every tick", async () => {
  gatewayLog.clear();
  const service = new AgentSessionSyncService(
    serviceOptions({ getSyncComputeTargetId: () => null })
  );

  await runLane(service, 3);

  const skips = laneLogMessages().filter((m) =>
    m.includes("no compute target")
  );
  assert.equal(skips.length, 1, "same stuck reason logs once, not per-tick");
});

test("component diag: recovery re-logs — a stuck skip then a later successful send emits the sync line", async () => {
  gatewayLog.clear();
  let hasComputeTarget = false;
  const uploaded: unknown[] = [];
  const service = new AgentSessionSyncService(
    serviceOptions({
      getSyncComputeTargetId: () => (hasComputeTarget ? COMPUTE_TARGET : null),
      sendComponents: (payload) => {
        uploaded.push(payload);
        return Promise.resolve(acceptedResult());
      },
    })
  );

  // Tick 1: stuck on "no compute target".
  service.start();
  await flush();
  const stuck = laneLogMessages().filter((m) =>
    m.includes("no compute target")
  );
  assert.equal(stuck.length, 1, "stuck skip logged once");

  // Recover: compute target appears, next tick sends.
  hasComputeTarget = true;
  service.refresh();
  await flush();
  service.stop();

  assert.equal(uploaded.length, 1, "recovered tick uploaded the batch");
  const syncedLine = gatewayLog
    .getEntries()
    .filter((e) => e.tag === TAG)
    .map((e) => e.message)
    .some((m) => m.includes("synced") && m.includes("agent component"));
  assert.ok(
    syncedLine,
    "recovery emits the one-line success ('synced N agent component(s)')"
  );
});

test("component diag: syncMode on the assembled payload is Incremental", async () => {
  gatewayLog.clear();
  const uploaded: { syncMode: AgentSessionSyncMode }[] = [];
  const service = new AgentSessionSyncService(
    serviceOptions({
      sendComponents: (payload) => {
        uploaded.push(payload);
        return Promise.resolve(acceptedResult());
      },
    })
  );

  await runLane(service, 1);

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].syncMode, AgentSessionSyncMode.Incremental);
});
