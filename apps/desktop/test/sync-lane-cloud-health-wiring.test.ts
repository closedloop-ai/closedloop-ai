/**
 * @file sync-lane-cloud-health-wiring.test.ts
 * @description ISS-6338 — the PRODUCTION half of the per-lane cloud batch
 * health coverage. `sync-lane-cloud-health.test.ts` proves the records survive
 * the contract parse and reach the relay; this file proves each lane's own
 * production code path actually produces one.
 *
 * Three lanes, three separate drives — deliberately NOT one case parameterized
 * over a list, because a list that silently lost an entry would still pass.
 *
 * Every case carries a POSITIVE CONTROL asserting that the lane's transport was
 * genuinely exercised (the send was attempted, the failure was recorded, the
 * store write happened). Without it a test that emitted nothing because the lane
 * never ran would be indistinguishable from one that emitted nothing because the
 * wiring is gone.
 */
import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterEach, test } from "vitest";
import {
  COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
  ComponentSyncSendOutcome,
} from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  componentInventoryBatchEvent,
  type SyncLaneBatchEvent,
} from "../src/main/agent-sync/sync-lane-cloud-health.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  type DesktopAppExceptionEventInput,
  type DesktopOtelRuntime,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";
import { flush, syncedFor } from "./agent-session-sync-component-test-utils.js";
import {
  fakeExecutor,
  fakeStore,
  fingerprint,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

const COMPUTE_TARGET = "target-6338";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  gatewayLog.setVerbose(false);
  gatewayLog.clear();
});

/** An OTel runtime double that records only what the sync lanes emit. */
function recordingOtelRuntime(
  onEmit: (event: SyncLaneBatchEvent) => void,
  onException: (input: DesktopAppExceptionEventInput) => void = () => undefined
): DesktopOtelRuntime {
  return {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: (input) => onException(input),
    emitSanitizedAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: (event) => onEmit(event as SyncLaneBatchEvent),
    emitImportHealthEvent: () => undefined,
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
    emitOnboardingEvent: () => undefined,
    emitOnboardingDiscardEvent: () => undefined,
    emitUpdateEvent: () => true,
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => undefined,
    exportExternalRecords: () => ({
      ok: false as const,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };
}

function laneEventsFor(
  events: SyncLaneBatchEvent[],
  lane: string
): SyncLaneBatchEvent[] {
  return events.filter((event) => event.lane === lane);
}

test("lane 3 (component inventory) emits a dead-lettered batch event with the abandoned count", async () => {
  const events: SyncLaneBatchEvent[] = [];
  const rows: AgentComponentCursorRow[] = [
    { id: "poison", last_seen_at: "2026-08-01T10:00:00.000Z" },
  ];
  let sendAttempts = 0;
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId) =>
      Promise.resolve(
        sinceTs === "" && sinceId === "" ? rows.slice(0, 1) : rows.slice(0, 1)
      ),
    loadComponentRows: (ids) =>
      Promise.resolve(ids.map((id) => syncedFor(id, rows[0].last_seen_at))),
    sendComponents: () => {
      sendAttempts++;
      // A PERMANENT per-batch rejection is the only outcome that charges the
      // poison budget — a `LaneFailure` deliberately never does.
      return Promise.resolve({
        outcome: ComponentSyncSendOutcome.BatchRejected,
        firstUnsentChunkIndex: 0,
        chunkCount: 1,
        reason: SyncReason.ValidationFailed,
      });
    },
    onComponentSyncBatchTelemetry: (event) => {
      events.push(event);
    },
  };
  const service = new AgentSessionSyncService(options);
  service.start();
  await service.whenComponentSyncSettled();
  await flush();
  for (
    let tick = 1;
    tick < COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD + 2;
    tick++
  ) {
    service.refresh();
    await service.whenComponentSyncSettled();
    await flush();
  }
  const laneEvents = laneEventsFor(events, SyncLane.ComponentInventory);
  service.stop();

  // POSITIVE CONTROL: the lane genuinely tried to upload. Without this a broken
  // gate that never called `sendComponents` would look identical to a lane that
  // ran and emitted nothing.
  assert.ok(
    sendAttempts >= COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD,
    `expected the component lane to attempt at least ${COMPONENT_DEAD_LETTER_FAILURE_THRESHOLD} sends, got ${sendAttempts}`
  );
  const deadLetterEvents = laneEvents.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
  );
  assert.ok(
    deadLetterEvents.length > 0,
    "expected at least one dead_letter batch event from the component lane"
  );
  assert.equal(deadLetterEvents[0].reason, SyncReason.ValidationFailed);
  // The threshold breach carries the count as a structured number.
  assert.ok(
    (deadLetterEvents[0].deadLetteredCount ?? 0) > 0,
    "expected the dead-letter event to carry a non-zero abandoned count"
  );
  // And the ordinary pre-threshold failures did NOT carry one.
  const plainFailures = laneEvents.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.Failure
  );
  assert.ok(plainFailures.length > 0, "expected pre-threshold failure events");
  assert.ok(
    plainFailures.every((event) => event.deadLetteredCount === undefined)
  );
});

