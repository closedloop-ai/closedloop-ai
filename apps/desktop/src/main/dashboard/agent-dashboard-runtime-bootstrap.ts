import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { app, Notification } from "electron";
import type { AgentMonitorRuntimeStatus } from "../../shared/agent-monitor-status.js";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../shared/agent-monitor-status.js";
import { isStoreOpenTimeoutError } from "../../shared/transient-db-host-error.js";
import type { AgentComponentInvocationSyncService } from "../agent-sync/agent-component-invocation-sync-service.js";
import type { AgentSessionSyncService } from "../agent-sync/agent-session-sync-service.js";
import type { SyncLaneBatchEmit } from "../agent-sync/sync-lane-cloud-health.js";
import {
  buildAgentMonitorFailureStatus,
  buildMigrationFailureTelemetryError,
  classifyBootFailureKind,
} from "../lifecycle/migration-refusal.js";
import type { RendererReadinessGates } from "../lifecycle/renderer-readiness-gates.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { RequiredPluginInstaller } from "../packs/required-plugin-installer.js";
import type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";
import type { SessionMeshHookSink } from "../session-mesh/session-mesh-hook-contract.js";
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
  onSessionMeshHookEvent?: SessionMeshHookSink;
  onSessionMeshReady?: () => void;
  goldenMode: GoldenModeConfig | null;
  desktopWindow: DesktopWindow;
  rendererGates: RendererReadinessGates;
  settingsStore: SettingsStore;
  appOtelRuntime: DesktopOtelRuntime;
  /**
   * ISS-11426: a second reader of the SAME batch events `emitSyncBatch` carries,
   * for the one refusal reason a user can act on. Wired here rather than at the
   * lane because this binding is what the transcript lane reaches
   * `emitSyncBatchEvent` through.
   */
  observeSyncBatch?: SyncLaneBatchEmit;
  agentSessionSync: AgentSessionSyncService;
  agentComponentInvocationSync: AgentComponentInvocationSyncService;
  requiredPluginInstaller: RequiredPluginInstaller;
  getTranscriptSync: () => TranscriptSyncService | null;

  getApiKey: () => string | null;
  getAccessToken: () => Promise<string | null>;
  getAccountAdmission: () => DesktopAccountAdmission | null;
  /**
   * ISS-10533: whether the desktop is GENUINELY signed out, as opposed to
   * merely identity-less — see the option of the same name on
   * `AgentDashboardDesignSystemRuntimeOptions`.
   */
  isDesktopSessionSignedOut: () => boolean;
  getApiOrigin: () => string;
  getCloudReadComputeTargetId: () => string | null;
  getSyncComputeTargetId: () => string | null;
  getUserIdentity: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  /** ISS-6243: subscribe to transitions of the identity `getUserIdentity` reads. */
  subscribeUserIdentityChanged: (listener: () => void) => () => void;
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
  /**
   * ISS-9197 — has app teardown begun?
   *
   * Required, not optional, and that is the point: the retry ladder below
   * schedules work on the wall clock, and `runDesktopApplicationShutdown` cannot
   * stop it. Shutdown reaches the runtime only through
   * `getAgentDashboardRuntime()`, which reads a field that stays null for the
   * whole ladder — so a bootstrap still running at teardown is invisible to it,
   * and a later attempt would fork a db-host `utilityProcess` into a quitting
   * main process and then fire a `Notification` and a tray refresh at objects
   * the teardown already destroyed. `apps/desktop/AGENTS.md` names this class
   * directly: an async runtime-startup continuation must not restart dependent
   * subsystems after shutdown. A required dep makes an unwired caller a
   * typecheck failure rather than a silent one.
   *
   * Read on both sides of each open, never once: before, so no new attempt
   * starts into a quit; after, so an attempt that was already in flight closes
   * what it opened instead of handing it back to be published (whitlockk, #6665).
   */
  isShuttingDown: () => boolean;
  /**
   * ISS-9197 — test-only seam over the store-open retry backoff, so a suite can
   * drive the ladder without waiting out real minutes. Undefined in production,
   * where {@link sleep} runs. Mirrors the `fork?` seam in
   * `agent-dashboard-db-host-lifecycle.ts`: the point is that the REAL retry
   * loop runs and the REAL classification decides, with only the wall clock
   * replaced.
   */
  sleepBeforeStoreOpenRetry?: (ms: number) => Promise<void>;
};

