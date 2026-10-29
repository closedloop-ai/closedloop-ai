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
import { test } from "vitest";
import type { ComputeTargetLinkBlockState } from "../src/main/agent-sync/compute-target-link-block.js";
import {
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
import { RuntimeInfoIpcChannel } from "../src/shared/runtime-info-ipc-channel.js";
import {
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../src/shared/transcript-sync-status-contract.js";

const TRUSTED_EVENT = { sender: {} };

/**
 * Marisol's machine, 2026-08-10: the session lanes drained (`caughtUp === true`)
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
      resumeBlocked: false,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      unmeasuredRows: 0,
    },
    {
      lane: SyncLaneId.InvocationParts,
      state: SyncLaneDrainState.DrainedWithDeadLetters,
      resumeBlocked: false,
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 1,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      unmeasuredRows: 0,
    },
    {
      lane: SyncLaneId.ComponentInventory,
      state: SyncLaneDrainState.Draining,
      resumeBlocked: false,
      itemsRemaining: 2985,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      unmeasuredRows: 0,
    },
  ],
};

function buildRuntimeStatus(
  readiness: CloudReadReadinessSnapshot,
  linkBlock: ComputeTargetLinkBlockState | null = null
): unknown {
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
    } as RuntimeInfoIpcDeps["settingsStore"],
    getTranscriptSyncStatus: () =>
      Promise.resolve({
        enabled: false,
        online: false,
        tierGate: TranscriptEgressGate.Denied,
        storeReady: false,
        computeTargetId: null,
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
      readyBackfillSessions: 0,
      readyIncrementalSessions: 0,
      deliveredSessions: 0,
      inFlightTotalSessions: 0,
      sendingSessions: 0,
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
    getComputeTargetLinkBlock: () => linkBlock,
    getNodeUuid: () => NODE_UUID,
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

test("a lane the store never READ travels with its basis, so the cell cannot say up to date", () => {
  // whitlockk (review), ISS-9807. The parser cases pin what the renderer does with
  // a basis it RECEIVES; they all stay green if the main process never puts the
  // field on the wire, and then a never-read lane's placeholder zeros re-derive
  // `drained` and the History Sync cell goes back to "Up to date". So this
  // drives the REAL GetRuntimeStatus handler and asserts both halves: the
  // emitted payload carries the basis under the exact key the renderer reads,
  // and the whole-app verdict resolved from that payload is `unknown`.
  //
  // COUNTERFACTUAL: drop `deadLetteredBasis` from the lane the reporter emits
  // (or from the payload) and the first assertion goes red on `undefined`,
  // while the second re-derives a drained lane and answers `drained`.
  const neverRead: CloudReadReadinessSnapshot = {
    sampledAtIso: "2026-08-10T12:00:00.000Z",
    importComplete: true,
    lanes: [
      {
        lane: SyncLaneId.SessionMetadata,
        // Every count below is a PLACEHOLDER, not a figure: the store
        // short-circuited before it ran a statement.
        state: SyncLaneDrainState.RemainingUnknown,
        resumeBlocked: false,
        itemsRemaining: 0,
        itemsRemainingIsLowerBound: false,
        deadLetteredCount: 0,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        unmeasuredRows: 0,
      },
    ],
  };
  const payload = buildRuntimeStatus(neverRead);

  assert.equal(
    readReadiness(payload)?.lanes[0]?.deadLetteredBasis,
    SyncLaneDeadLetteredBasis.Unmeasured,
    "the basis must reach the renderer, or its zeros read as measured"
  );
  assert.equal(
    resolveCloudSyncBacklog(readReadiness(payload)).state,
    CloudSyncBacklogState.Unknown
  );
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

/**
 * ISS-11426 — the wiring, again, for the compute-target link block. The latch
 * and the renderer projection are covered in their own suites, and both stay
 * green while the payload line is missing — in which case the user is never told
 * their machine is not linked and never offered the relink, which is the whole
 * defect. Deleting the payload line fails this test.
 */
const REFUSED_BLOCK: ComputeTargetLinkBlockState = {
  refusedComputeTargetId: "target-1",
  refusedBatchCount: 5131,
  firstRefusedAt: "2026-09-26T17:00:00.000Z",
};

function readLinkBlock(payload: unknown): ComputeTargetLinkBlockState | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return (
    (
      payload as {
        computeTargetLinkBlock?: ComputeTargetLinkBlockState | null;
      }
    ).computeTargetLinkBlock ?? null
  );
}

test("the runtime-status payload carries the compute-target link block", () => {
  assert.deepEqual(
    readLinkBlock(buildRuntimeStatus(REPORTED_MACHINE, REFUSED_BLOCK)),
    REFUSED_BLOCK
  );
});

test("an unblocked machine travels as null, never as a block with empty fields", () => {
  assert.equal(readLinkBlock(buildRuntimeStatus(REPORTED_MACHINE)), null);
});

test("the runtime-status payload carries the node_uuid the session-replay client reads (ISS-11838)", () => {
  const payload = buildRuntimeStatus(REPORTED_MACHINE);
  assert.equal((payload as { nodeUuid?: string }).nodeUuid, NODE_UUID);
});

const NODE_UUID = "2f1c8f8e-3b7a-4c1d-9e2f-5a6b7c8d9e0f";
