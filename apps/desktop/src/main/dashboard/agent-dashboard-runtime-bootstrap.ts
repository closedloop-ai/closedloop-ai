import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { app, Notification } from "electron";
import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../shared/agent-monitor-status.js";
import type { AgentSessionSyncService } from "../agent-sync/agent-session-sync-service.js";
import type { AuditService } from "../audit/audit-service.js";
import {
  buildAgentMonitorFailureStatus,
  buildMigrationFailureTelemetryError,
} from "../lifecycle/migration-refusal.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { RequiredPluginInstaller } from "../packs/required-plugin-installer.js";
import { runScheduledReviewThroughAuditService } from "../scheduler/scheduled-review-runner.js";
import type { GoldenModeConfig } from "../settings/golden-mode.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import type { TranscriptSyncService } from "../transcript-sync/transcript-sync-service.js";
import type { DesktopWindow } from "../window.js";
import type { AgentDashboardDesignSystemRuntime } from "./agent-dashboard-design-system-runtime.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";

/**
 * Everything the Agent Dashboard DB/collector runtime needs from the
 * application. Split into collaborators (passed by reference) and live
 * accessors/mutators for the application state the runtime drives.
 */
export type AgentDashboardRuntimeBootstrapDeps = {
  goldenMode: GoldenModeConfig | null;
  desktopWindow: DesktopWindow;
  rendererGates: RendererReadinessGates;
  settingsStore: SettingsStore;
  appOtelRuntime: DesktopOtelRuntime;
  agentSessionSync: AgentSessionSyncService;
  requiredPluginInstaller: RequiredPluginInstaller;
  getAuditService: () => AuditService;
  getTranscriptSync: () => TranscriptSyncService | null;

  getApiKey: () => string | null;
  getAccessToken: () => Promise<string | null>;
  hasDesktopSessionAuth: () => boolean;
  getSessionIdentity: () => {
    userId: string;
    organizationId: string;
  } | null;
  invalidateAccessToken: () => void;
  getApiOrigin: () => string;
  getProfileId: () => string;
  getTraceCommentComputeTargetId: () => string | null;
  getSyncComputeTargetId: () => string | null;
  getUserIdentity: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  /** ISS-6243: subscribe to transitions of the identity `getUserIdentity` reads. */
  subscribeUserIdentityChanged: (listener: () => void) => () => void;
  isSessionSyncAllowed: () => boolean;
  isSyncActivityChunkingSupported: () => boolean;
  notifySessionTerminal: (notice: {
    sessionId: string;
    status: string;
  }) => void;
  onTerminalFailure: (reason: string) => void;
  refreshTrayState: () => void;
  setAgentMonitorRuntimeStatus: (status: AgentMonitorRuntimeStatus) => void;
  setAgentMonitorFailed: (reason: string) => void;
  registerDisabledAgentDashboardDbIpcHandlers: () => void;
  clearDisabledAgentDashboardDbIpcRegistered: () => void;
  /** Wire the durable org-directory snapshot store before the runtime opens. */
  configureOrgDirectoryPersistence: () => Promise<void>;
};

/** The outcome of one runtime bootstrap attempt. */
export type AgentDashboardRuntimeBootstrapResult =
  | { ok: true; runtime: AgentDashboardDesignSystemRuntime }
  | { ok: false };

/**
 * Create and start the Agent Dashboard design-system runtime (local SQLite DB +
 * collectors + DB IPC).
 *
 * The caller owns the "already created" / "terminally failed" latches, and
 * installs the runtime's DB IPC handlers once it has adopted the returned
 * runtime; this only performs one attempt and reports its outcome. On failure it
 * has already logged the raw detail, classified the failure into the
 * renderer-facing status, emitted the single app-exception telemetry event,
 * notified the user, refreshed the tray, and re-registered the disabled DB IPC
 * handlers.
 */
