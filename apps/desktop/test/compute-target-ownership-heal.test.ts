/**
 * @file compute-target-ownership-heal.test.ts
 * @description ISS-11467 — the two repairs for a `target_not_owned` refusal,
 * driven through the PRODUCTION lane composition rather than against the helpers
 * in isolation.
 *
 * Repair one: a KNOWN-foreign compute target never leaves the machine, because
 * every lane now resolves its target through the identity-bound fold instead of
 * the raw strict-online read. The first case pins that as an absence of network
 * traffic, with a positive control proving the same lane DOES post when the two
 * resolvers agree — without it, a lane that posted nothing because the fixture
 * was broken would look identical to the fix working.
 *
 * Repair two: for the case the local guard deliberately cannot judge — a stale or
 * rotated id belonging to this same account, indistinguishable from a foreign one
 * with no account recorded — the coded 403 buys exactly one re-resolved retry.
 * The cases below pin all four outcomes that must stay distinguishable: healed,
 * refused again, the bound that stops a second heal, and an UNCODED 403 from a
 * server predating ISS-11426 taking exactly the path it takes today.
 */
import assert from "node:assert/strict";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  type ComputeTargetLinkBlockState,
  createComputeTargetLinkBlockTracker,
} from "../src/main/agent-sync/compute-target-link-block.js";
import {
  COMPUTE_TARGET_OWNERSHIP_HEAL_ATTEMPT,
  ComputeTargetOwnershipHealOutcome,
  createComputeTargetOwnershipHealer,
} from "../src/main/agent-sync/compute-target-ownership-heal.js";
import {
  createDesktopSyncLanes,
  identityBoundTranscriptComputeTargetId,
} from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { identityBoundComputeTargetId } from "../src/main/agent-sync/identity-bound-compute-target.js";
import { ComputeTargetRefusalReason } from "../src/main/agent-sync/retained-compute-target-identity.js";
import type { SyncLaneBatchEvent } from "../src/main/agent-sync/sync-lane-cloud-health.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  type DesktopOtelRuntime,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";
import {
  FakeSource,
  part,
} from "./helpers/invocation-sync-service-fixtures.js";

const OWNED_TARGET = "ct-owned-11467";
const FOREIGN_TARGET = "ct-other-account-11467";
const ROTATED_TARGET = "ct-rotated-11467";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("ISS-11467: a KNOWN-foreign compute target is never sent on the invocation lane", async () => {
  const drive = driveInvocationLane({
    onlineComputeTargetId: FOREIGN_TARGET,
    // The identity-bound resolver has already refused that id for the account
    // signed in now. Before this change the lane read the online id alone and
    // spent a batch — and a deferral — on a mismatch visible right here.
    syncComputeTargetId: null,
    respond: () => forbidden(),
  });
  const result = await drive.run();

  assert.equal(
    result.requestedTargets.length,
    0,
    "a target the identity-bound resolver refuses must never reach the network"
  );
  assert.equal(
    result.linkBlock?.refusedComputeTargetId,
    FOREIGN_TARGET,
    "no batch was spent, but the relink ISS-11426 shipped must still be offered: the local owner check latches the same condition the server 403 used to"
  );
  assert.equal(
    result.linkBlock?.refusedBatchCount,
    1,
    "a readiness read is not a batch, so the user-visible count must not pace off the tick"
  );
});

test("ISS-11467: a transient ISS-8702 origin mismatch must NOT raise the relink — it clears itself and relinking would do nothing", async () => {
  const drive = driveInvocationLane({
    onlineComputeTargetId: FOREIGN_TARGET,
    syncComputeTargetId: null,
    computeTargetRefusal: ComputeTargetRefusalReason.MintedElsewhere,
    respond: () => forbidden(),
  });
  const result = await drive.run();

  assert.equal(result.requestedTargets.length, 0);
  assert.equal(
    result.linkBlock,
    null,
    "a prompt for a condition that resolves on the next reconnect is a false alert"
  );
});