/**
 * The outcome of a runtime bootstrap, once the store-open retry ladder has
 * settled — an open, a failure that was reported, or an abandonment because
 * teardown began mid-ladder OR mid-open (in which case the runtime that opened
 * has already been closed here). Not the outcome of one attempt: ISS-9197 made
 * this up to {@link STORE_OPEN_RETRY_BACKOFF_MS}.length + 1 of them.
 */
export type AgentDashboardRuntimeBootstrapResult =
  | { ok: true; runtime: AgentDashboardDesignSystemRuntime }
  | { ok: false };

/**
 * Create and start the Agent Dashboard design-system runtime (local SQLite DB +
 * collectors + DB IPC).
 *
 * The caller owns the "already created" / "terminally failed" latches, and
 * installs the runtime's DB IPC handlers once it has adopted the returned
 * runtime. On failure it has already logged the raw detail, classified the
 * failure into the renderer-facing status, emitted the single app-exception
 * telemetry event, notified the user, refreshed the tray, and re-registered the
 * disabled DB IPC handlers.
 *
 * ISS-9197: this used to perform exactly ONE attempt, and that is still true of
 * every failure except one. A store-open DEADLINE is now retried on
 * {@link STORE_OPEN_RETRY_BACKOFF_MS} before it is reported, because it is the
 * only open failure that is not a property of the store's contents — see
 * `isStoreOpenTimeoutError`. Everything else still leaves on its first failure,
 * so the terminal-no-retry policy the reporter documents is unchanged for the
 * failures it was written against. Whichever attempt reports, it reports ONCE,
 * so the caller's one-emit-per-boot cardinality contract still holds — and a
 * ladder that RECOVERS spends that one emit rather than telling the fleet
 * nothing, which is what {@link reportRecoveredStoreOpenTimeout} exists for.
 */