export async function bootstrapAgentDashboardRuntime(
  deps: AgentDashboardRuntimeBootstrapDeps
): Promise<AgentDashboardRuntimeBootstrapResult> {
  const { createAgentDashboardDesignSystemRuntime } = await import(
    "./agent-dashboard-design-system-runtime.js"
  );
  // FEA-3457: wire the durable org-directory store so the Branches/Sessions
  // "Owner" column rehydrates from the last-known `GET /users` snapshot on
  // cold start (and survives an offline session) instead of reading blank
  // until a live fetch lands. Identity-scoped inside the cache layer, so a
  // prior account's directory is never rehydrated for a different account.
  await deps.configureOrgDirectoryPersistence();
  let runtime: AgentDashboardDesignSystemRuntime;
  try {
    deps.clearDisabledAgentDashboardDbIpcRegistered();
    runtime = await createAgentDashboardDesignSystemRuntime(
      buildRuntimeOptions(deps)
    );
  } catch (error) {
    reportRuntimeBootstrapFailure(deps, error);
    return { ok: false };
  }
  // ISS-4714: the local DB runtime came up — advance the first-class status
  // to "ready" so the renderer clears any prior degraded/starting treatment.
  deps.setAgentMonitorRuntimeStatus(READY_AGENT_MONITOR_RUNTIME_STATUS);
  // ISS-4428: the required-plugin retry is NOT fired here — on a fresh DB
  // `pack_catalog` is seeded later by deferred maintenance, so a retry now
  // would hit an unseeded catalog (ENOTFOUND → failed) and never reconcile
  // again. It is driven by the runtime's `onCatalogSeeded` callback instead.
  return { ok: true, runtime };
}

/**
 * A boot-time DB failure (migration refusal, checksum drift, a DB created by a
 * NEWER build) is TERMINAL for this process. Log the raw detail, classify it for
 * the renderer, emit ONE low-cardinality telemetry event, tell the user, and
 * leave DB IPC disabled — no crash loop, no data loss.
 */
function reportRuntimeBootstrapFailure(
  deps: AgentDashboardRuntimeBootstrapDeps,
  error: unknown
): void {
  const reason = error instanceof Error ? error.message : String(error);
  // Log the full detail (may include paths, SQL, checksums, migration
  // names); show the user only a stable, sanitized message keyed by the
  // failure kind.
  gatewayLog.error(
    "agent-monitor",
    `failed to initialize Agent Monitor runtime: ${reason}`
  );
  // ISS-4714: classify the failure into the first-class runtime status the
  // renderer branches on (the DB-ahead-of-app case — a migration this build
  // doesn't include, i.e. a DB created by a NEWER build — sets `dbAhead` so
  // the renderer shows a prominent "update required" state rather than
  // silently running with dead local sync). The mapping lives in the
  // boot-safe lifecycle module so its tests own it.
  const status = buildAgentMonitorFailureStatus(error);
  deps.setAgentMonitorRuntimeStatus(status);
  const userMessage = status.reason ?? "";
  deps.setAgentMonitorFailed(userMessage);
  // ISS-4714: emit ONE structured telemetry event for the failure through
  // the established app-exception path. The RAW error is unsafe here — a
  // migration refusal's message/stack carries the offending migration name
  // (and checksum fragments) that the exception sanitizer does not redact,
  // which would leak names and make cardinality data-dependent. Emit a
  // STABLE, low-cardinality projection instead (fixed per-kind message,
  // stable type tag, no stack); the raw detail already went to the logs
  // above. The caller's re-entry latch keeps this to one emit per boot.
  deps.appOtelRuntime.emitAppExceptionEvent({
    error: buildMigrationFailureTelemetryError(error),
    origin: AppExceptionOrigin.Main,
  });
  // Surface a boot-time DB failure (e.g. migration-runner refusal on
  // checksum drift or a downgraded app) to the user. The DB is left
  // closed and DB IPC is disabled below — no crash loop, no data loss.
  new Notification({
    title: "Closedloop Agent Monitor",
    body: userMessage,
  }).show();
  deps.refreshTrayState();
  deps.registerDisabledAgentDashboardDbIpcHandlers();
}