/**
 * COVERAGE BOUNDARY, stated because the name used to claim more than it pins. The
 * invocation lane is driven end to end above. The component-inventory, routine and
 * trace-comment clients read the same `laneComputeTargetId` closure and the
 * transcript lane reads the same fold through `app.ts`, but none of those four has a
 * public entry point this composition returns, so their wiring is covered by this
 * fold plus typecheck rather than by a drive. Do not read this case as lane coverage.
 */
test("ISS-11467: the shared fold every lane resolves through declines a known-foreign id", () => {
  const deps = fakeDesktopSyncLaneDeps({
    getTranscriptComputeTargetId: () => FOREIGN_TARGET,
    getSyncComputeTargetId: () => null,
    getComputeTargetRefusal: () => ComputeTargetRefusalReason.ForeignAccount,
  });

  assert.equal(
    identityBoundTranscriptComputeTargetId(deps),
    null,
    "every lane that resolves through this fold — invocation parts, component inventory, routines, transcript archive — declines the foreign id"
  );
});

test("ISS-11467 positive control: the same lane DOES post when the two resolvers agree", async () => {
  const drive = driveInvocationLane({
    onlineComputeTargetId: OWNED_TARGET,
    syncComputeTargetId: OWNED_TARGET,
    respond: () => accepted(),
  });
  const result = await drive.run();

  assert.deepEqual(result.requestedTargets, [OWNED_TARGET]);
});

test("ISS-11467: a stale same-account id heals on exactly one re-resolved retry, with nothing user-visible", async () => {
  let resolved = OWNED_TARGET;
  let posts = 0;
  const drive = driveInvocationLane({
    onlineComputeTargetId: () => resolved,
    syncComputeTargetId: () => resolved,
    respond: () => {
      posts += 1;
      if (posts === 1) {
        // The id the lane held is stale cloud-side; the socket has since
        // re-acked a rotated one, which is what a re-resolve picks up.
        resolved = ROTATED_TARGET;
        return forbidden(
          DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
        );
      }
      return accepted();
    },
  });
  const result = await drive.run();

  assert.deepEqual(
    result.requestedTargets,
    [OWNED_TARGET, ROTATED_TARGET],
    "exactly two sends, the second under the freshly re-resolved target"
  );
  assert.equal(
    result.linkBlock,
    null,
    "the accepted retry clears the block, so the user is never shown a relink for a stale id"
  );
  const healEvent = result.laneEvents.at(-1);
  assert.equal(healEvent?.outcome, DesktopSyncBatchOutcome.Success);
  assert.equal(
    healEvent?.attempt,
    COMPUTE_TARGET_OWNERSHIP_HEAL_ATTEMPT,
    "`retried and it worked` must be readable in production as sync.attempt=2 on a success"
  );
});

test("ISS-11467: a second refusal stops at one retry and leaves the relink to own it", async () => {
  let resolved = OWNED_TARGET;
  const drive = driveInvocationLane({
    onlineComputeTargetId: () => resolved,
    syncComputeTargetId: () => resolved,
    respond: () => {
      resolved = ROTATED_TARGET;
      return forbidden(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      );
    },
  });
  const result = await drive.run();

  assert.deepEqual(
    result.requestedTargets,
    [OWNED_TARGET, ROTATED_TARGET],
    "the retry must go out under the FRESH target, and there must be no third send"
  );
  assert.equal(result.linkBlock?.refusedComputeTargetId, ROTATED_TARGET);
  const secondEvent = result.laneEvents.at(-1);
  assert.equal(secondEvent?.outcome, DesktopSyncBatchOutcome.Failure);
  assert.equal(secondEvent?.reason, SyncReason.TargetNotOwned);
  assert.equal(
    secondEvent?.attempt,
    COMPUTE_TARGET_OWNERSHIP_HEAL_ATTEMPT,
    "`retried and refused again` must be separately readable, not folded into the first refusal"
  );
});

