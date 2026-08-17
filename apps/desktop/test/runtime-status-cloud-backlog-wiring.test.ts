/**
 * @file runtime-status-cloud-backlog-wiring.test.ts
 * @description ISS-5768 — the wiring, not the unit.
 *
 * The pure derivation (`resolveCloudSyncBacklog`) and the renderer projection
 * (`parseCloudSyncBacklog`) are covered elsewhere, but both can stay green while
 * the main process never actually PUTS the whole-app backlog on the wire — in
 * which case the renderer resolves `unknown` forever and the History Sync cell
 * says "Checking…" permanently instead of telling the truth.
 *
 * So this drives the REAL `GetRuntimeStatus` handler with a deps object whose
 * `getCloudReadReadiness` reports the machine from the ISS-5768 report, and
 * asserts the emitted payload carries it under the exact key the renderer reads.
 * Deleting the payload line fails this test.
 *
 * `node:test` rather than vitest because the handler is main-process code.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthorizedCommandKeyStore } from "../src/main/command-signing/authorized-command-key-store.js";
import {
  RuntimeInfoIpcChannel,
  type RuntimeInfoIpcDeps,
  registerRuntimeInfoIpcHandlers,
} from "../src/main/ipc/runtime-info-ipc.js";
import { AgentMonitorRuntimeStatusKind } from "../src/shared/agent-monitor-status.js";
import {
  type CloudReadReadinessSnapshot,
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
} from "../src/shared/cloud-read-readiness-contract.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { ConnectionSecurityMode } from "../src/shared/connection-security.js";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../src/shared/transcript-sync-status-contract.js";

const TRUSTED_EVENT = { sender: {} };

/**
 * Mike's machine, 2026-08-10: the session lanes drained (`caughtUp === true`)
 * while the component inventory still owed 2,985 rows and the invocation-parts
 * lane had abandoned one item.
 */
const REPORTED_MACHINE: CloudReadReadinessSnapshot = {
  sampledAtIso: "2026-08-10T12:00:00.000Z",
  importComplete: true,
  lanes: [
    {
      lane: SyncLaneId.SessionMetadata,
      state: SyncLaneDrainState.Drained,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    },
    {
      lane: SyncLaneId.InvocationParts,
      state: SyncLaneDrainState.DrainedWithDeadLetters,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 1,
      unmeasuredRows: 0,
    },
    {
      lane: SyncLaneId.ComponentInventory,
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 2985,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      unmeasuredRows: 0,
    },
  ],
};

function buildRuntimeStatus(readiness: CloudReadReadinessSnapshot): unknown {
  const handlers = new Map<
    string,
    (event: unknown, payload?: unknown) => unknown
  >();
  const deps: RuntimeInfoIpcDeps = {
    isTrustedSender: () => true,
    getAppVersion: () => "0.0.0-test",
    getIsPackaged: () => true,
    settingsStore: {
      getAllFlags: () => ({}),
      getRelayOrigin: () => "",
      getApiOrigin: () => "",
      getSandboxBaseDirectory: () => "",
      getCommandSigningEnforcementEnabled: () => false,
    } as RuntimeInfoIpcDeps["settingsStore"],
    authorizedCommandKeys: new AuthorizedCommandKeyStore({
      filePath: path.join(os.tmpdir(), "iss5768-no-such-keys.json"),
    }),
    getTranscriptSyncStatus: () =>
      Promise.resolve({
        enabled: false,
        online: false,
        tierGate: TranscriptEgressGate.Denied,
        storeReady: false,
        statusCounts: emptyTranscriptStatusCounts(),
      }),
    getActivePort: () => 0,
    getCloudStatus: () => ({ state: CloudSocketState.Idle }),
    getCloudCommandsPaused: () => false,
    getCloudConnectionEnabled: () => false,
    getConnectionSecurityStatus: () => ({
      mode: ConnectionSecurityMode.Standard,
      detail: "",
    }),
    getServerCommandSigningSupported: () => false,
    isServerAlive: () => false,
    getGatewayHealthy: () => true,
    getIngestProgress: () => null,
    getFileAccessBlocks: () => [],
    getMaintenanceProgress: () => null,
    // The session lane's own claim, exactly as reported: caught up.
    getCloudSyncProgress: () => ({
      identified: true,
      pendingBackfillSessions: 0,
      pendingIncrementalSessions: 0,
      backfilling: false,
      caughtUp: true,
      deadLetteredSessions: 0,
      deadLetteredComponents: 0,
    }),
    getDashboardReady: () => true,
    getAgentMonitorStatus: () => ({
      kind: AgentMonitorRuntimeStatusKind.Ready,
      dbAhead: false,
      reason: null,
    }),
    getCloudReadReadiness: () => readiness,
  };

  registerRuntimeInfoIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    deps
  );
  const handler = handlers.get(RuntimeInfoIpcChannel.GetRuntimeStatus);
  if (!handler) {
    throw new Error("GetRuntimeStatus handler must be registered");
  }
  return handler(TRUSTED_EVENT);
}

/**
 * The renderer reads this key off the runtime-status payload. A non-object
 * payload yields `null` (the same degradation the renderer applies), so the
 * assertion about what the field carries stays in the test bodies below.
 */
function readReadiness(payload: unknown): CloudReadReadinessSnapshot | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return (
    (payload as { cloudReadReadiness?: CloudReadReadinessSnapshot | null })
      .cloudReadReadiness ?? null
  );
}

test("the runtime-status payload carries the whole-app backlog the renderer reads", () => {
  const payload = buildRuntimeStatus(REPORTED_MACHINE);
  assert.deepEqual(readReadiness(payload), REPORTED_MACHINE);
});

test("the emitted payload resolves to an OUTSTANDING backlog while the session lane claims caught up", () => {
  // The whole contradiction, end to end through production code: one payload
  // whose `cloudSync.caughtUp` is true and whose backlog owes 2,985 items with
  // one abandoned. The completeness claim must come from the latter.
  const payload = buildRuntimeStatus(REPORTED_MACHINE);
  const cloudSync = (payload as { cloudSync: { caughtUp: boolean } }).cloudSync;
  assert.equal(cloudSync.caughtUp, true);

  const backlog = resolveCloudSyncBacklog(readReadiness(payload));
  assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
  assert.equal(backlog.itemsRemaining, 2985);
  assert.equal(backlog.deadLetteredCount, 1);
});

test("an unsampled burn-down travels as unknown, so the renderer cannot render it as drained", () => {
  const payload = buildRuntimeStatus({
    sampledAtIso: null,
    importComplete: false,
    lanes: [],
  });
  assert.equal(
    resolveCloudSyncBacklog(readReadiness(payload)).state,
    CloudSyncBacklogState.Unknown
  );
});