/** The runtime's option bag — all lazy accessors over live application state. */
function buildRuntimeOptions(
  deps: AgentDashboardRuntimeBootstrapDeps
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    userDataPath: app.getPath("userData"),
    golden: deps.goldenMode,
    getWindow: () => deps.desktopWindow.getWindow(),
    isTrustedSender: (sender) => deps.desktopWindow.isTrustedSender(sender),
    whenInitialDashboardDataServed: () =>
      deps.rendererGates.whenInitialDashboardDataServed(),
    whenInitialBackgroundWorkAllowed: () =>
      deps.rendererGates.whenInitialDashboardBackgroundWorkAllowed(),
    waitForRendererBackgroundSlot: () =>
      deps.rendererGates.waitForRendererBackgroundSlot(),
    // ISS-4711: the DATA_REVISION rebuild's adaptive per-write pause gate
    // — full pause while the renderer is actively reading, idle fast
    // path (no flat 50ms floor) otherwise. Reads the max of the last
    // trusted DB IPC read and the last user-input event (the same
    // user-input signal that backs waitForRendererBackgroundSlot).
    hasRecentRendererRead: () => deps.rendererGates.hasRecentRendererRead(),
    // ISS-4711: stamp renderer activity on every trusted DB IPC read so
    // the gate above stays true for hands-off-keyboard polling/auto-
    // refresh reads, not just mouse/keyboard input.
    onRendererDbRead: () => deps.rendererGates.notifyRendererDbRead(),
    onFirstDbIpcServed: () =>
      deps.rendererGates.notifyInitialDashboardDataServed(),
    onInitialCollectorImportComplete: () =>
      deps.rendererGates.notifyInitialCollectorImportComplete(),
    // ISS-4428: retry catalog-deferred required-plugin distributions.
    onCatalogSeeded: () => deps.requiredPluginInstaller.notifyRuntimeReady(),
    // Still feeds org-directory warming; branch cloud hydration keeps
    // it only as the legacy fallback (session-first since PLN-1535 M3);
    // the cloud trace-comment lanes are session-only (PLN-1437 Phase 4a).
    getApiKey: () => deps.getApiKey(),
    // FEA-3425: session credential for cloud trace-comment reads/writes
    // and the parent-session pre-sync (session-only since Phase 4a).
    // PLN-1535 M3: also the primary credential for branch cloud
    // hydration.
    getAccessToken: () => deps.getAccessToken(),
    hasDesktopSessionAuth: () => deps.hasDesktopSessionAuth(),
    // PR #3994 review P0: the session ACCOUNT identity that gates and
    // scopes branch cloud hydration's session lane. Non-null during
    // boot restore too (the stored session is set before its refresh),
    // so an offline start still reads its own persisted overlays.
    getSessionIdentity: () => deps.getSessionIdentity(),
    invalidateAccessToken: () => deps.invalidateAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
    getProfileId: () => deps.getProfileId(),
    getComputeTargetId: () => deps.getTraceCommentComputeTargetId(),
    // FEA-3659: online-aware compute target (null when offline) for the
    // data-revision sync-outbox enqueue. Mirrors the sync service's
    // getSyncComputeTargetId so the enqueue and the read side agree on
    // the source key; never the stale lastComputeTargetId fallback that
    // getTraceCommentComputeTargetId uses for offline artifact reads.
    getSyncComputeTargetId: () => deps.getSyncComputeTargetId(),
    // ISS-4546: feed the ids the
    // data-revision rebuild just enqueued into the durable outbox into the
    // sync service's LIVE backfill queue, so they reach the cloud this
    // session instead of waiting for the next restart's hydration. The
    // service's injectBackfillIds is dedup-safe, hydration-first, and
    // identity-matched on the captured capturedSourceKey (PR #4098 review).
    injectSyncBackfillIds: (ids, capturedSourceKey) =>
      deps.agentSessionSync.injectBackfillIds(ids, capturedSourceKey),
    // Goal stage 3: tee the post-write emit of the collector import into the
    // sync pump so work-arrival schedules a pass immediately (the 5s timer is
    // now a fallback sweep). Coalescing lives in the service; this stays a
    // plain fire-and-forget nudge.
    //
    // Wording note, and it is load-bearing: the rule against writing the bare
    // word import next to a quote is in apps/desktop/AGENTS.md and gated by
    // `no-esm-shim-import-quote`. What is local to HERE is where the bogus
    // match would end — the apostrophe in the FEA-4169 note a few lines below,
    // which puts the CommonJS shim INSIDE this object literal and fails the
    // build in esbuild-transpile.
    onLocalSessionDataChanged: () =>
      deps.agentSessionSync.notifyLocalSessionActivity(),
    getUserIdentity: () => deps.getUserIdentity(),
    // ISS-6243: the db host caches this identity and can only be told about a
    // change — a cold-start `/me` landing, an org switch, a sign-out — through
    // this subscription. Without it the child keeps the boot snapshot, which is
    // null by construction, and stamps a null owner on every session it writes.
    subscribeUserIdentityChanged: (listener) =>
      deps.subscribeUserIdentityChanged(listener),
    // FEA-4169: gate the trace-comment recovery path's parent-session
    // pre-sync on the SAME org-policy+consent predicate the bulk session
    // lane uses, so a missing-session 404 retry never posts the local
    // parent SESSION to /desktop/agent-sessions/sync for a policy-off (or
    // not-yet-consented) org. Read live so a policy/tier flip is honored
    // on the next recovery attempt.
    isSessionSyncAllowed: () => deps.isSessionSyncAllowed(),
    // ISS-4578 (P1 #10): thread the negotiated activity-chunking
    // capability into the trace-comment recovery path so its
    // parent-session pre-sync paginates an oversized activity tiling
    // across chunks exactly as the bulk sync lane does, rather than always
    // keeping the full tiling in the base. Mirrors the lane's own probe;
    // read live so a hello-ack re-negotiation is honored on the next
    // recovery attempt.
    isSyncActivityChunkingSupported: () =>
      deps.isSyncActivityChunkingSupported(),
    // FEA-3741 (slice 1): feed the per-tool collector enable toggles
    // (default ON) into the collector runtime so a disabled harness
    // never starts its watcher or tool-home walk. Resolved fresh at each
    // collector (re)start; a toggle flip restarts collectors.
    getCollectorEnabledState: () =>
      deps.settingsStore.getCollectorEnabledState(),
    // FEA-1997: route IPC perf wide events through the desktop OTel
    // runtime (sampled spans; no-op when the SDK is disabled/not started).
    emitIpcPerf: (input) => deps.appOtelRuntime.emitIpcPerfEvent(input),
    // ISS-5103: route import-health counters through the desktop OTel runtime
    // (log records over the relay; no-op when the SDK is disabled/not started).
    emitImportHealth: (input) =>
      deps.appOtelRuntime.emitImportHealthEvent(input),
    onTerminalFailure: (reason) => deps.onTerminalFailure(reason),
    onSessionTerminal: (notice) => deps.notifySessionTerminal(notice),
    // FEA-4143: run a scheduled review the db-host daemon proxied to
    // main. Composed through the SAME AuditService the on-demand Audit
    // view uses (getAuditService()), so the scheduled and on-demand paths
    // share one composition — workspace safety (throwaway copy, never the
    // live checkout), the credential boundary (token resolved main-side,
    // never crossing to the child/sub-sessions), and local≡scheduled
    // parity are inherited, not re-implemented.
    onRunScheduledReview: (request) =>
      runScheduledReviewThroughAuditService(deps.getAuditService(), request),
    // FEA-2715: forward Claude hook events to the transcript lane so an
    // active session's transcript flushes on Stop/quiescence (AC4),
    // ahead of the 30-min discovery sweep. No-op when the flag is off.
    onTranscriptHookEvent: (hookType, data) =>
      deps.getTranscriptSync()?.enqueueClaudeHook({
        hookType,
        sessionId:
          typeof data.session_id === "string" ? data.session_id : undefined,
        transcriptPath:
          typeof data.transcript_path === "string"
            ? data.transcript_path
            : undefined,
      }),
    // FEA-3640: the watcher-channel twin of the hook forward above. Both
    // land on the SAME shared activity debounce inside the service, so
    // the ~5 min live flush is one mechanism for every harness instead of
    // a Claude-only path that left watcher harnesses on the 30-min sweep.
    onLiveTranscriptActivity: (
      harness,
      externalSessionId,
      sourcePath,
      changedPaths
    ) =>
      deps.getTranscriptSync()?.enqueueActivity({
        harness,
        externalSessionId,
        sourcePath,
        ...(changedPaths ? { changedPaths } : {}),
      }),
    log: (scope, message) => gatewayLog.info(scope, message),
  };
}