test("ISS-11467: the slot is spent by the ATTEMPT, so one refused target gets exactly one heal and no more", () => {
  let reresolved: string | null = OWNED_TARGET;
  const healer = createComputeTargetOwnershipHealer({
    reresolveComputeTargetId: () => reresolved,
    log: () => undefined,
  });

  assert.equal(
    healer.claimRetryTargetId(FOREIGN_TARGET),
    OWNED_TARGET,
    "a re-resolve to a DIFFERENT target is the one thing worth retrying under"
  );
  healer.recordOutcome(
    ComputeTargetOwnershipHealOutcome.RefusedAgain,
    FOREIGN_TARGET,
    OWNED_TARGET
  );
  assert.equal(
    healer.claimRetryTargetId(FOREIGN_TARGET),
    null,
    "the same refused target gets exactly one heal, whatever that heal found"
  );

  reresolved = ROTATED_TARGET;
  assert.equal(
    healer.claimRetryTargetId(OWNED_TARGET),
    ROTATED_TARGET,
    "a DIFFERENT refused target carries its own attempt — the bound is per target, not per process"
  );
});

test("ISS-11467: a spent heal is remembered across other targets, so an alternating socket does not re-arm it on every switch", () => {
  let reresolved = ROTATED_TARGET;
  const healer = createComputeTargetOwnershipHealer({
    reresolveComputeTargetId: () => reresolved,
    log: () => undefined,
  });

  // Spend A's heal, then B's. A single remembered slot would forget A here, and an
  // install whose target flaps between two ids would pay a retry on every batch —
  // the per-batch cost the bound exists to prevent.
  healer.claimRetryTargetId(OWNED_TARGET);
  healer.recordOutcome(
    ComputeTargetOwnershipHealOutcome.RefusedAgain,
    OWNED_TARGET,
    ROTATED_TARGET
  );
  reresolved = OWNED_TARGET;
  healer.claimRetryTargetId(FOREIGN_TARGET);
  healer.recordOutcome(
    ComputeTargetOwnershipHealOutcome.RefusedAgain,
    FOREIGN_TARGET,
    OWNED_TARGET
  );

  reresolved = ROTATED_TARGET;
  assert.equal(
    healer.claimRetryTargetId(OWNED_TARGET),
    null,
    "A's heal is still spent after B's, so the flap costs one request per target rather than one per batch"
  );
});

test("ISS-11467: a NON-attempt does not consume the target's heal, or the heal could never fire in the scenario it exists for", () => {
  let reresolved: string | null = FOREIGN_TARGET;
  const healer = createComputeTargetOwnershipHealer({
    reresolveComputeTargetId: () => reresolved,
    log: () => undefined,
  });

  // The ordinary strict-online tick: the resolver has not moved, so there is nothing
  // to retry under. Spending the slot here would burn the target's only attempt
  // within seconds of boot — on the production install this ticket cites, before the
  // rotation that makes a heal possible ever lands.
  assert.equal(healer.claimRetryTargetId(FOREIGN_TARGET), null);
  assert.equal(healer.claimRetryTargetId(FOREIGN_TARGET), null);

  reresolved = ROTATED_TARGET;
  assert.equal(
    healer.claimRetryTargetId(FOREIGN_TARGET),
    ROTATED_TARGET,
    "and when the resolver finally does move, the attempt is still there to spend"
  );
});

test("ISS-11467: a re-resolve that produces the id the cloud just refused sends nothing more, and is not filed as the foreign case", async () => {
  const logs: string[] = [];
  const logSpy = vi
    .spyOn(gatewayLog, "info")
    .mockImplementation((_scope, message) => {
      logs.push(message);
    });
  const drive = driveInvocationLane({
    // The resolver does not move — which is the ORDINARY state on a strict-online
    // lane, because a 403 restarts no socket and invalidates no retained record.
    onlineComputeTargetId: OWNED_TARGET,
    syncComputeTargetId: OWNED_TARGET,
    respond: () =>
      forbidden(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      ),
  });
  const result = await drive.run();
  logSpy.mockRestore();

  assert.deepEqual(
    result.requestedTargets,
    [OWNED_TARGET],
    "re-sending the id the server just refused buys one guaranteed-identical refusal and learns nothing"
  );
  assert.equal(
    result.linkBlock?.refusedBatchCount,
    1,
    "and it must not double-count the refusal the user is shown"
  );
  assert.ok(
    logs.some((message) =>
      message.includes(ComputeTargetOwnershipHealOutcome.NotReresolved)
    ),
    "the outcome is recorded under its own name — folding it into refused_again would attribute an unmoved resolver to a foreign account"
  );
  assert.equal(
    logs.filter((message) =>
      message.includes(ComputeTargetOwnershipHealOutcome.RefusedAgain)
    ).length,
    0
  );
});