test("lane 2 (invocation parts) emits through the composed sendPart closure", async () => {
  const { createDesktopSyncLanes } = await import(
    "../src/main/agent-sync/desktop-sync-lane-composition.js"
  );
  const { FakeSource, part } = await import(
    "./helpers/invocation-sync-service-fixtures.js"
  );
  const events: SyncLaneBatchEvent[] = [];
  const invocationSource = new FakeSource(part());
  let postAttempts = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    postAttempts++;
    // A 409 the server answered: a permanent per-part conflict, so the lane's
    // own vocabulary (not a transport class) must reach the wire.
    return Promise.resolve(
      Response.json({
        success: true,
        data: {
          accepted: false,
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalGenerationId: "a".repeat(64),
          partIndex: 0,
          partHash: "c".repeat(64),
          reason: AgentComponentInvocationSyncRejectReason.PartConflict,
        },
      })
    );
  }) as typeof fetch;

  // Only the invocation members `resolveAgentComponentInvocationSyncSource`
  // probes; the arities are spelled out rather than spread, because the fake's
  // are narrower than the source contract's and a spread would forward extras.
  const syncSource: AgentSessionSyncSource = {
    // The session-lane members are required by the contract but unreachable in
    // this drive: only `agentComponentInvocationSync` is ticked.
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    prepareInvocationSyncTarget: () =>
      invocationSource.prepareInvocationSyncTarget(),
    loadReadyInvocationSyncParts: (sourceKey, now) =>
      invocationSource.loadReadyInvocationSyncParts(sourceKey, now),
    recoverInvocationSyncDeadLetters: () =>
      Promise.resolve({
        recoveredParts: 0,
        cappedParts: 0,
        quarantinedParts: 0,
      }),
    recordInvocationSyncRetry: (sourceKey, pending, retry) =>
      invocationSource.recordInvocationSyncRetry(sourceKey, pending, retry),
    clearAcknowledgedInvocationSyncPart: (sourceKey, ack) =>
      invocationSource.clearAcknowledgedInvocationSyncPart(sourceKey, ack),
    deadLetterInvocationSyncPart: (sourceKey, pending, deadLetter) =>
      invocationSource.deadLetterInvocationSyncPart(
        sourceKey,
        pending,
        deadLetter
      ),
  };

  const lanes = createDesktopSyncLanes({
    desktopSessionManager: SYNC_LANE_SESSION_MANAGER,
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => COMPUTE_TARGET,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => syncSource,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: recordingOtelRuntime((event) => events.push(event)),
    isTranscriptSyncRunning: () => false,
  });

  await lanes.agentComponentInvocationSync.syncOnce();

  // POSITIVE CONTROL: the lane actually reached the network.
  assert.ok(postAttempts > 0, "expected the invocation lane to POST a part");
  const laneEvents = laneEventsFor(events, SyncLane.InvocationParts);
  assert.equal(laneEvents.length, 1);
  assert.equal(laneEvents[0].outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(laneEvents[0].reason, SyncReason.PartConflict);
});

test("ISS-7980: a genuine invocation prepare failure warns, emits a main exception, and reschedules", async () => {
  const failure = new Error("promotion transaction rejected");
  const failingSource = invocationPrepareFailureSource(failure);
  const exceptions: DesktopAppExceptionEventInput[] = [];
  const lanes = await composeInvocationFailureLane(
    failingSource.source,
    recordingOtelRuntime(
      () => undefined,
      (event) => exceptions.push(event)
    )
  );

  gatewayLog.clear();
  lanes.agentComponentInvocationSync.start();
  try {
    await flush();

    assert.equal(failingSource.prepareAttempts(), 1);
    assert.ok(
      gatewayLog
        .getEntries()
        .some(
          (entry) =>
            entry.level === "warn" &&
            entry.tag === "component-invocation-sync" &&
            entry.message === "sync failed: promotion transaction rejected"
        ),
      "the composed lane must preserve the existing local sync-failure warning"
    );
    assert.deepEqual(exceptions, [
      { error: failure, origin: AppExceptionOrigin.Main },
    ]);

    lanes.agentComponentInvocationSync.refresh();
    await flush();
    assert.equal(
      failingSource.prepareAttempts(),
      2,
      "the observed failure must not leave the invocation lane single-flight latched"
    );
    assert.deepEqual(exceptions, [
      { error: failure, origin: AppExceptionOrigin.Main },
      { error: failure, origin: AppExceptionOrigin.Main },
    ]);
  } finally {
    lanes.agentComponentInvocationSync.stop();
  }
});