export async function bootstrapAgentDashboardRuntime(
  deps: AgentDashboardRuntimeBootstrapDeps
): Promise<AgentDashboardRuntimeBootstrapResult> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < STORE_OPEN_RETRY_BACKOFF_MS.length + 1;
    attempt += 1
  ) {
    // ISS-9197: re-read teardown on EVERY attempt, not once before the ladder.
    // The whole point of a retry is that it resumes after a wait, and the app
    // can quit inside that wait — the ticket's own scenario, a user watching a
    // dead dashboard, makes it likely rather than theoretical. Forking a db-host
    // into a quitting main process is the failure this guards.
    if (deps.isShuttingDown()) {
      return { ok: false };
    }
    try {
      const runtime = await openAgentDashboardRuntime(deps);
      // whitlockk (#6665): re-read teardown AFTER the open too, not only before it.
      // The guard above stops a new attempt from starting into a quit; this one
      // stops an attempt that was ALREADY in flight from handing back what it
      // opened. An open can take the whole `STORE_OPEN_DEADLINE_MS`, and
      // shutdown reaches this runtime only through the caller's
      // `getAgentDashboardRuntime()`, which stays null until the caller adopts
      // the return value below — so BOTH of teardown's lookups (`beginClosing`,
      // then `close`) miss a runtime that resolves mid-teardown, and the caller
      // then publishes a db-host `utilityProcess` and its DB IPC handlers into a
      // process that has already quit, with nothing left to close either.
      //
      // One guard is enough for the remaining window. From here to the caller's
      // `this.agentDashboardDesignSystem = result.runtime` there is no `await`
      // — one microtask hop — and `shuttingDown` is set from the `before-quit`
      // handler, a macrotask, which cannot land inside it.
      if (deps.isShuttingDown()) {
        await closeAbandonedRuntime(runtime);
        return { ok: false };
      }
      // ISS-4714: the local DB runtime came up — advance the first-class status
      // to "ready" so the renderer clears any prior degraded/starting treatment.
      deps.setAgentMonitorRuntimeStatus(READY_AGENT_MONITOR_RUNTIME_STATUS);
      if (attempt > 0) {
        // Only a store-open timeout reaches a second attempt — every other
        // failure `break`s below — so an open on attempt 2+ is by construction
        // a deadline that CLEARED.
        reportRecoveredStoreOpenTimeout(deps, attempt);
      }
      // ISS-4428: the required-plugin retry is NOT fired here — on a fresh DB
      // `pack_catalog` is seeded later by deferred maintenance, so a retry now
      // would hit an unseeded catalog (ENOTFOUND → failed) and never reconcile
      // again. It is driven by the runtime's `onCatalogSeeded` callback instead.
      return { ok: true, runtime };
    } catch (error) {
      lastError = error;
      // ISS-9197: the classification decides, and it decides FIRST. A corrupt
      // file, a migration refusal and a schema mismatch reproduce on every
      // attempt, so retrying them is the crash loop `reportRuntimeBootstrapFailure`
      // was written to avoid; they leave here on the first failure exactly as
      // they did before this ticket.
      if (!isStoreOpenTimeoutError(error)) {
        break;
      }
      const backoffMs = STORE_OPEN_RETRY_BACKOFF_MS.at(attempt);
      if (backoffMs === undefined) {
        break;
      }
      gatewayLog.warn(
        "agent-monitor",
        `store open exceeded its deadline (attempt ${attempt + 1} of ${STORE_OPEN_RETRY_BACKOFF_MS.length + 1}); retrying in ${backoffMs}ms`
      );
      await (deps.sleepBeforeStoreOpenRetry ?? sleep)(backoffMs);
    }
  }
  // ISS-9197: the report is skipped for the same reason the attempt is. It shows
  // an OS `Notification`, refreshes the tray, and re-registers DB IPC — all
  // against objects `runDesktopApplicationShutdown` may already have destroyed,
  // and there is no one left to tell. Only the teardown case is silent; every
  // other exhaustion still reports exactly as before.
  if (deps.isShuttingDown()) {
    return { ok: false };
  }
  reportRuntimeBootstrapFailure(deps, lastError);
  return { ok: false };
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
  // ISS-8907: the raw `error`, not the stabilized projection above — the
  // projection is a fresh `Error` and carries neither the refusal type nor the
  // Node `code` the classification reads. This is the dimension that separates a
  // fleet-wide packaging break (ISS-8906) from a one-off local store fault, both
  // of which reach Datadog as this one event.
  // ISS-9259: the outcome is read off the emit SITE, not off the error. This
  // function is only ever reached after the ladder is spent, so `failed` is a
  // property of arriving here at all — while `reportRecoveredStoreOpenTimeout`
  // is only reached from an open that succeeded. No predicate over the error
  // could tell them apart: both carry the same kind, by design.
  deps.appOtelRuntime.emitAppExceptionEvent({
    error: buildMigrationFailureTelemetryError(error),
    origin: AppExceptionOrigin.Main,
    bootFailureKind: classifyBootFailureKind(error),
    bootFailureOutcome: AppBootFailureOutcome.Failed,
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
    onSessionMeshHookEvent: deps.onSessionMeshHookEvent,
    onSessionMeshReady: deps.onSessionMeshReady,
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
    getApiKey: () => deps.getApiKey(),
    getAccessToken: () => deps.getAccessToken(),
    getAccountAdmission: () => deps.getAccountAdmission(),
    // ISS-10533: whether a null identity means "nobody" or "not yet / not
    // any more".
    isDesktopSessionSignedOut: () => deps.isDesktopSessionSignedOut(),
    getApiOrigin: () => deps.getApiOrigin(),
    getComputeTargetId: () => deps.getCloudReadComputeTargetId(),
    // FEA-3659: the identity-scoped compute target for the data-revision
    // sync-outbox enqueue AND the Sessions list's pending-outbox read. It is
    // the sync service's own getSyncComputeTargetId, so both sides key on
    // whatever the lane actually sent under; never the stale
    // lastComputeTargetId fallback that getCloudReadComputeTargetId uses
    // for offline artifact reads. ISS-8691: that target may now be retained
    // across a socket drop, so this is no longer null merely because we are
    // offline — it is null when no target is attributable to this account.
    getSyncComputeTargetId: () => deps.getSyncComputeTargetId(),
    // ISS-11427: the session lane's own classification of a set-aside row, so
    // the Sessions reads can report it instead of a false `synced`.
    readSessionDeadLetterState: (id) =>
      deps.agentSessionSync.readDeadLetterState(id),
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
    onLocalSessionDataChanged: () =>
      deps.agentSessionSync.notifyLocalSessionActivity(),
    onInitialSessionProjectionReady: () => {
      deps.agentSessionSync.refresh();
      deps.agentComponentInvocationSync.refresh();
    },
    getUserIdentity: () => deps.getUserIdentity(),
    // ISS-6243: the db host caches this identity and can only be told about a
    // change — a cold-start `/me` landing, an org switch, a sign-out — through
    // this subscription. Without it the child keeps the boot snapshot, which is
    // null by construction, and stamps a null owner on every session it writes.
    subscribeUserIdentityChanged: (listener) =>
      deps.subscribeUserIdentityChanged(listener),
    // FEA-3741 (slice 1): feed the per-tool collector enable toggles
    // (default ON) into the collector runtime so a disabled harness
    // never starts its watcher or tool-home walk. Resolved fresh at each
    // collector (re)start; a toggle flip restarts collectors.
    getCollectorEnabledState: () =>
      deps.settingsStore.getCollectorEnabledState(),
    // ISS-7352: the closed-by-default gate on persisting Claude Code's OTel
    // signals. Read per export, not snapshotted, so turning it off stops
    // capture immediately rather than at the next collector restart.
    isClaudeCodeOtelCaptureEnabled: () =>
      deps.settingsStore.getClaudeCodeOtelCaptureEnabled(),
    // FEA-1997: route IPC perf wide events through the desktop OTel
    // runtime (sampled spans; no-op when the SDK is disabled/not started).
    emitIpcPerf: (input) => deps.appOtelRuntime.emitIpcPerfEvent(input),
    // ISS-5103: route import-health counters through the desktop OTel runtime
    // (log records over the relay; no-op when the SDK is disabled/not started).
    emitImportHealth: (input) =>
      deps.appOtelRuntime.emitImportHealthEvent(input),
    // ISS-6338: route a lane's per-batch cloud health through the same
    // runtime. Its exporter is the keyless relay leg, so this survives the auth
    // loss that would silence the lane in the first place.
    emitSyncBatch: (input) => {
      deps.appOtelRuntime.emitSyncBatchEvent(input);
      deps.observeSyncBatch?.(input);
    },
    onTerminalFailure: (reason) => deps.onTerminalFailure(reason),
    // davetho (#6432): the SAME publisher this module uses for a boot-time
    // failure, handed to the runtime so a failure that lands AFTER `ready` —
    // the restart-ladder exhaustion — reaches `desktop:get-runtime-status`
    // through one owner rather than a second derivation of the status.
    setAgentMonitorRuntimeStatus: (status) =>
      deps.setAgentMonitorRuntimeStatus(status),
    onSessionTerminal: (notice) => deps.notifySessionTerminal(notice),
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

/**
 * ISS-9197 — the backoff ladder for a store-open TIMEOUT, and only that failure.
 *
 * Two retries, three attempts. The bound is what makes this safe to add to a
 * path whose whole doctrine was terminal-no-retry: the crash-loop concern that
 * motivated `reportRuntimeBootstrapFailure` is real, and it is answered by the
 * classification (a deterministic failure never reaches this ladder) plus this
 * ceiling (a timeout that is really a permanent condition exhausts it and lands
 * in the same terminal state it lands in today).
 *
 * The delays are short relative to `STORE_OPEN_DEADLINE_MS` (10 min) on purpose:
 * the retry's real gap is the failed attempt itself, and these only add enough
 * to let a load spike pass. What actually makes a retry likely to succeed is not
 * the wait — it is that the migrations committed on the attempt that timed out,
 * so a second attempt skips them. That is the observed trigger: ISS-9197's
 * install crossed the ceiling on the boot where two new migrations landed, and
 * had cleared the same open in 8m05s and 7m38s without them.
 *
 * NOT a re-tune of `STORE_OPEN_DEADLINE_MS`. Raising that number moves the cliff
 * without removing it, and the margin shrinks monotonically as a store grows —
 * the store here was 2.43 GiB.
 */
const STORE_OPEN_RETRY_BACKOFF_MS: readonly number[] = [30_000, 120_000];

/** One bootstrap attempt: resolve the runtime module, wire it, open the store. */
async function openAgentDashboardRuntime(
  deps: AgentDashboardRuntimeBootstrapDeps
): Promise<AgentDashboardDesignSystemRuntime> {
  // ISS-8907: the module import and the org-directory wiring are INSIDE the
  // failure path, not above it. They used to sit outside, where a throw left
  // `bootstrapAgentDashboardRuntime` entirely — and its only caller
  // (`startAgentCapture`, via `app.ts`) answers that with a `.catch` that
  // writes one local log line and emits nothing. A module-resolution failure
  // of THIS import is the ISS-8906 shape exactly, and it was reaching no
  // telemetry at all: the specific invisibility this ticket exists to close,
  // one statement above the emit that closes it. Execution order is unchanged.
  const { createAgentDashboardDesignSystemRuntime } = await import(
    "./agent-dashboard-design-system-runtime.js"
  );
  // FEA-3457: wire the durable org-directory store so the Branches/Sessions
  // "Owner" column rehydrates from the last-known `GET /users` snapshot on
  // cold start (and survives an offline session) instead of reading blank
  // until a live fetch lands. Identity-scoped inside the cache layer, so a
  // prior account's directory is never rehydrated for a different account.
  await deps.configureOrgDirectoryPersistence();
  deps.clearDisabledAgentDashboardDbIpcRegistered();
  return await createAgentDashboardDesignSystemRuntime(
    buildRuntimeOptions(deps)
  );
}

/** The production backoff wait; replaced by `sleepBeforeStoreOpenRetry` in tests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Tear down a runtime that finished opening into a quitting process.
 *
 * The same `beginClosing()` → `close()` pair `runDesktopApplicationShutdown`
 * runs, in the same order, because this IS that teardown — it just has to run
 * here, since shutdown reads the runtime off a field the caller has not set yet
 * and so drained nothing.
 *
 * Its own errors are swallowed for two reasons: the process is already quitting,
 * so there is no one to tell; and a throw would escape into the retry loop's
 * `catch`, where a close failure would be classified as an OPEN failure — and a
 * message carrying the deadline token would start another attempt against a
 * torn-down app, which is the leak this function exists to close.
 */
async function closeAbandonedRuntime(
  runtime: AgentDashboardDesignSystemRuntime
): Promise<void> {
  try {
    runtime.beginClosing();
    await runtime.close();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gatewayLog.warn(
      "agent-monitor",
      `failed to close the runtime abandoned at shutdown: ${reason}`
    );
  }
}

/**
 * marisolashgrove (#6665) — report a store-open deadline that CLEARED.
 *
 * `app-boot-failure-kind.ts` states the contract this closes: `store_open_timeout`
 * is "the one boot failure a reader should expect to see recover, and the one
 * whose frequency across the fleet measures a margin that shrinks as stores
 * grow". Emitting only on exhaustion makes that false — the fleet's first data
 * point then arrives after an install has already been dark for the whole
 * ladder, which is the blindness ISS-9197 is closing one level up. The installs
 * that recover are the leading indicator, and two `gatewayLog.warn` lines on one
 * machine are not a fleet signal.
 *
 * The SAME event and the same kind as the exhaustion emit, deliberately, because
 * the monitor that counts this kind is what has to see it; a new event would
 * need a new monitor to be worth anything. What separates the two is
 * `app.boot_failure.outcome` (ISS-9259) — an ATTRIBUTE, not the message, so no
 * consumer has to regex a human-readable string to tell a healthy install from
 * a dead one: monitor 319264706 counted a recovered install as a boot failure
 * precisely because the message was the only thing separating the two. The
 * message still differs, and its only interpolands are ladder indices so its
 * cardinality is bounded by {@link STORE_OPEN_RETRY_BACKOFF_MS}.length, but it
 * is copy now rather than the discriminator. It does remain the half that
 * reaches Datadog from every build in the field, because the attribute half
 * lags on both axes: ISS-9253 vendored `app.boot_failure.kind`, which arrives
 * only once the collector is rolled (ISS-9677) and only from installs on
 * ISS-8907 or later, and `app.boot_failure.outcome` is parked behind that same
 * apply, so the exclusion keyed on it is inert until then.
 *
 * Still one emit per boot: a bootstrap either recovers or exhausts, never both.
 */
function reportRecoveredStoreOpenTimeout(
  deps: AgentDashboardRuntimeBootstrapDeps,
  attempt: number
): void {
  const attempts = STORE_OPEN_RETRY_BACKOFF_MS.length + 1;
  gatewayLog.warn(
    "agent-monitor",
    `store open recovered on attempt ${attempt + 1} of ${attempts}`
  );
  // No stack, for ISS-4714's reason unchanged: nothing but this fixed sentence
  // may ride along on the record.
  const recovered = new Error(
    `Agent Monitor runtime recovered from a store open deadline on attempt ${attempt + 1} of ${attempts}`
  );
  recovered.stack = undefined;
  deps.appOtelRuntime.emitAppExceptionEvent({
    error: recovered,
    origin: AppExceptionOrigin.Main,
    bootFailureKind: AppBootFailureKind.StoreOpenTimeout,
    bootFailureOutcome: AppBootFailureOutcome.Recovered,
  });
}