test("ISS-11467: a re-resolve that can name no target at all is recorded as unnameable, not as a refusal", () => {
  const logs: string[] = [];
  const healer = createComputeTargetOwnershipHealer({
    reresolveComputeTargetId: () => null,
    log: (message) => logs.push(message),
  });

  assert.equal(healer.claimRetryTargetId(FOREIGN_TARGET), null);
  assert.ok(
    logs.some((message) =>
      message.includes(ComputeTargetOwnershipHealOutcome.Unnameable)
    )
  );
});

test("ISS-11467: one healer per composition, not per batch, and an ALTERNATING target does not re-arm a spent heal", async () => {
  // The socket flaps between two targets — two relays, or a reconnect that re-acks
  // the previous id. Each refusal rotates to the other one, so tick 2 is refused
  // under the SAME target tick 1 already spent its heal on. That is the only shape
  // that can tell the two healer lifetimes apart: any NEW refused target legitimately
  // re-arms, by design.
  let resolved = OWNED_TARGET;
  const drive = driveInvocationLane({
    onlineComputeTargetId: () => resolved,
    syncComputeTargetId: () => resolved,
    respond: () => {
      resolved = resolved === OWNED_TARGET ? ROTATED_TARGET : OWNED_TARGET;
      return forbidden(
        DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
      );
    },
  });
  await drive.run();
  drive.rearmQueue();
  const result = await drive.run();

  assert.deepEqual(
    result.requestedTargets,
    [OWNED_TARGET, ROTATED_TARGET, OWNED_TARGET],
    "tick 1 sends and heals; tick 2 is refused under the target whose heal is already spent and sends once — a healer rebuilt per batch, or a single slot that forgot the alternation, would send four times"
  );
});

test("ISS-11467: an inconclusive retry hands the lane back the FIRST result, so a speculative send cannot charge a retry budget the refusal never charged", async () => {
  const logs: string[] = [];
  const logSpy = vi
    .spyOn(gatewayLog, "info")
    .mockImplementation((_scope, message) => {
      logs.push(message);
    });
  let resolved = OWNED_TARGET;
  let posts = 0;
  const drive = driveInvocationLane({
    onlineComputeTargetId: () => resolved,
    syncComputeTargetId: () => resolved,
    respond: () => {
      posts += 1;
      if (posts === 1) {
        resolved = ROTATED_TARGET;
        return forbidden(
          DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
        );
      }
      // The retry lands under the fresh target and is REJECTED, not accepted: the
      // part belongs to a session the new target has no parent artifact for. That
      // reason charges a horizon that ends in quarantine, where `target_not_owned`
      // charges nothing at all.
      return rejected();
    },
  });
  const result = await drive.run();
  logSpy.mockRestore();

  assert.equal(result.requestedTargets.length, 2);
  assert.ok(
    logs.some((message) =>
      message.includes(ComputeTargetOwnershipHealOutcome.Inconclusive)
    ),
    "a retry that did not land must never be recorded as healed"
  );
  assert.equal(
    logs.filter((message) =>
      message.includes(ComputeTargetOwnershipHealOutcome.Healed)
    ).length,
    0
  );
  assert.equal(
    result.linkBlock?.refusedComputeTargetId,
    OWNED_TARGET,
    "and the lane is handed the first result back, so the batch is accounted as the no-budget-burn refusal it was"
  );
});