test("ISS-7980: graceful db-host shutdown stays debug-only and still reschedules", async () => {
  const shutdown = new DbHostShutdownError(
    DbHostShutdownReason.Exited,
    "db-host exited (code: 0)"
  );
  const failingSource = invocationPrepareFailureSource(shutdown);
  const exceptions: DesktopAppExceptionEventInput[] = [];
  const lanes = await composeInvocationFailureLane(
    failingSource.source,
    recordingOtelRuntime(
      () => undefined,
      (event) => exceptions.push(event)
    )
  );

  gatewayLog.setVerbose(true);
  gatewayLog.clear();
  lanes.agentComponentInvocationSync.start();
  try {
    await flush();

    assert.equal(failingSource.prepareAttempts(), 1);
    const componentLines = gatewayLog
      .getEntries()
      .filter((entry) => entry.tag === "component-invocation-sync");
    assert.ok(
      componentLines.some(
        (entry) =>
          entry.level === "info" &&
          entry.message ===
            "sync abandoned: db-host shutting down (retries on next launch)"
      ),
      "recognized shutdown must retain the verbose abandonment diagnostic"
    );
    assert.equal(
      componentLines.some((entry) => entry.level === "warn"),
      false,
      "an intentional shutdown must not be called a sync failure"
    );
    assert.deepEqual(
      exceptions,
      [],
      "an intentional shutdown must not enter monitored exception telemetry"
    );

    lanes.agentComponentInvocationSync.refresh();
    await flush();
    assert.equal(failingSource.prepareAttempts(), 2);
    assert.deepEqual(exceptions, []);
  } finally {
    lanes.agentComponentInvocationSync.stop();
  }
});

test("lane 4 (transcript archive) emits success, retryable failure, and abandonment", async () => {
  // Driven through the real `TranscriptSyncService`, not the drain queue alone,
  // so the options→queue hop the production factory configures is covered too.
  const successEvents: SyncLaneBatchEvent[] = [];
  let successSyncCalls = 0;
  const success = makeService({
    store: fakeStore([fingerprint({ retryCount: 0 })]),
    executor: fakeExecutor({
      syncFile: () => {
        successSyncCalls++;
        return Promise.resolve({ kind: "uploaded", caughtUp: true });
      },
    }),
    emitSyncBatch: (event) => successEvents.push(event),
  });
  await success.service.drainOnce();
  // POSITIVE CONTROL: the drain really claimed and attempted the row.
  assert.equal(successSyncCalls, 1);
  assert.deepEqual(laneEventsFor(successEvents, SyncLane.TranscriptArchive), [
    {
      lane: SyncLane.TranscriptArchive,
      outcome: DesktopSyncBatchOutcome.Success,
    },
  ]);

  // A row well short of the ceiling: a throw here is retryable, not abandonment.
  const retryEvents: SyncLaneBatchEvent[] = [];
  const retry = makeService({
    store: fakeStore([fingerprint({ retryCount: 0 })]),
    executor: fakeExecutor({
      syncFile: () => {
        throw new Error("upload failed");
      },
    }),
    emitSyncBatch: (event) => retryEvents.push(event),
  });
  await retry.service.drainOnce();
  // POSITIVE CONTROL: the failure really landed on the ledger.
  assert.equal(retry.store?.failures.length, 1);
  assert.equal(retry.store?.failures[0].dead, false);
  const retryLaneEvents = laneEventsFor(
    retryEvents,
    SyncLane.TranscriptArchive
  );
  assert.equal(retryLaneEvents.length, 1);
  assert.equal(retryLaneEvents[0].outcome, DesktopSyncBatchOutcome.Failure);

  // A row AT the ceiling whose terminal skip the cloud acknowledged: abandoned.
  const deadEvents: SyncLaneBatchEvent[] = [];
  const dead = makeService({
    store: fakeStore([fingerprint({ retryCount: 4 })]),
    executor: fakeExecutor({
      syncFile: () => {
        throw new Error("still failing");
      },
      skipAck: true,
    }),
    emitSyncBatch: (event) => deadEvents.push(event),
  });
  await dead.service.drainOnce();
  // POSITIVE CONTROL: the ledger really recorded the abandonment.
  assert.equal(dead.store?.failures[0].dead, true);
  const deadLaneEvents = laneEventsFor(deadEvents, SyncLane.TranscriptArchive);
  assert.equal(deadLaneEvents.length, 1);
  assert.equal(deadLaneEvents[0].outcome, DesktopSyncBatchOutcome.DeadLetter);
});

