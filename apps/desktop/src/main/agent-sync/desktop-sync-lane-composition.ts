import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import {
  type DataSyncLevel,
  dataSyncLevelAllowsTranscripts,
} from "@repo/api/src/types/data-sync-level";
import { normalizeEnvironmentKey } from "../../shared/environment-key.js";
import {
  type SyncBurndownSnapshot,
  SyncLaneId,
} from "../../shared/sync-burndown-contract.js";
import { DesktopAgentSessionsAckReason } from "../cloud/cloud-protocol.js";
import {
  type AgentComponentInvocationSyncClientResult,
  createDesktopAgentComponentInvocationsClient,
} from "../dashboard/desktop-agent-component-invocations-client.js";
import { createDesktopClaudeCodeTelemetryClient } from "../dashboard/desktop-claude-code-telemetry-client.js";
import { createDesktopComponentsClient } from "../dashboard/desktop-components-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";
import {
  SyncBurndownLogLevel,
  SyncBurndownReporter,
} from "../sync/sync-burndown-reporter.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import { DesktopSyncBatchOutcome } from "../telemetry/app-otel-runtime.js";
import { reportInvocationSyncMissingParents } from "../telemetry/invocation-sync-missing-parents-telemetry.js";
import { Observability } from "../telemetry/observability.js";
import { recordSyncBurndownSample } from "../telemetry/sync-burndown-gauges.js";
import { reportSyncLaneStall } from "../telemetry/sync-lane-stall-telemetry.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  buildAgentComponentInvocationSyncSourceKey,
} from "./agent-component-invocation-sync-constants.js";
import {
  AgentComponentInvocationSyncService,
  resolveAgentComponentInvocationSyncSource,
} from "./agent-component-invocation-sync-service.js";
import {
  ComponentSyncSendOutcome,
  type ComponentSyncSendResult,
} from "./agent-component-sync-dead-letter.js";
import type { SessionCursorBoundary } from "./agent-session-sync-cursor-prefix.js";
import type { AgentSessionPayloadPreparer } from "./agent-session-sync-payload.js";
import { createAgentSessionPayloadWorkerPreparer } from "./agent-session-sync-payload-worker-runner.js";
import { AgentSessionSyncService } from "./agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";
import {
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "./agent-session-sync-source.js";
import { logSyncTickFailure } from "./agent-session-sync-tick-failure-log.js";
import {
  ClaudeCodeTelemetrySyncService,
  resolveClaudeCodeTelemetrySyncStore,
} from "./claude-code-telemetry-sync-service.js";
import {
  type ComputeTargetLinkBlockTracker,
  createComputeTargetLinkBlockTracker,
} from "./compute-target-link-block.js";
import {
  createComputeTargetOwnershipHealer,
  sendInvocationPartWithOwnershipHeal,
} from "./compute-target-ownership-heal.js";
import { createDesktopAgentSessionsClient } from "./desktop-agent-sessions-client.js";
import { identityBoundComputeTargetId } from "./identity-bound-compute-target.js";
import { rehydrateSessionCursorWhenOwnersDerive } from "./owner-rung-cursor-rehydration.js";
import { ComputeTargetRefusalReason } from "./retained-compute-target-identity.js";
import { sessionMetadataBatchEvent } from "./sync-lane-cloud-health.js";

/**
 * The live application state the cloud sync lanes read on every tick. Nothing
 * here is snapshotted: identity, connectivity, consent, and the local SQLite
 * sync source are all re-read so a lane self-heals as those change.
 */
export type DesktopSyncLaneDeps = {
  /** The auth surface every lane reads, live on each tick. */
  desktopSessionManager: SyncLaneSessionManager;
  getApiKey: () => string | null;
  getApiOrigin: () => string;
  /** The relay compute target for the component lanes (null when offline). */
  getTranscriptComputeTargetId: () => string | null;
  /**
   * ISS-8691: the compute target the SESSION lane writes under — the live
   * hello-derived id, or the one retained from the last hello for the identity
   * signed in right now. Not strict-online: the session write is an HTTP POST
   * that does not need the socket, and gating it on one made a flapping socket
   * read as an outage. See `retained-compute-target-identity.ts`.
   */
  getSyncComputeTargetId: () => string | null;
  /**
   * ISS-11467: why {@link DesktopSyncLaneDeps.getSyncComputeTargetId} refused a
   * live id on its last read, or null when it refused nothing. Read so a
   * locally-detected FOREIGN target still reaches the ISS-11426 relink, which used
   * to learn about it from the server's 403 on a batch no lane sends any more.
   */
  getComputeTargetRefusal: () => ComputeTargetRefusalReason | null;
  isSessionMetadataSyncTierAllowed: () => boolean;
  /**
   * ISS-8768 (marisolashgrove review): has this device EVER recorded a
   * sync-observability tier — an explicit choice OR an explicit "not yet"?
   * `false` means the key is ABSENT (never asked), which
   * `isSessionMetadataSyncTierAllowed` cannot distinguish from a present `null`
   * (an authoritative refusal) — both read as "not allowed" there, correctly,
   * because egress must fail closed on either. Used ONLY by
   * {@link laneDeliveryConsented}'s detector axis, never by egress.
   */
  hasSyncObservabilityTierBeenSet: () => boolean;
  /**
   * ISS-7516: this machine's reconciled data-sync level, stamped on each
   * agent-session batch so the cloud can distinguish a transcript that was never
   * queued from one still uploading.
   */
  getDataSyncLevel: () => DataSyncLevel;
  /** Saved choice for the active organization, independent of transport readiness. */
  hasRecordedSyncConsent: () => boolean;
  isHttpAgentSessionSyncReady: () => boolean;
  /** ISS-11610: initial import and sync-relevant derivations have settled. */
  isInitialSessionProjectionReady: () => boolean;
  isSyncCompressionSupported: () => boolean;
  isSyncActivityChunkingSupported: () => boolean;
  isSyncPrRefChunkingSupported?: () => boolean;
  isSyncMonitoredActivitySupported?: () => boolean;
  isSyncSpanExtentSupported?: () => boolean;
  isSyncHumanTurnTimestampsSupported?: () => boolean;
  isSyncAgentTurnTimestampsSupported?: () => boolean;
  isSyncTokenEventOwnerSupported?: () => boolean;
  /** The SQLite sync source, or null until the db host is ready. */
  getSyncSource: () => AgentSessionSyncSource | null;
  waitForBackgroundSlot: () => Promise<void>;
  appOtelRuntime: DesktopOtelRuntime;
  /**
   * ISS-5387: is the transcript archive lane actually running? The transcript
   * lane is composed elsewhere, so the burn-down reporter cannot read its gate
   * directly — without this it could not tell `idle_not_running` from `drained`
   * for that lane, which is one of the three states this ticket exists to keep
   * apart.
   */
  isTranscriptSyncRunning: () => boolean;
  /**
   * ISS-9166: override the session lane's payload preparer. ABSENT IN
   * PRODUCTION, which keeps the `worker_threads` preparer wired below.
   *
   * The one caller is the live desktop↔cloud harness
   * (`scripts/live-sync-harness.ts`), which runs this composition under `tsx`:
   * the worker entry is named as the `.js` sibling the BUILD emits, which does
   * not exist before one, so the worker cannot start there. It passes the
   * in-process preparer the service already falls back to. Kept an explicit
   * override rather than a runtime probe, because a preparer that silently
   * degraded would be how a lane loses its worker in production with nothing
   * saying so.
   */
  preparePayloads?: AgentSessionPayloadPreparer;
  /**
   * ISS-9166: a second reader of the burn-down sample, TEED beside the telemetry
   * one. Absent in production.
   *
   * The one caller is the live desktop↔cloud harness
   * (`scripts/live-sync-harness.ts`), which needs the all-lanes remainder to
   * decide when the drain is actually finished — the session lane's `caughtUp`
   * is a PER-LANE signal and says nothing about the invocation-parts or
   * component-inventory queues (`agent-session-sync-service-options.ts`,
   * ISS-5768). Exposed as a tee rather than letting the harness build its own
   * `SyncBurndownQuery`, because that would put a second derivation of every
   * lane's `sourceKey` in a consumer: one that drifts silently reads an EMPTY
   * queue for a key nothing writes and reports the lane drained.
   */
  onSyncBurndownSample?: (snapshot: SyncBurndownSnapshot) => void;
  /**
   * ISS-11426: the compute-target link block, supplied by the application so the
   * transcript lane — which emits its batch events through its own seam — folds
   * into the SAME latch this composition feeds from the invocation lane. Two
   * trackers would let one lane's success clear a block the other lane is still
   * hitting. Omitted in tests and standalone composition, where a private
   * tracker is the whole population.
   */
  computeTargetLinkBlock?: ComputeTargetLinkBlockTracker;
};

/** The cloud sync collaborators the application owns as fields. */
export type DesktopSyncLanes = {
  agentSessionSync: AgentSessionSyncService;
  agentComponentInvocationSync: AgentComponentInvocationSyncService;
  /**
   * ISS-10717: the desktop→cloud Claude Code OTel telemetry lane. Before it, the
   * fourteen `claude_code_*` tables were write-only and never left the machine.
   */
  claudeCodeTelemetrySync: ClaudeCodeTelemetrySyncService;
  /** ISS-5387: the read-only periodic burn-down sampler over all five lanes. */
  syncBurndownReporter: SyncBurndownReporter;
  /**
   * ISS-11426: whether the cloud is refusing this machine's compute target as
   * not owned by the signed-in account. Read by the runtime-status poll so the
   * user is told, and offered the relink, instead of the lane deferring in
   * silence.
   */
  computeTargetLinkBlock: ComputeTargetLinkBlockTracker;
};

/**
 * Compose the cloud sync lanes.
 *
 * All three lanes share one transport model: a first-party Desktop session
 * Bearer against the API origin, scoped to the hello-derived compute target.
 * Each is inert until its own gate opens, so constructing them is always safe.
 * That gate is NOT uniform: the session-metadata, invocation-part and
 * transcript lanes open on the consent tier AND a live session AND a nameable
 * compute target, while the component-INVENTORY lane opens on a live session and
 * a compute target alone - it carries no session-derived content and is an
 * always-on Desktop capability (see `laneDeliveryConsented`).
 * ISS-8691: the session lane's target may be retained from the last hello rather
 * than live, so that lane alone keeps working while the socket reconnects.
 */
export function createDesktopSyncLanes(
  deps: DesktopSyncLaneDeps
): DesktopSyncLanes {
  // ISS-5387: the burn-down reporter is constructed FIRST so the lane wiring
  // below can tee its existing send/telemetry hooks into it. Those tees are the
  // only way this observer learns a lane is active without adding a query to any
  // lane's hot path — an increment on a path that was already being called.
  // ISS-10429: the reporter reads the session lane's cursor boundary, but the
  // service is built below it, so the read is bound once the service exists.
  // Until then the reporter sees no boundary, which never suppresses a stall.
  // ISS-11427: the session lane's DLQ depth, for the dead-letter span. Declared
  // and assigned in the same shape as `readSessionCursorBoundary` below, because
  // the telemetry adapter is built INSIDE the service's own options object and
  // must not close over the `const` it is being passed to.
  //
  // Read ONLY on the dead-letter arm, and that gate is load-bearing rather than
  // an optimisation: `getSyncProgress` is not the pure read its docstring claims
  // — `SessionProgressTally.sample` folds `inFlightHighWater` — so calling it on
  // every lane-1 batch would advance the renderer's high-water mark at instants
  // the renderer never polled. A narrow getter on the service would be the
  // better seam; `agent-session-sync-service.ts` is on the SHRINK-ONLY
  // grandfather list, so adding one there is not available here.
  let readSessionDeadLetteredCount: () => number | undefined = () => undefined;
  let readSessionCursorBoundary: () => SessionCursorBoundary | null = () =>
    null;
  const syncBurndownReporter = buildSyncBurndownReporter(deps, () =>
    readSessionCursorBoundary()
  );
  const computeTargetLinkBlock =
    deps.computeTargetLinkBlock ?? createComputeTargetLinkBlockTracker();
  // ISS-11467: the bounded, silent heal for the refusals the local owner check
  // deliberately cannot judge. Wired on the invocation lane ALONE, because it is
  // the only lane whose 403 carries the ISS-11426 code that separates an
  // ownership miss from an org-policy denial — retrying off a BARE 403 would
  // re-collapse the two the coded 403 exists to keep apart. One healer per
  // composition, so its single-slot bound is shared across ticks rather than
  // re-armed on every batch.
  const ownershipHealer = createComputeTargetOwnershipHealer({
    reresolveComputeTargetId: () =>
      identityBoundTranscriptComputeTargetId(deps),
    log: (message) => gatewayLog.info("component-invocation-sync", message),
  });
  // ISS-11467: the target every lane below writes under, and the one seam where a
  // locally-refused FOREIGN id is recorded. Deliberately NOT pure — the pure fold
  // is `identityBoundTranscriptComputeTargetId`, which the burn-down keys off and
  // must stay side-effect-free. Routing the lanes through the owner check means the
  // cloud never refuses a known-foreign id, so `observe` lost its only producer for
  // the state ISS-11426's relink exists to offer; this restores it from the side
  // that already knew. Gated on the FOREIGN-ACCOUNT reason so the transient
  // ISS-8702 origin mismatch never raises a prompt that would clear itself.
  const laneComputeTargetId = (): string | null => {
    const onlineTargetId = deps.getTranscriptComputeTargetId();
    const boundTargetId = identityBoundTranscriptComputeTargetId(deps);
    if (
      boundTargetId === null &&
      onlineTargetId !== null &&
      deps.getComputeTargetRefusal() ===
        ComputeTargetRefusalReason.ForeignAccount
    ) {
      computeTargetLinkBlock.observeLocalOwnershipRefusal(onlineTargetId);
    }
    return boundTargetId;
  };
  // Gap B (#2570 follow-up): component-inventory sync lane. Like the session
  // lane, the component inventory endpoint is a plain authenticated HTTP POST,
  // so this client mirrors the transcript control-plane transport (first-party
  // Bearer JWT + API origin) and targets the same relay compute target the
  // session cursor is scoped to.
  const componentsClient = createDesktopComponentsClient({
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    getComputeTargetId: () => laneComputeTargetId(),
    onUnauthorized: (rejectedToken) =>
      deps.desktopSessionManager.invalidateAccessToken(rejectedToken),
  });
  const componentInvocationsClient =
    createDesktopAgentComponentInvocationsClient({
      getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
      getApiKey: () => deps.getApiKey(),
      getApiOrigin: () => deps.getApiOrigin(),
      getComputeTargetId: () => laneComputeTargetId(),
      onUnauthorized: (rejectedToken) =>
        deps.desktopSessionManager.invalidateAccessToken(rejectedToken),
    });
  // FEA-3425 (PLN-1437 Phase 4a): Lane-1 agent-session sync is HTTP-only.
  // With a live first-party Desktop session, agent-session batches POST to
  // /desktop/agent-sessions/sync under the session Bearer — the same
  // auth/transport model as the transcript and component lanes. The legacy
  // relay socket write path was retired once session coverage cleared the D7
  // no-strand gate, so there is a single transport now. Identity stays
  // hello-derived (D6): computeTargetId comes from the connected cloudStatus.
  const agentSessionsHttpClient = createDesktopAgentSessionsClient({
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    onUnauthorized: (rejectedToken) => {
      deps.desktopSessionManager.invalidateAccessToken(rejectedToken);
      // ISS-8610 (whitlockk review): invalidation only CLEARS the cache — the mint
      // happens on the next `getAccessToken`, and the environmental hold this
      // 401 just opened is precisely what stops the lane calling it. Without a
      // push here the lane waits out a rung for a token nothing will ask for,
      // and `noteCredentialsRefreshed` — which fires off `applyTokens` — can
      // never run, so the narrow 401 door is unreachable on a quiet desktop.
      //
      // Safe to fire per rejection: the refresh is single-flight, so a burst
      // collapses to one mint, and a late 401 naming an already-replaced token
      // no-ops in the invalidate above and then reads the fresh cache here
      // without refreshing at all (ISS-9701).
      deps.desktopSessionManager.getAccessToken().catch(() => undefined);
    },
  });
  const sessionSyncOptions: AgentSessionSyncServiceOptions = {
    // PRD-532 §7: honor the sync-observability consent tier (no-op unless the
    // unified-auth-onboarding flag is on).
    isCloudSyncTierAllowed: () => deps.isSessionMetadataSyncTierAllowed(),
    // ISS-7516: publish the level each batch was produced under, so the web
    // transcript panel can stop telling a transcript-excluding machine's reader
    // that an upload is still on its way.
    getDataSyncLevel: () => deps.getDataSyncLevel(),
    // FEA-3425 (Phase 4a): HTTP-only — the relay socket write path was retired
    // once session coverage cleared the D7 no-strand gate. ISS-8691: the lane
    // ticks on a live first-party session plus a nameable compute target, NOT on
    // socket liveness; a reconnecting socket no longer stops a healthy HTTP path.
    isHttpReady: () =>
      deps.isHttpAgentSessionSyncReady() &&
      deps.isInitialSessionProjectionReady(),
    // FEA-4138: only compress once the server advertised decompression.
    isSyncCompressionSupported: () => deps.isSyncCompressionSupported(),
    // ISS-4541: only paginate the activity-segment tiling across chunks once
    // the server advertised additive multi-part merge.
    isSyncActivityChunkingSupported: () =>
      deps.isSyncActivityChunkingSupported(),
    // ISS-9859: only split a session's PR refs across parts once the server
    // advertised that it merges a marked part instead of replacing the links.
    isSyncPrRefChunkingSupported: () =>
      deps.isSyncPrRefChunkingSupported?.() ?? false,
    isSyncMonitoredActivitySupported: () =>
      deps.isSyncMonitoredActivitySupported?.() ?? false,
    // ISS-5850: only stamp the extent-bearing cursor revision once the server
    // advertised that it stores the extent.
    isSyncSpanExtentSupported: () =>
      deps.isSyncSpanExtentSupported?.() ?? false,
    isSyncHumanTurnTimestampsSupported: () =>
      deps.isSyncHumanTurnTimestampsSupported?.() ?? false,
    isSyncAgentTurnTimestampsSupported: () =>
      deps.isSyncAgentTurnTimestampsSupported?.() ?? false,
    // ISS-12552: only send token-event owners to a server that accepts them.
    isSyncTokenEventOwnerSupported: () =>
      deps.isSyncTokenEventOwnerSupported?.() ?? false,
    sendBatch: (batch, sendOptions) => {
      const computeTargetId = deps.getSyncComputeTargetId();
      if (computeTargetId) {
        return agentSessionsHttpClient.sendBatch(
          batch,
          computeTargetId,
          sendOptions
        );
      }
      // No identity at all — no hello has ever landed for the signed-in account,
      // or the retained one belonged to a different account (ISS-8691). Being
      // merely offline no longer reaches here. Defer with backoff; never
      // dead-letter (the HTTP client returns `Unauthenticated` for the
      // no-session case, which the sync service also treats as a budget-free
      // pause).
      return Promise.resolve({
        accepted: false,
        reason: DesktopAgentSessionsAckReason.TransportUnavailable,
      });
    },
    getSource: () => deps.getSyncSource(),
    // FEA-1962: scope the persisted sync cursor to the authenticated compute
    // target so the cursor cannot leak across accounts/machines. computeTargetId
    // (assigned per authenticated account+machine on hello ack) is the stable
    // discriminator; null while offline → in-memory only.
    getSyncComputeTargetId: () => deps.getSyncComputeTargetId(),
    getSyncIdentity: () => deps.desktopSessionManager.getIdentity(),
    // ISS-7096: the environment this device currently syncs against, recorded
    // at hydration against the live compute target so the outbox partitioner
    // can tell this environment's retired keys from another environment's.
    getActiveEnvironmentKey: () => normalizeEnvironmentKey(deps.getApiOrigin()),
    // Gap B (#2570 follow-up): wire the component-inventory sync lane. Without
    // these three options `syncComponentsOnce` no-ops, so locally-collected
    // `agent_components` never reached the cloud. `sendComponents` POSTs the
    // batch over the first-party HTTP transport; the two readers delegate to
    // the SQLite sync source (null when the db host is not yet ready). The
    // lane respects the same enable/auth gating as session sync: ISS-4542, the
    // client resolves a classified `ComponentSyncSendResult` — `LaneFailure`
    // (no cursor advance, no poison-budget charge) when offline / unauthenticated
    // / no compute target, `BatchRejected` for a permanent per-batch rejection.
    sendComponents: async (payload) => {
      const result = await componentsClient.sync(payload);
      recordAcceptedComponentRecords(
        syncBurndownReporter,
        payload.components.length,
        result
      );
      return result;
    },
    listComponentCursorRows: (sinceTs, sinceId, limit) => {
      const source = deps.getSyncSource();
      return Promise.resolve(
        source?.listComponentCursorRows?.(sinceTs, sinceId, limit) ?? []
      );
    },
    loadComponentRows: (ids) => {
      const source = deps.getSyncSource();
      return Promise.resolve(source?.loadComponentRows?.(ids) ?? []);
    },
    waitForBackgroundSlot: () => deps.waitForBackgroundSlot(),
    preparePayloads:
      deps.preparePayloads ?? createAgentSessionPayloadWorkerPreparer(),
    onBatchOutcome: (event) => {
      Observability.agentSessionSyncBatchFailed(event);
    },
    // FEA-1995: per-batch sync.* transport-health telemetry → OTel runtime.
    // Inert until the runtime reaches Started (and when OTEL_SDK_DISABLED).
    onSyncBatchTelemetry: (event) => {
      // ISS-6338: name the lane. The session lane's own outcome, bytes, latency
      // and reason are untouched; the tag is what lets a monitor tell its
      // batches apart from the four lanes that now report alongside it.
      // ISS-11427: the DLQ depth rides the dead-letter arm, which had been
      // emitting none. `sessionMetadataBatchEvent` owns which arm carries it.
      const sessionBatchEvent = sessionMetadataBatchEvent(
        event,
        event.outcome === DesktopSyncBatchOutcome.DeadLetter
          ? readSessionDeadLetteredCount()
          : undefined
      );
      deps.appOtelRuntime.emitSyncBatchEvent(sessionBatchEvent);
      // ISS-11426 tee (whitlockk): this lane codes its 403 apart too (FEA-3425), and
      // it is the lane a device with no invocation backlog is refused on — so
      // without this a machine in exactly the stuck state this ticket is about
      // gets no alert and no action. Fed for every outcome, because a success
      // is what clears the block.
      computeTargetLinkBlock.observe(
        sessionBatchEvent,
        deps.getSyncComputeTargetId()
      );
      // ISS-5387 tee: the ONLY per-pass byte counter the session lane already
      // produces. Bytes are recorded for every outcome — a failed or
      // dead-lettered batch still spent them — which is what makes re-send
      // amplification legible against a barely-moving item count.
      syncBurndownReporter.recordSessionBatch({
        accepted: event.outcome === DesktopSyncBatchOutcome.Success,
        payloadBytes: event.payloadBytes,
        // ISS-7401: the committed outbox delete, which is what proves durable
        // progress on a queue a collector is refilling as fast as it drains.
        durablyClearedRows: event.durablyClearedRows,
      });
    },
    // ISS-9823 tee: the resume hydration's outcome, pushed into the burn-down
    // exactly as the batch telemetry above is, and for the same structural
    // reason — the reporter is built at :148, before this service at :187, so
    // lanes tee into it rather than it reaching back into them. Delivered on
    // every pass including the successful ones: the reporter holds a level, and
    // `Seeded` is what clears it.
    onResumeOutcome: (outcome) => {
      syncBurndownReporter.recordSessionResumeOutcome(outcome);
    },
    // ISS-6338: lane 3 (component inventory) is composed inside this same
    // service but reports through its OWN seam. Sharing the callback above would
    // re-stamp its events `session_metadata` and credit the session burn-down
    // with the component lane's work; see the option's docstring.
    onComponentSyncBatchTelemetry: (event) =>
      deps.appOtelRuntime.emitSyncBatchEvent(event),
  };
  const agentSessionSync = new AgentSessionSyncService(sessionSyncOptions);
  // ISS-12552: for the life of the lanes, which the application composes once.
  rehydrateSessionCursorWhenOwnersDerive(agentSessionSync, sessionSyncOptions);
  readSessionCursorBoundary = () => agentSessionSync.readCursorBoundary();
  readSessionDeadLetteredCount = () =>
    agentSessionSync.getSyncProgress().deadLetteredSessions;
  const agentComponentInvocationSync = new AgentComponentInvocationSyncService({
    onSessionMissingParts: (entries, computeTargetId, source, canStillSend) =>
      reportInvocationSyncMissingParents({
        entries,
        computeTargetId,
        source,
        // The lane's own gate, not a second copy of it. `isReady` below ANDs the
        // session-metadata tier onto readiness, so rebuilding the predicate here
        // from `isHttpAgentSessionSyncReady` alone would upload a per-session
        // diagnostic after a tier or org-policy change that landed during the
        // parent read — the post-await recheck `main/sync/AGENTS.md` section 12a
        // requires of this lane.
        canReport: canStillSend,
        sessionSourceKey: buildAgentSessionSyncSourceKey(
          computeTargetId,
          deps.isSyncMonitoredActivitySupported?.() ?? false
        ),
      }),
    // FEA-3425 (Phase 4a): mirror Lane 1's HTTP-only readiness gate. The
    // former socket-capability flag (serverAgentSessionSyncSupported) was
    // retired with the socket write path, so this HTTP lane ticks on a live
    // session + connected cloud, same as agent-session sync.
    //
    // The session-metadata tier stays ANDed here, unlike the component-inventory
    // lane: an invocation part is session-DERIVED, and `ingestPart` rejects it
    // `SessionMissing` until the parent `session_detail` exists in the cloud.
    // Delivering parts while the session lane is withheld would burn the
    // `SESSION_MISSING_MAX_RETRY_AGE_MS` horizon and terminally dead-letter
    // them, so the data would be lost rather than early. Component inventory
    // has no such parent and is therefore unconditional.
    isReady: () =>
      deps.isHttpAgentSessionSyncReady() &&
      deps.isInitialSessionProjectionReady() &&
      deps.isSessionMetadataSyncTierAllowed(),
    getSource: () =>
      resolveAgentComponentInvocationSyncSource(deps.getSyncSource()),
    getComputeTargetId: () => laneComputeTargetId(),
    // ISS-7096: the promotion ownership gate — another identity's sessions are
    // released from (and never re-materialized into) this target's queue.
    getSyncIdentity: () => deps.desktopSessionManager.getIdentity(),
    sendPart: (part, computeTargetId) =>
      sendInvocationPartWithOwnershipHeal({
        part,
        computeTargetId,
        client: componentInvocationsClient,
        computeTargetLinkBlock,
        emitSyncBatchEvent: (event) =>
          deps.appOtelRuntime.emitSyncBatchEvent(event),
        ownershipHealer,
        recordAccepted: (result) =>
          recordAcceptedInvocationPart(syncBurndownReporter, result),
      }),
    waitForBackgroundSlot: () => deps.waitForBackgroundSlot(),
    log: (message) => gatewayLog.info("component-invocation-sync", message),
    onSyncError: (error) => {
      if (logSyncTickFailure("component-invocation-sync", error)) {
        deps.appOtelRuntime.emitAppExceptionEvent({
          error,
          origin: AppExceptionOrigin.Main,
        });
      }
    },
  });
  const claudeCodeTelemetryClient = createDesktopClaudeCodeTelemetryClient({
    getAccessToken: () => deps.desktopSessionManager.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    getApiKey: () => deps.getApiKey(),
    getComputeTargetId: () => deps.getSyncComputeTargetId(),
    onUnauthorized: (rejectedToken) =>
      deps.desktopSessionManager.invalidateAccessToken(rejectedToken),
  });
  const claudeCodeTelemetrySync = new ClaudeCodeTelemetrySyncService({
    // Gated on the SAME consent tier as the session lane: this corpus is
    // session-scoped telemetry, so a device that has not consented to session
    // metadata sync must not ship it either.
    isReady: () =>
      deps.isHttpAgentSessionSyncReady() &&
      deps.isSessionMetadataSyncTierAllowed(),
    getAccountAdmission: () => deps.desktopSessionManager.getAccountAdmission(),
    store: () => resolveClaudeCodeTelemetrySyncStore(deps.getSyncSource()),
    getComputeTargetId: () => deps.getSyncComputeTargetId(),
    sendSession: (input, canStillSend) =>
      claudeCodeTelemetryClient.syncSession(input, canStillSend),
    log: (message) => gatewayLog.info("claude-code-telemetry-sync", message),
  });
  return {
    agentSessionSync,
    agentComponentInvocationSync,
    claudeCodeTelemetrySync,
    syncBurndownReporter,
    computeTargetLinkBlock,
  };
}

/**
 * ISS-8768 (whitlockk review): the identity-bound compute target for the burn-down
 * reporter's component/invocation/transcript keys.
 *
 * `getTranscriptComputeTargetId` (`onlineComputeTargetId`) is STRICT-ONLINE and
 * carries no identity check at all — it names whatever target the socket is
 * currently reporting, full stop. After an account switch, the socket can still
 * be reporting the PREVIOUS account's target while `getSyncComputeTargetId` (the
 * identity-bound live-or-retained resolver) has already gone `null` for the new
 * one, because that resolver refuses a known-foreign id. Building these reporter
 * keys from the raw online target alone would count the old account's backlog
 * and could turn it into a `gate_shut_with_backlog` alert attributed to whoever
 * is signed in now.
 *
 * Reporting only when the two AGREE fixes that without changing behavior in
 * either of the other two states: while online under one identity they are
 * always equal (this returns the same value as before), and while offline or
 * mid-flap `getTranscriptComputeTargetId` is null so they already disagree and
 * the key stays unmeasured — exactly today's behavior, not a new regression
 * during an ordinary reconnect.
 *
 * Exported (whitlockk review) for direct regression coverage — see
 * `desktop-sync-lane-composition-target-scope.test.ts`.
 */
export function identityBoundTranscriptComputeTargetId(
  deps: DesktopSyncLaneDeps
): string | null {
  return identityBoundComputeTargetId(
    deps.getTranscriptComputeTargetId(),
    deps.getSyncComputeTargetId()
  );
}

/**
 * ISS-5387: build the read-only burn-down reporter over all five lanes.
 *
 * Every source key is resolved LIVE from the current compute target, exactly as
 * the lanes themselves resolve theirs, so a burn-down can never report one
 * account's queue while another account is signed in (`main/sync/AGENTS.md`
 * invariant 2 — see {@link identityBoundTranscriptComputeTargetId} for the
 * account-switch edge that resolving the component/invocation/transcript keys
 * from the raw online target alone would miss). A null target yields a null key,
 * which the store reads as "this lane has no identity yet" rather than as an
 * empty queue.
 *
 * The per-lane gates mirror each lane's own readiness predicate. That is what
 * keeps `idle_not_running` honest: a lane whose gate is shut has not delivered
 * anything, it has merely stopped trying, and it must never be reported as
 * caught up.
 */
export function buildSyncBurndownReporter(
  deps: DesktopSyncLaneDeps,
  readSessionCursorBoundary: () => SessionCursorBoundary | null
): SyncBurndownReporter {
  // Component inventory carries no session-metadata consent gate (see
  // `laneDeliveryConsented`), so its running-ness is transport alone.
  const componentLaneReady = () => deps.isHttpAgentSessionSyncReady();
  return new SyncBurndownReporter({
    getSource: () => deps.getSyncSource(),
    getSessionSourceKey: () => {
      const computeTargetId = deps.getSyncComputeTargetId();
      return computeTargetId
        ? buildAgentSessionSyncSourceKey(
            computeTargetId,
            deps.isSyncMonitoredActivitySupported?.() ?? false
          )
        : null;
    },
    getInvocationSourceKey: () => {
      const computeTargetId = identityBoundTranscriptComputeTargetId(deps);
      return computeTargetId
        ? buildAgentComponentInvocationSyncSourceKey(computeTargetId)
        : null;
    },
    invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    getIdentity: () => deps.desktopSessionManager.getIdentity(),
    getTranscriptComputeTargetId: () =>
      identityBoundTranscriptComputeTargetId(deps),
    getComponentSourceKey: () => {
      const computeTargetId = identityBoundTranscriptComputeTargetId(deps);
      return computeTargetId
        ? buildAgentComponentSyncSourceKey(computeTargetId)
        : null;
    },
    readSessionCursorBoundary,
    isSessionLaneRunning: () =>
      sessionProjectionLaneReady(deps) &&
      deps.getSyncComputeTargetId() !== null,
    isInvocationLaneRunning: () =>
      sessionProjectionLaneReady(deps) &&
      identityBoundTranscriptComputeTargetId(deps) !== null,
    isTranscriptLaneRunning: () => deps.isTranscriptSyncRunning(),
    isComponentLaneRunning: () =>
      componentLaneReady() &&
      identityBoundTranscriptComputeTargetId(deps) !== null,
    // ISS-8768: consent ALONE — deliberately not ANDed with transport readiness
    // or a compute target, which are the very things whose absence shuts the
    // gate. Pairing "the user asked for delivery" with "the lane is not running"
    // is what makes a shut gate reportable instead of silent.
    isLaneDeliveryConsented: (lane) => laneDeliveryConsented(lane, deps),
    log: (level, message) => {
      if (level === SyncBurndownLogLevel.Warn) {
        gatewayLog.warn("sync-burndown", message);
        return;
      }
      gatewayLog.info("sync-burndown", message);
    },
    // ISS-9246: the same sample the lines above describe, promoted to the
    // metrics pipeline. Rides the KEYLESS relay leg, so a lane whose backlog is
    // growing BECAUSE auth broke can still report it - unlike `onLaneStall`
    // below, which goes out on the authenticated `POST /desktop/telemetry` lane
    // and dies with the thing it reports.
    onSample: (snapshot) => {
      recordSyncBurndownSample(snapshot);
      deps.onSyncBurndownSample?.(snapshot);
    },
    onLaneStall: (report) => {
      // A raw log is not an alert. The stall rides the SAME desktop telemetry
      // transport as every other monitored desktop signal, at `error` severity.
      // Deliberately NOT `storeIntegrityResult`: that method owns a cadence
      // state machine for the SQLite probe, and folding an unrelated condition
      // into it would corrupt the probe's own detected/recovered transitions.
      reportSyncLaneStall(report);
    },
  });
}

/**
 * ISS-5387 tee: count component records the cloud ACCEPTED, after the result is
 * known — never the attempt.
 *
 * This counter is what `detectCursorStall` reads as "work completed", and the
 * stall it raises asserts that uploads are succeeding while the durable cursor
 * stands still. `LaneFailure` and `BatchRejected` both leave the cursor
 * deliberately unchanged (`agent-session-sync-component-lane.ts` :560-591), so
 * counting an attempt here turned an ordinary failed send — a 500, a 429, an
 * expired token — into a `sync.durable_cursor.stalled` alert claiming the exact
 * opposite of what happened. The increment belongs inside the branch where its
 * precondition actually held.
 */
export function recordAcceptedComponentRecords(
  reporter: SyncBurndownReporter,
  recordCount: number,
  result: ComponentSyncSendResult
): void {
  if (result.outcome === ComponentSyncSendOutcome.Accepted) {
    reporter.recordComponentRecordsSent(recordCount);
  }
}

/**
 * ISS-5387 tee: one invocation part the cloud ACCEPTED. Same rule as
 * {@link recordAcceptedComponentRecords} — `unavailable` and `retry` delivered
 * nothing, and a REJECTED ack is a negative acknowledgement, so only an accepted
 * ack is work completed. Read against the delivery-key queue depth the reporter
 * samples, this is what separates "draining" from "spinning": attempts that keep
 * failing now show as a flat queue with zero completed, which is the truth.
 */
export function recordAcceptedInvocationPart(
  reporter: SyncBurndownReporter,
  result: AgentComponentInvocationSyncClientResult
): void {
  if (result.kind === "ack" && result.ack.accepted) {
    reporter.recordInvocationPartSent();
  }
}

/**
 * The slice of `DesktopSessionManager` the sync lanes use. Structural on
 * purpose — the lanes must not depend on the whole manager.
 */
export type SyncLaneSessionManager = {
  getAccessToken: () => Promise<string | null>;
  getAccountAdmission: () => DesktopAccountAdmission | null;
  getIdentity: () => SignedInUserIdentity | null;
  invalidateAccessToken: (rejectedToken?: string) => void;
};

/**
 * ISS-8768: does this machine's persisted consent say THIS lane should be
 * delivering? The consent axis is NOT shared across the five lanes, so one
 * machine-wide predicate is wrong rather than merely coarse.
 *
 * `metadata` tier permits session metadata while DELIBERATELY keeping
 * transcripts local (`dataSyncLevelAllowsTranscripts` is `full`-only), so
 * answering the transcript lane from the session-metadata tier reports a
 * metadata-tier user as consented-but-gated and pages them for the
 * configuration they chose — the exact noise the consent check exists to
 * prevent.
 *
 * Exported (whitlockk review) so a metadata-tier-vs-transcript regression is caught
 * by calling THIS function directly rather than by a test that injects the
 * answer it is meant to produce — see
 * `desktop-sync-lane-composition-consent.test.ts`.
 *
 * ISS-8768 (marisolashgrove review): ABSENT is not the same as NULL. A device that
 * has never recorded a `syncObservabilityTier` key at all — never shown the
 * SyncConsent UI — reads through `isSessionMetadataSyncTierAllowed` exactly
 * like one that explicitly answered "not yet" (a present `null`), because the
 * egress gate must fail closed on both. That collapse is right for egress and
 * wrong for THIS detector: an explicit refusal is an authoritative choice this
 * detector must respect and stay silent on, but "never asked" is the state a
 * never-onboarded-but-collecting machine is permanently in, and is the exact
 * install ISS-8768 was written to catch. `hasSyncObservabilityTierBeenSet`
 * (key presence, not the collapsed value) is what tells the two apart, and
 * treating "never asked" as consented here is what lets the detector fire on
 * that machine instead of staying dark on it forever.
 */
export function laneDeliveryConsented(
  lane: SyncLaneId,
  deps: DesktopSyncLaneDeps
): boolean {
  if (lane === SyncLaneId.ComponentInventory) {
    return deps.hasRecordedSyncConsent();
  }
  const sessionMetadataConsented =
    deps.isSessionMetadataSyncTierAllowed() ||
    !deps.hasSyncObservabilityTierBeenSet();
  if (lane === SyncLaneId.TranscriptArchive) {
    return (
      sessionMetadataConsented &&
      dataSyncLevelAllowsTranscripts(deps.getDataSyncLevel())
    );
  }
  return sessionMetadataConsented;
}

/**
 * Start every cloud sync lane, including the burn-down sampler.
 *
 * Lives here rather than as four calls at the application's own start site so
 * the roster has ONE lifecycle owner: a lane added to {@link DesktopSyncLanes}
 * and forgotten here fails typecheck at the destructure below instead of
 * silently never running, which is invariant 9's worst failure mode
 * (`main/sync/AGENTS.md`) — a lane that never runs cannot dead-letter, retry, or
 * report.
 */
export function startDesktopSyncLanes(
  lanes: DesktopSyncLanes,
  options: { historicalBackfill?: boolean }
): void {
  const {
    agentSessionSync,
    agentComponentInvocationSync,
    claudeCodeTelemetrySync,
    syncBurndownReporter,
  } = lanes;
  agentSessionSync.start(options);
  agentComponentInvocationSync.start();
  claudeCodeTelemetrySync.start();
  syncBurndownReporter.start();
}

/** Stop every cloud sync lane. The exact inverse of {@link startDesktopSyncLanes}. */
export function stopDesktopSyncLanes(lanes: DesktopSyncLanes): void {
  const {
    agentSessionSync,
    agentComponentInvocationSync,
    claudeCodeTelemetrySync,
    syncBurndownReporter,
  } = lanes;
  agentSessionSync.stop();
  agentComponentInvocationSync.stop();
  claudeCodeTelemetrySync.stop();
  syncBurndownReporter.stop();
}

/** Nudge every identity/readiness-sensitive write lane after a shared gate changes. */
export function refreshDesktopSyncWriteLanes(lanes: DesktopSyncLanes): void {
  lanes.agentSessionSync.refresh();
  lanes.agentComponentInvocationSync.refresh();
}

/**
 * The session-metadata egress gate. The session and invocation-part lanes
 * open on it.
 */
function sessionMetadataLaneReady(deps: DesktopSyncLaneDeps): boolean {
  return (
    deps.isHttpAgentSessionSyncReady() &&
    deps.isSessionMetadataSyncTierAllowed()
  );
}

function sessionProjectionLaneReady(deps: DesktopSyncLaneDeps): boolean {
  return (
    sessionMetadataLaneReady(deps) && deps.isInitialSessionProjectionReady()
  );
}