test("ISS-11467: an UNCODED 403 from a server predating ISS-11426 keeps today's behavior — no heal retry", async () => {
  const drive = driveInvocationLane({
    onlineComputeTargetId: OWNED_TARGET,
    syncComputeTargetId: OWNED_TARGET,
    // No `code` in the envelope, which is every API deployment before ISS-11426.
    respond: () => forbidden(),
  });
  const result = await drive.run();

  assert.equal(
    result.requestedTargets.length,
    1,
    "a bare 403 cannot be attributed to ownership, so guessing a heal from the status is refused"
  );
  const only = result.laneEvents.at(-1);
  assert.equal(
    only?.reason,
    SyncReason.TargetNotOwned,
    "the pre-ISS-11426 status fold is unchanged"
  );
  assert.equal(
    only?.attempt,
    undefined,
    "no attempt count is fabricated for a send that was never retried"
  );
  assert.equal(
    result.linkBlock?.refusedComputeTargetId,
    OWNED_TARGET,
    "the ISS-11426 latch still fires on the uncoded 403, exactly as it does today"
  );
});

test("ISS-11467: the shared fold binds an online target only when the identity-bound resolver names the same one", () => {
  assert.equal(
    identityBoundComputeTargetId(OWNED_TARGET, OWNED_TARGET),
    OWNED_TARGET,
    "online under one identity is unchanged from the raw read"
  );
  assert.equal(
    identityBoundComputeTargetId(FOREIGN_TARGET, null),
    null,
    "a known-foreign id is refused before it can be sent"
  );
  assert.equal(
    identityBoundComputeTargetId(null, OWNED_TARGET),
    null,
    "offline or mid-flap stays null rather than falling back to the retained id"
  );
});

function forbidden(
  code?: DesktopAgentComponentInvocationSyncRestErrorCode
): Response {
  return Response.json(
    {
      success: false,
      error: "Forbidden",
      ...(code === undefined ? {} : { code }),
    },
    { status: 403 }
  );
}

function rejected(): Response {
  const part_ = part();
  return Response.json({
    success: true,
    data: {
      accepted: false,
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalGenerationId: part_.externalGenerationId,
      partIndex: part_.partIndex,
      partHash: part_.partHash,
      reason: AgentComponentInvocationSyncRejectReason.SessionMissing,
    },
  });
}

function accepted(): Response {
  const accepted = part();
  return Response.json({
    success: true,
    data: {
      accepted: true,
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalGenerationId: accepted.externalGenerationId,
      partIndex: accepted.partIndex,
      partHash: accepted.partHash,
      state: AgentComponentInvocationSyncAckState.Activated,
    },
  });
}

/**
 * Compose the real invocation lane over a fake outbox source and a scripted
 * fetch, and report what actually crossed the wire. The compute-target readers
 * are suppliers so a case can model a target that ROTATES between the refused
 * send and the re-resolve, which is the stale case this ticket heals.
 */