test("lane 4 (transcript archive) does not report noop or transient skip attempts as healthy", async () => {
  const cases = [
    {
      label: "noop",
      result: { kind: "noop" as const },
    },
    {
      label: "transient skip",
      result: {
        kind: "skipped" as const,
        reason: "no complete line",
      },
    },
  ];

  for (const { label, result } of cases) {
    const events: SyncLaneBatchEvent[] = [];
    let syncCalls = 0;
    const lane = makeService({
      store: fakeStore([fingerprint({ retryCount: 0 })]),
      executor: fakeExecutor({
        syncFile: () => {
          syncCalls += 1;
          return Promise.resolve(result);
        },
      }),
      emitSyncBatch: (event) => events.push(event),
    });

    await lane.service.drainOnce();

    assert.equal(syncCalls, 1, `${label}: the archive attempt must run`);
    assert.deepEqual(
      laneEventsFor(events, SyncLane.TranscriptArchive),
      [],
      `${label}: transferring no bytes must not credit archive-lane health`
    );
  }
});

test("lane 3's events are NOT re-tagged as lane 1, and never credit the session burn-down", async () => {
  // The regression this exists for: `AgentComponentSyncLane` is constructed with
  // the SAME options object as the session lane, so a shared telemetry callback
  // would stamp `session_metadata` over the component lane's own tag AND tee its
  // batches into `recordSessionBatch`. Two separate seams make both impossible —
  // driven here through the real composition, the only place either could happen.
  const events: SyncLaneBatchEvent[] = [];
  const sessionBatches: { accepted: boolean; payloadBytes: number }[] = [];
  const { createDesktopSyncLanes } = await import(
    "../src/main/agent-sync/desktop-sync-lane-composition.js"
  );
  const lanes = createDesktopSyncLanes({
    desktopSessionManager: SYNC_LANE_SESSION_MANAGER,
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => COMPUTE_TARGET,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => null,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: recordingOtelRuntime((event) => events.push(event)),
    isTranscriptSyncRunning: () => false,
  });
  const reporter = lanes.syncBurndownReporter;
  const realRecord = reporter.recordSessionBatch.bind(reporter);
  reporter.recordSessionBatch = (input) => {
    sessionBatches.push(input);
    realRecord(input);
  };
  const seams = lanes.agentSessionSync as unknown as {
    options: Pick<
      AgentSessionSyncServiceOptions,
      "onComponentSyncBatchTelemetry" | "onSyncBatchTelemetry"
    >;
  };

  seams.options.onComponentSyncBatchTelemetry?.(
    componentInventoryBatchEvent({
      rejectedReason: SyncReason.ValidationFailed,
      deadLettered: true,
      deadLetteredCount: 3,
    })
  );
  assert.equal(events.length, 1);
  assert.equal(
    events[0].lane,
    SyncLane.ComponentInventory,
    "the component lane's tag must survive the composition"
  );
  assert.equal(events[0].deadLetteredCount, 3);
  assert.deepEqual(
    sessionBatches,
    [],
    "a component-lane batch must never be counted as session-lane work"
  );

  // POSITIVE CONTROL: the session seam still tags lane 1 and still tees.
  // ISS-7401: carries a real `durablyClearedRows` so the tee's forwarding of it
  // is pinned here. This is the ONLY case that drives the actual composition —
  // the reporter suites call `recordSessionBatch` directly — so without a
  // non-zero count, deleting that line from the tee would leave every session
  // stall reporting `queueRowsClearedSincePrevious: 0` with nothing objecting.
  seams.options.onSyncBatchTelemetry?.({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 42,
    durablyClearedRows: 3,
  });
  assert.equal(events.length, 2);
  assert.equal(events[1].lane, SyncLane.SessionMetadata);
  assert.deepEqual(sessionBatches, [
    { accepted: true, payloadBytes: 42, durablyClearedRows: 3 },
  ]);
});

