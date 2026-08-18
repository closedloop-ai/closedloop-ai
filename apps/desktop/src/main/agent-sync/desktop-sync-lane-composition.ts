import { createAgentSessionPayloadWorkerPreparer } from "../agent-session-sync-payload-worker-runner.js";
import { DesktopAgentSessionsAckReason } from "../cloud/cloud-protocol.js";
import {
  type AgentComponentInvocationSyncClientResult,
  createDesktopAgentComponentInvocationsClient,
} from "../dashboard/desktop-agent-component-invocations-client.js";
import { createDesktopComponentsClient } from "../dashboard/desktop-components-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  SyncBurndownLogLevel,
  SyncBurndownReporter,
} from "../sync/sync-burndown-reporter.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import { DesktopSyncBatchOutcome } from "../telemetry/app-otel-runtime.js";
import { Observability } from "../telemetry/observability.js";
import { reportSyncLaneStall } from "../telemetry/sync-lane-stall-telemetry.js";
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
import { AgentSessionSyncService } from "./agent-session-sync-service.js";
import {
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "./agent-session-sync-source.js";
import { createDesktopAgentSessionsClient } from "./desktop-agent-sessions-client.js";
import { OrgSyncPolicyStore } from "./org-sync-policy-store.js";

/**
 * The live application state the cloud sync lanes read on every tick. Nothing
 * here is snapshotted: identity, connectivity, consent, and the local SQLite
 * sync source are all re-read so a lane self-heals as those change.
 */
export type DesktopSyncLaneDeps = {
  getAccessToken: () => Promise<string | null>;
  getApiKey: () => string | null;
  getApiOrigin: () => string;
  invalidateAccessToken: () => void;
  /** The relay compute target for the component lanes (null when offline). */
  getTranscriptComputeTargetId: () => string | null;
  /** Live compute target when cloud is online, else null (strict-online). */
  getOnlineComputeTargetId: () => string | null;
  isSessionMetadataSyncTierAllowed: () => boolean;
  isHttpAgentSessionSyncReady: () => boolean;
  isSyncCompressionSupported: () => boolean;
  isSyncActivityChunkingSupported: () => boolean;
  isSyncMonitoredActivitySupported?: () => boolean;
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
   * ISS-5387: is the trace-comment lane able to deliver? Composed in the Agent
   * Dashboard runtime rather than here, so like the transcript lane its gate has
   * to be passed in. Without it the burn-down cannot tell `idle_not_running`
   * from `drained` for the fifth lane.
   */
  isTraceCommentSyncRunning: () => boolean;
};

/** The cloud sync collaborators the application owns as fields. */
export type DesktopSyncLanes = {
  orgSyncPolicyStore: OrgSyncPolicyStore;
  agentSessionSync: AgentSessionSyncService;
  agentComponentInvocationSync: AgentComponentInvocationSyncService;
  /** ISS-5387: the read-only periodic burn-down sampler over all five lanes. */
  syncBurndownReporter: SyncBurndownReporter;
};

/**
 * Compose the cloud sync lanes and the org-policy gate cache they sit behind.
 *
 * All three lanes share one transport model: a first-party Desktop session
 * Bearer against the API origin, scoped to the hello-derived compute target.
 * Each is inert until its own gate opens (org policy AND consent tier AND live
 * session AND cloud online), so constructing them is always safe.
 */
export function createDesktopSyncLanes(
  deps: DesktopSyncLaneDeps
): DesktopSyncLanes {
  // ISS-5387: the burn-down reporter is constructed FIRST so the lane wiring
  // below can tee its existing send/telemetry hooks into it. Those tees are the
  // only way this observer learns a lane is active without adding a query to any
  // lane's hot path — an increment on a path that was already being called.
  const syncBurndownReporter = buildSyncBurndownReporter(deps);
  // Gap B (#2570 follow-up): component-inventory sync lane. Like the session
  // lane, the component inventory endpoint is a plain authenticated HTTP POST,
  // so this client mirrors the transcript control-plane transport (first-party
  // Bearer JWT + API origin) and targets the same relay compute target the
  // session cursor is scoped to.
  const componentsClient = createDesktopComponentsClient({
    getAccessToken: () => deps.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    getComputeTargetId: () => deps.getTranscriptComputeTargetId(),
  });
  const componentInvocationsClient =
    createDesktopAgentComponentInvocationsClient({
      getAccessToken: () => deps.getAccessToken(),
      getApiKey: () => deps.getApiKey(),
      getApiOrigin: () => deps.getApiOrigin(),
      getComputeTargetId: () => deps.getTranscriptComputeTargetId(),
    });
  // FEA-3425 (PLN-1437 Phase 4a): Lane-1 agent-session sync is HTTP-only.
  // With a live first-party Desktop session, agent-session batches POST to
  // /desktop/agent-sessions/sync under the session Bearer — the same
  // auth/transport model as the transcript and component lanes. The legacy
  // relay socket write path was retired once session coverage cleared the D7
  // no-strand gate, so there is a single transport now. Identity stays
  // hello-derived (D6): computeTargetId comes from the connected cloudStatus.
  const agentSessionsHttpClient = createDesktopAgentSessionsClient({
    getAccessToken: () => deps.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    onUnauthorized: () => deps.invalidateAccessToken(),
  });
  // FEA-4169: the outer org-policy gate cache. Reads sessionSyncPolicyEnabled
  // from GET /desktop/identity using the same first-party session auth as the
  // other account-scoped cloud reads. Refreshed on sign-in and cloud-online.
  const orgSyncPolicyStore = new OrgSyncPolicyStore({
    getFetchOptions: () => ({
      getAccessToken: () => deps.getAccessToken(),
      getApiOrigin: () => deps.getApiOrigin(),
    }),
  });
  const agentSessionSync = new AgentSessionSyncService({
    // PRD-532 §7: honor the sync-observability consent tier (no-op unless the
    // unified-auth-onboarding flag is on). FEA-4169: the org-policy outer gate
    // is ANDed inside isSessionMetadataSyncTierAllowed().
    isCloudSyncTierAllowed: () => deps.isSessionMetadataSyncTierAllowed(),
    // FEA-3425 (Phase 4a): HTTP-only. The lane ticks only when a first-party
    // session is live and the cloud is online (the relay socket write path was
    // retired once session coverage cleared the D7 no-strand gate).
    isHttpReady: () => deps.isHttpAgentSessionSyncReady(),
    // FEA-4138: only compress once the server advertised decompression.
    isSyncCompressionSupported: () => deps.isSyncCompressionSupported(),
    // ISS-4541: only paginate the activity-segment tiling across chunks once
    // the server advertised additive multi-part merge.
    isSyncActivityChunkingSupported: () =>
      deps.isSyncActivityChunkingSupported(),
    isSyncMonitoredActivitySupported: () =>
      deps.isSyncMonitoredActivitySupported?.() ?? false,
    sendBatch: (batch, sendOptions) => {
      const computeTargetId = deps.getOnlineComputeTargetId();
      if (computeTargetId) {
        return agentSessionsHttpClient.sendBatch(
          batch,
          computeTargetId,
          sendOptions
        );
      }
      // No identity yet — offline, or the command socket is mid-handshake so
      // the hello-derived computeTargetId (D6) has not landed. Defer with
      // backoff; never dead-letter (the HTTP client returns `Unauthenticated`
      // for the no-session case, which the sync service also treats as a
      // budget-free pause).
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
    getSyncComputeTargetId: () => deps.getOnlineComputeTargetId(),
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
    preparePayloads: createAgentSessionPayloadWorkerPreparer(),
    onBatchOutcome: (event) => {
      Observability.agentSessionSyncBatchFailed(event);
    },
    // FEA-1995: per-batch sync.* transport-health telemetry → OTel runtime.
    // Inert until the runtime reaches Started (and when OTEL_SDK_DISABLED).
    onSyncBatchTelemetry: (event) => {
      deps.appOtelRuntime.emitSyncBatchEvent(event);
      // ISS-5387 tee: the ONLY per-pass byte counter the session lane already
      // produces. Bytes are recorded for every outcome — a failed or
      // dead-lettered batch still spent them — which is what makes re-send
      // amplification legible against a barely-moving item count.
      syncBurndownReporter.recordSessionBatch({
        accepted: event.outcome === DesktopSyncBatchOutcome.Success,
        payloadBytes: event.payloadBytes,
      });
    },
  });
  const agentComponentInvocationSync = new AgentComponentInvocationSyncService({
    // FEA-3425 (Phase 4a): mirror Lane 1's HTTP-only readiness gate. The
    // former socket-capability flag (serverAgentSessionSyncSupported) was
    // retired with the socket write path, so this HTTP lane ticks on a live
    // session + connected cloud, same as agent-session sync.
    isReady: () =>
      deps.isHttpAgentSessionSyncReady() &&
      deps.isSessionMetadataSyncTierAllowed(),
    getSource: () =>
      resolveAgentComponentInvocationSyncSource(deps.getSyncSource()),
    getComputeTargetId: () => deps.getTranscriptComputeTargetId(),
    sendPart: async (part, computeTargetId) => {
      const result = await componentInvocationsClient.syncPart(
        part,
        computeTargetId
      );
      recordAcceptedInvocationPart(syncBurndownReporter, result);
      return result;
    },
    waitForBackgroundSlot: () => deps.waitForBackgroundSlot(),
    log: (message) => gatewayLog.info("component-invocation-sync", message),
  });
  return {
    orgSyncPolicyStore,
    agentSessionSync,
    agentComponentInvocationSync,
    syncBurndownReporter,
  };
}

/**
 * ISS-5387: build the read-only burn-down reporter over all five lanes.
 *
 * Every source key is resolved LIVE from the current compute target, exactly as
 * the lanes themselves resolve theirs, so a burn-down can never report one
 * account's queue while another account is signed in (`main/sync/AGENTS.md`
 * invariant 2). A null target yields a null key, which the store reads as "this
 * lane has no identity yet" rather than as an empty queue.
 *
 * The per-lane gates mirror each lane's own readiness predicate. That is what
 * keeps `idle_not_running` honest: a lane whose gate is shut has not delivered
 * anything, it has merely stopped trying, and it must never be reported as
 * caught up.
 */
function buildSyncBurndownReporter(
  deps: DesktopSyncLaneDeps
): SyncBurndownReporter {
  const sessionLaneReady = () =>
    deps.isHttpAgentSessionSyncReady() &&
    deps.isSessionMetadataSyncTierAllowed();
  return new SyncBurndownReporter({
    getSource: () => deps.getSyncSource(),
    getSessionSourceKey: () => {
      const computeTargetId = deps.getOnlineComputeTargetId();
      return computeTargetId
        ? buildAgentSessionSyncSourceKey(
            computeTargetId,
            deps.isSyncMonitoredActivitySupported?.() ?? false
          )
        : null;
    },
    getInvocationSourceKey: () => {
      const computeTargetId = deps.getTranscriptComputeTargetId();
      return computeTargetId
        ? buildAgentComponentInvocationSyncSourceKey(computeTargetId)
        : null;
    },
    invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    getTranscriptComputeTargetId: () => deps.getTranscriptComputeTargetId(),
    getComponentSourceKey: () => {
      const computeTargetId = deps.getTranscriptComputeTargetId();
      return computeTargetId
        ? buildAgentComponentSyncSourceKey(computeTargetId)
        : null;
    },
    isSessionLaneRunning: () =>
      sessionLaneReady() && deps.getOnlineComputeTargetId() !== null,
    isInvocationLaneRunning: () =>
      sessionLaneReady() && deps.getTranscriptComputeTargetId() !== null,
    isTranscriptLaneRunning: () => deps.isTranscriptSyncRunning(),
    isTraceCommentLaneRunning: () => deps.isTraceCommentSyncRunning(),
    isComponentLaneRunning: () =>
      sessionLaneReady() && deps.getTranscriptComputeTargetId() !== null,
    log: (level, message) => {
      if (level === SyncBurndownLogLevel.Warn) {
        gatewayLog.warn("sync-burndown", message);
        return;
      }
      gatewayLog.info("sync-burndown", message);
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