function driveInvocationLane(options: {
  onlineComputeTargetId: string | null | (() => string | null);
  syncComputeTargetId: string | null | (() => string | null);
  /** Defaults to the FOREIGN-ACCOUNT reason, the one the relink is the remedy for. */
  computeTargetRefusal?: ComputeTargetRefusalReason;
  respond: () => Response;
}): {
  run: () => Promise<{
    requestedTargets: string[];
    laneEvents: SyncLaneBatchEvent[];
    linkBlock: ComputeTargetLinkBlockState | null;
  }>;
  /**
   * Clear the environmental defer the refusal set, so the next `run()` re-sends the
   * same still-pending part. Without it a second tick finds nothing ready and cannot
   * tell a healer shared across ticks from one rebuilt per batch.
   */
  rearmQueue: () => void;
} {
  const read = (value: string | null | (() => string | null)): string | null =>
    typeof value === "function" ? value() : value;
  const requestedTargets: string[] = [];
  const events: SyncLaneBatchEvent[] = [];
  const computeTargetLinkBlock = createComputeTargetLinkBlockTracker();
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(requestUrl(input));
    const target = url.searchParams.get("computeTargetId");
    if (target !== null) {
      requestedTargets.push(target);
    }
    return Promise.resolve(options.respond());
  }) as typeof fetch;
  const lanes = createDesktopSyncLanes({
    desktopSessionManager: {
      getAccessToken: () => Promise.resolve("token"),
      getAccountAdmission: () => null,
      getIdentity: () => null,
      invalidateAccessToken: () => undefined,
    },
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
    getDataSyncLevel: () => DataSyncLevel.Full,
    getTranscriptComputeTargetId: () => read(options.onlineComputeTargetId),
    getSyncComputeTargetId: () => read(options.syncComputeTargetId),
    getComputeTargetRefusal: () =>
      options.computeTargetRefusal ?? ComputeTargetRefusalReason.ForeignAccount,
    isSessionMetadataSyncTierAllowed: () => true,
    hasSyncObservabilityTierBeenSet: () => true,
    hasRecordedSyncConsent: () => true,
    isHttpAgentSessionSyncReady: () => true,
    isInitialSessionProjectionReady: () => true,
    isSyncCompressionSupported: () => false,
    isSyncActivityChunkingSupported: () => false,
    getSyncSource: () => invocationSyncSource(),
    waitForBackgroundSlot: () => Promise.resolve(),
    appOtelRuntime: recordingOtelRuntime((event) => events.push(event)),
    isTranscriptSyncRunning: () => false,
    computeTargetLinkBlock,
  });
  return {
    async run() {
      await lanes.agentComponentInvocationSync.syncOnce();
      return {
        requestedTargets,
        laneEvents: events.filter(
          (event) => event.lane === SyncLane.InvocationParts
        ),
        linkBlock: computeTargetLinkBlock.read(),
      };
    },
    /**
     * Clear the environmental defer the refusal set, so the next `run()` re-sends
     * the same still-pending part. Without this a second tick finds nothing ready
     * and cannot tell a healer shared across ticks from one rebuilt per batch.
     */
    rearmQueue() {
      for (const entry of sharedFakeSource?.entries ?? []) {
        entry.nextAttemptAt = null;
      }
    },
  };
}

let sharedInvocationSource: AgentSessionSyncSource | null = null;
let sharedFakeSource: FakeSource | null = null;

/**
 * One source per drive, so the two batches of a multi-part tick are served from one
 * queue and therefore meet the same healer.
 */
function invocationSyncSource(): AgentSessionSyncSource {
  if (sharedInvocationSource) {
    return sharedInvocationSource;
  }
  const fake = new FakeSource(part());
  sharedFakeSource = fake;
  sharedInvocationSource = {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    prepareInvocationSyncTarget: () => fake.prepareInvocationSyncTarget(),
    loadReadyInvocationSyncParts: (sourceKey, now) =>
      fake.loadReadyInvocationSyncParts(sourceKey, now),
    recoverInvocationSyncDeadLetters: () =>
      Promise.resolve({
        recoveredParts: 0,
        cappedParts: 0,
        quarantinedParts: 0,
      }),
    recordInvocationSyncRetry: (sourceKey, pending, retry) =>
      fake.recordInvocationSyncRetry(sourceKey, pending, retry),
    clearAcknowledgedInvocationSyncPart: (sourceKey, ack) =>
      fake.clearAcknowledgedInvocationSyncPart(sourceKey, ack),
    deadLetterInvocationSyncPart: (sourceKey, pending, deadLetter) =>
      fake.deadLetterInvocationSyncPart(sourceKey, pending, deadLetter),
  };
  return sharedInvocationSource;
}

afterEach(() => {
  sharedInvocationSource = null;
  sharedFakeSource = null;
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function recordingOtelRuntime(
  onEmit: (event: SyncLaneBatchEvent) => void
): DesktopOtelRuntime {
  return {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: () => undefined,
    emitSanitizedAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: (event) => onEmit(event as SyncLaneBatchEvent),
    emitImportHealthEvent: () => undefined,
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitOnboardingEvent: () => undefined,
    emitOnboardingDiscardEvent: () => undefined,
    emitUpdateEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
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