/**
 * ISS-11426 (whitlockk) — the SESSION lane's tee. Its 403 has been coded apart since
 * FEA-3425, and it is the lane a device with no invocation backlog is refused
 * on, so without this the machine in exactly the stuck state this ticket is
 * about gets no alert and no action. Driven through the real composition seam,
 * the only place the tee exists.
 */
test("ISS-11426: a session-metadata ownership refusal reaches the link-block latch", async () => {
  const events: SyncLaneBatchEvent[] = [];
  const { createDesktopSyncLanes } = await import(
    "../src/main/agent-sync/desktop-sync-lane-composition.js"
  );
  const { createComputeTargetLinkBlockTracker } = await import(
    "../src/main/agent-sync/compute-target-link-block.js"
  );
  const computeTargetLinkBlock = createComputeTargetLinkBlockTracker();
  const lanes = createDesktopSyncLanes({
    desktopSessionManager: SYNC_LANE_SESSION_MANAGER,
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => COMPUTE_TARGET,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => null,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: recordingOtelRuntime((event) => events.push(event)),
    isTranscriptSyncRunning: () => false,
    computeTargetLinkBlock,
  });
  const seams = lanes.agentSessionSync as unknown as {
    options: Pick<AgentSessionSyncServiceOptions, "onSyncBatchTelemetry">;
  };

  seams.options.onSyncBatchTelemetry?.({
    outcome: DesktopSyncBatchOutcome.Failure,
    reason: SyncReason.TargetNotOwned,
    payloadBytes: 42,
  });

  // POSITIVE CONTROL: the seam ran and still tags lane 1, so a null block below
  // would mean the tee is missing rather than that nothing was emitted.
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, SyncLane.SessionMetadata);
  assert.equal(
    computeTargetLinkBlock.read()?.refusedComputeTargetId,
    COMPUTE_TARGET
  );

  // And an accepted session batch clears it — the same seam, the other
  // direction, so a relinked user stops being told they have not.
  seams.options.onSyncBatchTelemetry?.({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 42,
  });
  assert.equal(computeTargetLinkBlock.read(), null);
});

/**
 * The two composition pass-throughs the behavioral cases above cannot reach:
 * the lane-4 transcript factory hands its lane the emitter it reads off the
 * dashboard runtime, and the runtime bootstrap is where that emitter is
 * assigned. Both construct real HTTP clients, so driving them end to end would
 * test the network rather than the wiring.
 *
 * Pinned on the resolved AST rather than a raw text scan (the repo's
 * `no-raw-text-source-scan` gate), so a reformat cannot break it and a comment
 * mentioning `emitSyncBatch` cannot satisfy it: the assertion is that a property
 * ASSIGNMENT with that name exists in each module.
 */
const COMPOSITION_MODULES = [
  "src/main/transcript-sync/desktop-transcript-sync-factory.ts",
  "src/main/dashboard/agent-dashboard-runtime-bootstrap.ts",
];

test("each lane composition root still hands its lane the batch emitter", async () => {
  const { fileURLToPath } = await import("node:url");
  const nodePath = await import("node:path");
  const ts = (await import("typescript6")).default;
  const { forEachNode, parseTypeScriptFile } = await import(
    "./helpers/ts-ast.js"
  );
  const testDir = nodePath.dirname(fileURLToPath(import.meta.url));
  for (const relative of COMPOSITION_MODULES) {
    let assigned = false;
    forEachNode(
      parseTypeScriptFile(nodePath.join(testDir, "..", relative)),
      (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "emitSyncBatch"
        ) {
          assigned = true;
        }
      }
    );
    assert.ok(
      assigned,
      `${relative} no longer assigns emitSyncBatch; its lane would report no cloud batch health at all`
    );
  }
});

/** Signed out, so the identity-gated outbox adoption no-ops in these tests. */
const SYNC_LANE_SESSION_MANAGER = {
  getAccessToken: () => Promise.resolve("token"),
  getAccountAdmission: () => null,
  getIdentity: () => null,
  invalidateAccessToken: () => undefined,
};

function invocationPrepareFailureSource(error: Error): {
  source: AgentSessionSyncSource;
  prepareAttempts: () => number;
} {
  let prepareAttempts = 0;
  const source: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    prepareInvocationSyncTarget: () => {
      prepareAttempts += 1;
      return Promise.reject(error);
    },
    loadReadyInvocationSyncParts: () => Promise.resolve([]),
    recoverInvocationSyncDeadLetters: () =>
      Promise.resolve({
        recoveredParts: 0,
        cappedParts: 0,
        quarantinedParts: 0,
      }),
    recordInvocationSyncRetry: () => Promise.resolve(),
    clearAcknowledgedInvocationSyncPart: () => Promise.resolve(false),
    deadLetterInvocationSyncPart: () => Promise.resolve(false),
  };
  return { source, prepareAttempts: () => prepareAttempts };
}

async function composeInvocationFailureLane(
  syncSource: AgentSessionSyncSource,
  appOtelRuntime: DesktopOtelRuntime
) {
  const { createDesktopSyncLanes } = await import(
    "../src/main/agent-sync/desktop-sync-lane-composition.js"
  );
  return createDesktopSyncLanes({
    desktopSessionManager: SYNC_LANE_SESSION_MANAGER,
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => COMPUTE_TARGET,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => syncSource,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime,
    isTranscriptSyncRunning: () => false,
  });
}

/**
 * ISS-11426 — the PRODUCER tee, which the latch's own suite and the
 * runtime-status payload test both stay green without. Deleting
 * `computeTargetLinkBlock.observe(...)` from the composed `sendPart` closure
 * leaves the block null forever, so the Settings alert never renders and the
 * user is never offered the relink — the whole defect, invisible to every other
 * suite. This drives the real closure against a real coded 403.
 */
test("ISS-11426: a coded ownership 403 reaches the link-block latch through the composed sendPart", async () => {
  const { createDesktopSyncLanes } = await import(
    "../src/main/agent-sync/desktop-sync-lane-composition.js"
  );
  const { createComputeTargetLinkBlockTracker } = await import(
    "../src/main/agent-sync/compute-target-link-block.js"
  );
  const { DesktopAgentComponentInvocationSyncRestErrorCode } = await import(
    "@repo/api/src/types/desktop-write-lane"
  );
  const { FakeSource, part } = await import(
    "./helpers/invocation-sync-service-fixtures.js"
  );
  const invocationSource = new FakeSource(part());
  let postAttempts = 0;
  globalThis.fetch = (() => {
    postAttempts++;
    return Promise.resolve(
      Response.json(
        {
          success: false,
          error: "Forbidden",
          code: DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned,
        },
        { status: 403 }
      )
    );
  }) as typeof fetch;
  const computeTargetLinkBlock = createComputeTargetLinkBlockTracker();
  const syncSource: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    prepareInvocationSyncTarget: () =>
      invocationSource.prepareInvocationSyncTarget(),
    loadReadyInvocationSyncParts: (sourceKey, now) =>
      invocationSource.loadReadyInvocationSyncParts(sourceKey, now),
    recoverInvocationSyncDeadLetters: () =>
      Promise.resolve({
        recoveredParts: 0,
        cappedParts: 0,
        quarantinedParts: 0,
      }),
    recordInvocationSyncRetry: (sourceKey, pending, retry) =>
      invocationSource.recordInvocationSyncRetry(sourceKey, pending, retry),
    clearAcknowledgedInvocationSyncPart: (sourceKey, ack) =>
      invocationSource.clearAcknowledgedInvocationSyncPart(sourceKey, ack),
    deadLetterInvocationSyncPart: (sourceKey, pending, deadLetter) =>
      invocationSource.deadLetterInvocationSyncPart(
        sourceKey,
        pending,
        deadLetter
      ),
  };

  const lanes = createDesktopSyncLanes({
    desktopSessionManager: SYNC_LANE_SESSION_MANAGER,
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => COMPUTE_TARGET,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getComputeTargetRefusal: () => null,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => syncSource,
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: recordingOtelRuntime(() => undefined),
    isTranscriptSyncRunning: () => false,
    computeTargetLinkBlock,
  });

  await lanes.agentComponentInvocationSync.syncOnce();

  // POSITIVE CONTROL: the lane actually reached the network, so a zero below
  // would mean the tee is missing rather than that nothing was sent.
  assert.ok(postAttempts > 0, "expected the invocation lane to POST a part");
  assert.equal(
    computeTargetLinkBlock.read()?.refusedComputeTargetId,
    COMPUTE_TARGET
  );
  // The SAME composition returns the tracker it fed, so the accessor the
  // application exposes to the runtime-status poll cannot be a second instance.
  assert.equal(lanes.computeTargetLinkBlock, computeTargetLinkBlock);
});
