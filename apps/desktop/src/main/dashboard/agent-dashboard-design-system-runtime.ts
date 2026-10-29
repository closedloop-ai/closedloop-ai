import type { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import { Harness } from "@repo/lib/harness/types";
import { app, ipcMain } from "electron";
import { AGENT_MONITOR_PORT } from "../../shared/contracts.js";
import { dropOnDbHostLifecycleError } from "../../shared/db-host-fire-and-forget.js";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import type { DesktopIngestProgressReport } from "../../shared/ingest-quarantine-contract.js";
import type { StreamRunResult } from "../../shared/install-run-contract.js";
import { isAgentMonitorHooksEnabled } from "../agent-monitor/agent-monitor-hooks.js";
import { AgentHookListener } from "../agent-monitor/agent-monitor-listener.js";
import { isClaudeLiveHookEnabled } from "../agent-monitor/claude-live-hook-flag.js";
import type { SyncLaneBatchEmit } from "../agent-sync/sync-lane-cloud-health.js";
import {
  type CollectorEnabledState,
  getActiveCollectionMode,
  type HooksInstalledState,
} from "../collectors/engine/collection-mode.js";
import { CollectorManager } from "../collectors/engine/collector-manager.js";
import {
  createE2eBootImportAbandonFault,
  e2eBootImportAbandonPasses,
} from "../collectors/engine/e2e-boot-import-abandon-seam.js";
import {
  E2E_PARSE_QUARANTINE_CONFIG,
  isE2eParseQuarantineEnabled,
} from "../collectors/engine/e2e-parse-quarantine-seam.js";
import {
  type FileAccessBlock,
  probeFileAccessBlocks,
} from "../collectors/engine/file-access-probe.js";
import { harnessScanRoots } from "../collectors/engine/harness-scan-roots.js";
import { createMutualExclusivityMonitor } from "../collectors/engine/mutual-exclusivity-monitor.js";
import { createUtilityProcessHistoricalParseRunner } from "../collectors/engine/utility-process-historical-parse-runner.js";
import {
  createGoldenCollectors,
  stageGoldenCorpusInto,
} from "../collectors/golden/golden-collectors.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { createIngestBatchResumeCursorStore } from "../database/ingest-batch-resume-cursor-store.js";
import { createWiredStoreIntegrityProbe } from "../database/store-integrity-wiring.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { resolveLoopbackListenerPort } from "../lifecycle/loopback-port-isolation.js";
import {
  attachPostBootMaintenanceSettle,
  createMaintenanceSettleNotifier,
} from "../lifecycle/post-boot-maintenance-settle.js";
import {
  type OnboardingParseProgressReading,
  readOnboardingParseProgress,
} from "../onboarding/onboarding-parse-progress.js";
import { ClaudeCodeSignalDropReason } from "../otel/claude-code-signal-drop.js";
import type { CatalogFetchCoordinator } from "../packs/catalog-fetch-coordinator.js";
import { streamRun } from "../packs/install-orchestrator.js";
import { resolveInstalledPackVersion } from "../packs/installed-version.js";
import type { PackScanCoordinator } from "../packs/pack-scan-coordinator.js";
import * as packStore from "../packs/pack-store.js";
import { subscribeParsePolicyFlips } from "../parse-policy/parse-policy-resolver.js";
import { withIpcProfiling } from "../profiling/ipc-profiling.js";
import { getIpcProfilingSink } from "../profiling/main-profiling-session.js";
import { startSessionMeshHookInstallation } from "../session-mesh/session-mesh-hook-installer.js";
import type { MaterializeImportHealthEvent } from "../telemetry/app-otel-runtime-import-health.js";
import { installImportHealthTracking } from "../telemetry/import-health-telemetry.js";
import { Observability } from "../telemetry/observability.js";
import { OtlpHttpReceiver } from "../telemetry/otlp-http-receiver.js";
import { DEFAULT_OTLP_RECEIVER_PORT } from "../telemetry/otlp-receiver-state.js";
import {
  claudeCaptureGate,
  createOtlpExportCallbacks,
} from "../telemetry/otlp-receiver-wiring.js";
import { startAgentCaptureReceivers } from "./agent-capture-receiver-startup.js";
import type { AgentDashboardDatabaseRuntime } from "./agent-dashboard-database-runtime.js";
import { createAgentDashboardDbHostLifecycle } from "./agent-dashboard-db-host-lifecycle.js";
import {
  registerDesignSystemDbIpcHandlers,
  unregisterDesignSystemDbIpcHandlers,
} from "./agent-dashboard-db-ipc-registration.js";
import {
  type GitHubResyncNudgeRefreshResult,
  refreshGitHubResyncBranches,
} from "./agent-dashboard-github-resync.js";
// ISS-6241: the shape and its generation-guarded writers moved to
// `maintenance-progress-state.ts`; re-exported here so existing importers of the
// runtime's type keep resolving.
import {
  desktopCatchupPollMs,
  desktopHistoricalImportDelayMs,
  desktopHistoricalImportStaggerMs,
} from "./agent-dashboard-runtime-import-schedule.js";
import { createAgentDashboardRuntimeLifecycle } from "./agent-dashboard-runtime-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { resolveIngestStateDir } from "./agent-dashboard-runtime-paths.js";
import {
  backfillClaudePlans,
  scanAgentDashboardPacks,
  seedAgentDashboardCatalog,
} from "./agent-dashboard-startup-maintenance.js";
import { createAgentDashboardStoreCoordinators } from "./agent-dashboard-store-coordinators.js";
import { resolveIngestStoreProvider } from "./ingest-store-provider.js";
import type { AgentDashboardMaintenanceProgress } from "./maintenance-progress-state.js";
import { createMaintenanceProgressState } from "./maintenance-progress-state.js";
import { resolveOpencodeWithheldReconciliation } from "./opencode-withheld-reconciliation.js";
import { createParsePolicyMaintenanceRerun } from "./parse-policy-maintenance-rerun.js";
import { createPostBootMaintenance } from "./post-boot-maintenance.js";
import { scheduleWhenRendererIdle } from "./post-boot-maintenance-idle-reschedule.js";
import { resolveRebuildSyncComputeTargetId } from "./rebuild-sync-compute-target.js";
import { createStartupBackgroundScheduler } from "./startup-background-scheduler.js";
import { createStartupHistoricalBackfillTask } from "./startup-historical-backfill.js";

export type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";

export type { AgentDashboardMaintenanceProgress } from "./maintenance-progress-state.js";

export type AgentDashboardDesignSystemRuntime =
  AgentDashboardDatabaseRuntime & {
    /**
     * ISS-6338: per-lane cloud batch health, forwarded from the runtime options.
     * Exposed here because the transcript archive lane already resolves its STORE
     * through this runtime, so an emitter hung off the same object is available on
     * exactly the passes that can produce a batch. Absent when no telemetry
     * runtime is wired, in which case the lane drains uninstrumented.
     */
    emitSyncBatch?: SyncLaneBatchEmit;
    /**
     * ISS-8600: report one batch-materialized harness's outcome as an
     * import-health record. Exposed here for the same reason `emitSyncBatch` is —
     * the transcript lane already resolves its store through this runtime, so the
     * discovery sweep reaches the seam without an `app.ts` edit. Absent when no
     * telemetry runtime is wired, in which case the sweep is uninstrumented.
     *
     * The harness is the caller's to name: a second `batch: true` collector's
     * wiring must supply its own rather than inherit whichever one this seam was
     * built for.
     */
    noteMaterializeOutcome?: (
      harness: TelemetryHarnessName,
      kind: MaterializeImportHealthEvent
    ) => void;
    getUrl: () => string | null;
    isReady: () => boolean;
    startCollectors: () => void;
    getIngestProgress: () => DesktopIngestProgressReport;
    /**
     * ISS-8346: where the boot import has got to, for the onboarding estimate —
     * bytes still to parse for the named harnesses, plus what the importer is
     * doing.
     *
     * Deliberately NOT folded into {@link DesktopIngestProgressReport}: that is
     * the renderer's banner payload, while this is derived in main against a
     * transcript inventory the renderer never holds, and two of the facts it turns
     * on (the acknowledged pause, the spent re-drive budget) are main-only.
     */
    readParseProgress: (
      harnesses: readonly string[]
    ) => OnboardingParseProgressReading;
    /**
     * FEA-3639: harness transcript roots that exist but the OS won't let us read
     * (a denied macOS file-access prompt). Empty when nothing is blocked. The
     * renderer turns this into an explicit "waiting on file access" prompt instead
     * of a silent stall.
     */
    getFileAccessBlocks: () => FileAccessBlock[];
    getMaintenanceProgress: () => AgentDashboardMaintenanceProgress;
    refreshGitHubBranches: (
      body: unknown
    ) => Promise<GitHubResyncNudgeRefreshResult>;
    setImportPaused: (paused: boolean) => void;
    stop: () => Promise<void>;
    close: () => Promise<void> | void;
    /**
     * ISS-4713 — mark the intentional-shutdown window open on the db-host client
     * synchronously, before the app tears down the capture/sync services that
     * still drive db-host writes. From here a db-host `exit` is treated as
     * expected (no "exited unexpectedly" relabel, no mid-shutdown restart). The
     * bounded, clean db-host drain then happens inside `close()`.
     */
    beginClosing: () => void;
    restartCollectors: () => Promise<void>;
    registerIpcHandlers: () => void;
    loadMeteredUsageRows: (
      cutoffIso: string
    ) => MeteredUsageRow[] | Promise<MeteredUsageRow[]>;
    /**
     * FEA-2923: run a vetted catalog-pack install via the same `streamRun` path
     * the renderer catalog UI uses. `packId` is resolved to a local `pack_catalog`
     * row whose vetted `installCommands` are executed — cloud-supplied commands and
     * presigned zip URLs are NEVER an install source. Used by the auto-install
     * reconciler in app.ts.
     */
    installPack: (packId: string, harness: string) => Promise<StreamRunResult>;
    /**
     * FEA-2923: return the installed version of a pack from the local
     * `agent_packs` inventory, or null when the pack is not installed. A pack that
     * is installed but carries no version string resolves to the `"installed"`
     * sentinel so the reconciler treats it as present.
     */
    getInstalledPackVersion: (packId: string) => Promise<string | null>;
  };

/**
 * Create the in-process design-system dashboard runtime. Import this module only
 * after the Labs flag has selected design-system mode; all imports below this
 * boundary can open SQLite, bind the hook port, register IPC, or start watchers.
 */
export async function createAgentDashboardDesignSystemRuntime(
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<AgentDashboardDesignSystemRuntime> {
  const log = options.log ?? (() => {});
  let dbIpcRegistered = false;
  // FEA-3628: created once `golden` is known (below). Until then — and in golden
  // mode — `packScanner.run` forwards straight to the db-host fallback.
  let packScanCoordinator: PackScanCoordinator | null = null;
  // ISS-5274: same late-construction shape as the pack-scan coordinator. Until
  // it exists — and in golden mode, which does no network egress at all —
  // `catalog.fetch.run` forwards straight to the db-host fallback.
  let catalogCoordinator: CatalogFetchCoordinator | null = null;
  // ISS-4771: the whole db-host concern (the pre-open zombie reap, the child
  // start, the forwarding proxy, the two `store:`-op forwarders, and the
  // beginClosing/close pair) lives in the sibling lifecycle module. This runtime
  // still owns WHEN each of those happens relative to the collectors, IPC
  // handlers, and timers below.
  const dbHostLifecycle = createAgentDashboardDbHostLifecycle({
    options,
    log,
    getPackScanCoordinator: () => packScanCoordinator,
    getCatalogCoordinator: () => catalogCoordinator,
  });
  const agentDatabase = dbHostLifecycle.agentDatabase;
  const agentDatabasePromise = dbHostLifecycle.ready;
  const rawStoreOp = dbHostLifecycle.rawStoreOp;
  const invokeStoreOp = dbHostLifecycle.invokeStoreOp;

  const registerIpcHandlers = () => {
    if (dbIpcRegistered) {
      return;
    }
    dbIpcRegistered = true;
    const register = () =>
      registerDesignSystemDbIpcHandlers(
        () => agentDatabasePromise,
        options,
        invokeStoreOp,
        dbHostLifecycle.cancelRead
      );
    // ISS-4430 — these channels register AFTER the static block that
    // `installIpcProfiling` patches, so they were invisible to `ipc.jsonl`
    // even with profiling on. That gap covered
    // `desktop:shared-agent-sessions:page-data`, the read whose deadline the
    // soak harness measures — the one channel a latency investigation most
    // needs a total for. The sink getter returns `null` when profiling is off,
    // so a production launch takes the unwrapped branch exactly as before.
    const ipcSink = getIpcProfilingSink();
    if (ipcSink) {
      withIpcProfiling(ipcMain, ipcSink, register);
      return;
    }
    register();
  };

  await agentDatabasePromise;
  registerIpcHandlers();
  log("agent-dashboard", "SQLite runtime active for Agent Dashboard database");
  // The renderer may have first-painted against disabled IPC responders while
  // SQLite opened. Nudge DB-backed caches once live handlers can serve data.
  sendToRendererWindow(
    options.getWindow(),
    DesktopRendererEventChannel.DbReady,
    {}
  );
  sendToRendererWindow(
    options.getWindow(),
    DesktopRendererEventChannel.DbChanged,
    {}
  );

  // ISS-6713: the `closed` flag and the current-start slot — the runtime's whole
  // start/stop/close state machine — live in the sibling lifecycle module so a
  // test can drive the transitions without forking a db host or opening
  // Electron. This runtime still owns WHAT each transition tears down.
  const lifecycle = createAgentDashboardRuntimeLifecycle(dbHostLifecycle);
  const isClosed = (): boolean => lifecycle.isClosed();
  // FEA-2261: the startup background-work gates and serialized queue live in
  // the sibling scheduler module; this runtime owns only WHAT it schedules.
  const {
    notifyCollectorImportSettled,
    notifyCollectorImportTimedOut,
    notifyCollectorImportRetriesExhausted,
    notifySessionProjectionSettled,
    isSessionProjectionSettled,
    waitForBackgroundSlot,
    backgroundDelay,
    runAfterInitialBackgroundWorkAllowed,
  } = createStartupBackgroundScheduler({
    isClosed,
    log,
    waitForRendererBackgroundSlot: options.waitForRendererBackgroundSlot,
    whenInitialBackgroundWorkAllowed: options.whenInitialBackgroundWorkAllowed,
    whenInitialDashboardDataServed: options.whenInitialDashboardDataServed,
    onSessionProjectionReady: options.onInitialSessionProjectionReady,
  });
  const runStartupCatalogMaintenance = async (): Promise<void> => {
    if (isClosed()) {
      return;
    }

    const catalogSeeded = await seedAgentDashboardCatalog(invokeStoreOp, log);
    // ISS-4428: signal readiness so a distribution deferred while `pack_catalog`
    // was unseeded retries now instead of staying `pending` until the next
    // cloud-online. ISS-6170: only on a SUCCESSFUL seed — the installer reads
    // this to decide a pack may be given up on permanently, and an empty catalog
    // is the one state where `ENOTFOUND` is transient. `isClosed()` keeps a
    // runtime torn down mid-maintenance from firing a post-disposal retry.
    if (catalogSeeded && !isClosed()) {
      options.onCatalogSeeded?.();
    }
    await waitForBackgroundSlot();
    if (isClosed()) {
      return;
    }
    await scanAgentDashboardPacks(invokeStoreOp, log);
    await waitForBackgroundSlot();
    if (isClosed()) {
      return;
    }
    await backfillClaudePlans(invokeStoreOp, log);
    sendToRendererWindow(
      options.getWindow(),
      DesktopRendererEventChannel.DbChanged,
      {}
    );
  };
  runAfterInitialBackgroundWorkAllowed(
    "Startup catalog maintenance",
    runStartupCatalogMaintenance
  );

  runAfterInitialBackgroundWorkAllowed(
    "Startup historical backfill",
    createStartupHistoricalBackfillTask({ isClosed, agentDatabase, log })
  );

  // FEA-2648 golden mode: no background egress — catalog fetches hit GitHub, so
  // they stay unscheduled and an isolated corpus walkthrough neither talks to the
  // network nor mutates the throwaway DB with live data.
  const golden = options.golden ?? null;

  // FEA-3628 / ISS-5274: both heavy `store:` ops are driven from the main
  // process instead of inside the db-host — the pack scan through a compute
  // worker, the catalog fetch through its own coordinator. Construction and the
  // catalog's boot/timer triggers live in the sibling coordinators module; the
  // store-op router is what routes each trigger, so no call site changes.
  const storeCoordinators = createAgentDashboardStoreCoordinators({
    golden,
    rawStoreOp,
    invokeStoreOp,
    runAfterInitialBackgroundWorkAllowed,
    waitForBackgroundSlot,
    log,
  });
  packScanCoordinator = storeCoordinators.packScan;
  catalogCoordinator = storeCoordinators.catalog;
  const collectorsLog = (message: string): void =>
    log("agent-collectors", message);
  // ISS-4573 (TEST-ONLY): the parse-quarantine seam arms only for an UNPACKAGED
  // build launched with the exact E2E sentinel. PR #4085 review (whitlockk): resolve
  // `app.isPackaged` HERE, at the main-process composition root, and pass it to the
  // seam so a packaged client that inherits the flag can never arm. Computed once
  // and reused for both the manager config and the explicit worker capability.
  const e2eParseQuarantineArmed = isE2eParseQuarantineEnabled(
    process.env,
    app.isPackaged
  );
  // ISS-8982 (TEST-ONLY): the boot-import abandon seam, gated on the same two
  // dimensions and resolved here for the same reason. `null` in every
  // production run, so the manager is handed no hook at all rather than an
  // inert one.
  const e2eBootImportAbandons = e2eBootImportAbandonPasses(
    process.env,
    app.isPackaged
  );
  // FEA-2648: the utility-process worker rebuilds default home-rooted
  // collectors, which would reject staged corpus sources — golden mode parses
  // in-process through the injected collectors instead.
  const historicalParseRunner = golden
    ? null
    : createUtilityProcessHistoricalParseRunner({
        log: collectorsLog,
        // PR #4085 review (whitlockk): the worker cannot read `app.isPackaged`, so it
        // must NOT trust the raw inherited app-level sentinel. Thread the poison
        // capability in explicitly ONLY when the main process cleared the
        // `!isPackaged` + sentinel gate above; the runner strips any inherited
        // value otherwise, so a packaged worker never wedges a real parse.
        enablePoisonWorkerCapability: e2eParseQuarantineArmed,
      });
  let maintenanceGeneration = 0;
  let maintenanceTask: Promise<void> | null = null;
  // FEA-2264: the live post-boot maintenance phase, surfaced to the renderer via
  // the runtime status payload so the first-launch banner can stay up (with calm
  // copy) across the data-revision rebuild + artifact-link backfill window. Reset
  // to inactive whenever the owning generation finishes or is cancelled.
  // Deferred: `isMaintenanceActive` is declared below this point in the runtime,
  // and the guard is only ever called once maintenance is actually running.
  const maintenanceProgressState = createMaintenanceProgressState(
    (generation: number) => isMaintenanceActive(generation)
  );
  const { setPhase: setMaintenancePhase, setPhaseProgress } =
    maintenanceProgressState;
  const clearMaintenanceProgress = (): void => {
    maintenanceProgressState.clear();
  };

  // FEA-1839: the live-collection routing SSOT. Claude runs in hooks mode when
  // the master Agent Dashboard hook toggle is on; every other harness (Codex
  // included — Codex hooks were removed, PRD-431) always uses its watcher.
  // Resolved fresh on each collector start so a hooks toggle (which restarts
  // collectors) recomputes the watcher gate.
  const currentHooksState = (): HooksInstalledState => {
    return {
      claude: isAgentMonitorHooksEnabled(),
    };
  };

  // FEA-3741 (slice 1): the per-tool collector enable snapshot, resolved fresh on
  // each collector start (a toggle flip restarts collectors). Empty (all-enabled)
  // when the host does not wire the reader — preserving the always-on default.
  const currentCollectorEnabledState = (): CollectorEnabledState =>
    options.getCollectorEnabledState?.() ?? {};

  // FEA-1839: detect a harness session emitted by BOTH the hook handler and the
  // live watcher (a double-counting bug) and persist one violation row.
  const mutualExclusivityMonitor = createMutualExclusivityMonitor({
    onViolation: (harness, externalSessionId) => {
      // ISS-6164: `onViolation` has no error path, so an unguarded `void` here
      // let a db-host bounce reach handleUnhandledRejection — which exits the
      // app. The violation row is best-effort telemetry; losing one to a restart
      // must not cost the session.
      dropOnDbHostLifecycleError(
        agentDatabase.recordCollectionModeViolation(harness, externalSessionId),
        { label: "collection-mode violation", log: collectorsLog }
      );
    },
    log: collectorsLog,
  });

  // ISS-5723: both listeners below bind ONE fixed port with no fallback, so two
  // concurrent app instances collide. Resolved HERE, at the main-process
  // composition root — the only place that can read `app.isPackaged` — for the
  // same reason `e2eParseQuarantineArmed` is (PR #4085 review).
  const loopbackPort = (defaultPort: number): number =>
    resolveLoopbackListenerPort(defaultPort, process.argv, {
      isPackaged: app.isPackaged,
    });

  const otlpLog = (message: string) => log("otlp-http-receiver", message);
  /**
   * Record a lost Claude signal, never letting the bookkeeping fail an export.
   *
   * The recorder writes through the shared queue, so a store that is closing or
   * a transient write failure must not propagate into the receiver's dispatch
   * loop and cost a healthy export.
   */
  const recordClaudeSignalDrop = async (input: {
    harness: string;
    reason: ClaudeCodeSignalDropReason;
    count: number;
  }): Promise<void> => {
    try {
      await agentDatabase.claudeCodeOtel.recordSignalDrop(input);
    } catch (error) {
      otlpLog(
        `failed to record a dropped Claude signal: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  const otlpReceiver = new OtlpHttpReceiver({
    port: loopbackPort(DEFAULT_OTLP_RECEIVER_PORT),
    log: otlpLog,
    onBindError: (reason) => {
      collectorsLog(`OTLP receiver unavailable: ${reason}`);
    },
    ...createOtlpExportCallbacks({
      log: otlpLog,
      isClaudeCaptureEnabled: claudeCaptureGate({
        isOtelCaptureEnabled: () =>
          options.isClaudeCodeOtelCaptureEnabled?.() ?? false,
        isClaudeCollectorEnabled: () =>
          currentCollectorEnabledState()[Harness.Claude] !== false,
      }),
      persistClaudeSignals: (signals) =>
        agentDatabase.claudeCodeOtel.persistSignals(signals),
      recordSignalDrop: (input) => {
        void recordClaudeSignalDrop(input);
      },
      // ISS-10719: the persist lane the previous wiring's own comment called
      // "still-unwired". Codex exports were received, logged, and thrown away.
      persistCodexBatch: (batch) => agentDatabase.codexOtel.persistBatch(batch),
    }),
    // ISS-10717: an evicted export is ACKed and therefore never re-sent, so
    // without this count the corpus reads as authoritative while it is a lower
    // bound. The harness is all that is knowable here — the payload is decoded
    // downstream — so one call is one lost EXPORT.
    onExportDropped: (harness) => {
      void recordClaudeSignalDrop({
        harness,
        reason: ClaudeCodeSignalDropReason.ReceiverBackpressure,
        count: 1,
      });
    },
  });

  const hookListener = new AgentHookListener({
    port: loopbackPort(AGENT_MONITOR_PORT),
    lifecycle: {
      processEvent: (hookType, data, harness) => {
        // FEA-3729: kill switch off → drop any Claude hook payload still hitting
        // the listener (e.g. a stale settings.json install a boot uninstall has
        // not yet cleaned). The watcher + parser owns Claude capture instead.
        if (!isClaudeLiveHookEnabled()) {
          return false;
        }
        // FEA-3741 (slice 1): the per-tool collector toggle must gate the live
        // hook path too. Skipping only the watcher/historical-import lanes leaks
        // capture here: for a user who already has Claude hooks installed, live
        // payloads would keep writing to the DB after they turn Claude collection
        // off. Route through the SAME tested SSOT the watcher uses — a
        // toggled-off harness resolves to "disabled" (an explicit `false`;
        // omission still means enabled), so we drop the event before the
        // transcript mirror and the metadata write.
        if (
          getActiveCollectionMode(
            harness,
            currentHooksState(),
            currentCollectorEnabledState()
          ) === "disabled"
        ) {
          return false;
        }
        // FEA-1839: record the hooks channel before the write. harness is the
        // route-owned HookHarness ("claude") — a subset of Harness, so no cast
        // is needed.
        mutualExclusivityMonitor.record(
          harness,
          typeof data.session_id === "string" ? data.session_id : null,
          "hooks"
        );
        // FEA-2715: mirror the hook to the transcript archive lane (no-op unless
        // the flag is on). Never let it affect the metadata-lane write below.
        options.onTranscriptHookEvent?.(hookType, data);
        return agentDatabase.processEvent(hookType, data, harness);
      },
    },
    onSessionMeshHookEvent: options.onSessionMeshHookEvent,
    log: (message: string) => log("agent-monitor-listener", message),
    onBindError: options.onTerminalFailure,
  });

  const isMaintenanceActive = (generation: number): boolean =>
    !isClosed() && maintenanceGeneration === generation;

  // ISS-8601: false runs the rebuild without claiming the import finished.
  const schedulePostBootMaintenance = (claimImportComplete = true): void => {
    maintenanceScheduled = true;
    const generation = ++maintenanceGeneration;
    // The readiness signal (which clears the Dashboard nav throbber) must fire
    // when maintenance SETTLES for the active generation — success OR failure.
    // Post-boot maintenance is best-effort background re-derivation, not a gate
    // on dashboard usability; a rejected run must not strand the throbber
    // "preparing" forever. Generation semantics are preserved by
    // `attachPostBootMaintenanceSettle`: a superseded generation does not fire.
    const task = attachPostBootMaintenanceSettle(
      runPostBootMaintenance(generation),
      generation,
      {
        isActive: isMaintenanceActive,
        // FEA-2261 release + the ISS-8601 readiness claim; see that factory.
        onSettleActive: createMaintenanceSettleNotifier({
          claimImportComplete,
          onImportComplete: options.onInitialCollectorImportComplete,
          onSettled: notifySessionProjectionSettled,
        }),
        logError: (e: unknown) =>
          log(
            "post-boot-maintenance",
            `post-boot maintenance failed: ${e instanceof Error ? e.message : String(e)}`
          ),
        onFinally: () => {
          // Only the generation that still owns the runtime clears the flag: a
          // newer scheduled run (e.g. after a collector restart) has already set
          // its own active phase, so a stale finalizer must not stomp it.
          if (maintenanceGeneration === generation) {
            clearMaintenanceProgress();
          }
          if (maintenanceTask === task) {
            maintenanceTask = null;
          }
        },
      }
    );
    maintenanceTask = task;
  };

  // ISS-12552: a settled parse-policy flip reruns the chain once, behind any
  // pass in flight (see parse-policy-maintenance-rerun.ts).
  let maintenanceScheduled = false;
  const unsubscribeParsePolicyFlips = subscribeParsePolicyFlips(
    createParsePolicyMaintenanceRerun({
      isScheduled: () => maintenanceScheduled,
      currentPass: () => maintenanceTask,
      isClosed,
      rerun: () => schedulePostBootMaintenance(false),
    })
  );

  // ISS-4824: the whole post-boot maintenance CHAIN (DATA_REVISION rebuild + its
  // sync-outbox hand-off, artifact-link backfill + the PR-attribution
  // post-pass, activity-segment re-tiling) lives in `post-boot-maintenance.ts`.
  // This runtime keeps only the lifecycle it owns — the generation counter, the
  // scheduling, and the settle/throbber semantics above.
  const { runPostBootMaintenance } = createPostBootMaintenance({
    isMaintenanceActive,
    setMaintenancePhase,
    setMaintenancePhaseProgress: setPhaseProgress,
    agentDatabase,
    // Accessors: both are declared BELOW this point in the runtime and are only
    // reachable once maintenance actually runs.
    getCollectors: () => collectorManager.getCollectors(),
    getHistoricalParseRunner: () => historicalParseRunner,
    invokeStoreOp,
    getWindow: options.getWindow,
    log: collectorsLog,
    cooperativeDelay: backgroundDelay,
    hasRecentRendererRead: options.hasRecentRendererRead,
    isDbHostUnderMemoryPressure: () => dbHostLifecycle.isUnderMemoryPressure(),
    injectSyncBackfillIds: options.injectSyncBackfillIds,
    resolveComputeTargetId: () => resolveRebuildSyncComputeTargetId(options),
  });

  let timedOutMaintenanceReArm: { cancel: () => void } | null = null;

  const cancelCollectorMaintenance = async (): Promise<void> => {
    maintenanceGeneration++;
    timedOutMaintenanceReArm?.cancel();
    timedOutMaintenanceReArm = null;
    // FEA-2264: the bumped generation makes the in-flight task's finalizer skip
    // the clear (it no longer owns the runtime), so reset here directly — a
    // cancelled maintenance window must not leave the banner showing "finishing
    // up" forever.
    clearMaintenanceProgress();
    // ISS-9839 (ISS-9837 C2): awaited — the batch resume cursor's terminal flush.
    await collectorManager.stop();
    historicalParseRunner?.stop();
    packScanCoordinator?.stop();
    const task = maintenanceTask;
    if (task) {
      await task.catch(() => {});
    }
  };

  const goldenStagingDir = stageGoldenCorpusInto(
    golden,
    options.userDataPath ?? app.getPath("userData")
  );

  // ISS-5103: decorate the importer with the import-health tally (no-op when the
  // host wired no telemetry seam). See installImportHealthTracking.
  // ISS-6116: the decorated importer has to exist before the manager that owns
  // the ingest tracker can be constructed, so the harness-progress seam is bound
  // AFTER construction rather than closing over the later `const`. The tracker
  // arms its interval immediately and a slow db-host read sits between the two,
  // so a closure over the binding could fire inside its temporal dead zone.
  let harnessProgressSource: CollectorManager | null = null;
  const importHealth = installImportHealthTracking({
    emitImportHealth: options.emitImportHealth,
    database: agentDatabase,
    reportHarnessProgress: () =>
      harnessProgressSource?.reportHarnessProgress() ?? [],
    // ISS-6336: read at TICK time, not now — the manager that owns the
    // quarantine stores is constructed below, and it needs the decorated
    // importer this call returns.
    readQuarantinedCounts: () =>
      collectorManager.getIngestProgress().quarantinedByStage,
    log: collectorsLog,
  });

  // ISS-5266 (whitlockk review): the upgrade guard, resolved before the collectors
  // are built because `listSources` cannot await. See the module for why a
  // failed lookup must NOT force a rescan.
  const opencodeWithheldReconciliation =
    await resolveOpencodeWithheldReconciliation({
      listRecordedScanPaths: () =>
        agentDatabase.diagnostics.listOpencodeWithheldScanPaths(),
      log: collectorsLog,
    });

  // ISS-9838: the persisted ingest stores now live in SQLite. Their hydrate is
  // resolved HERE (ISS-9837 R1), for the same reason as the guard above, so
  // every store constructor below stays synchronous — and the collectors receive
  // only the narrow port, never `agentDatabase` (ISS-9837 R2).
  const ingestStores = await resolveIngestStoreProvider({
    database: agentDatabase,
    log: collectorsLog,
  });

  const collectorManager = new CollectorManager({
    importer: importHealth.importer,
    // ISS-6336: the failures the decorated importer above can never see.
    onIngestFailure: importHealth.noteIngestFailure,
    // ISS-8600: an INSTALLED harness whose fast re-attach loop gave up — the
    // engine stays silent for a harness whose roots never existed. The tracker
    // maps the collector's harness key onto the contract's closed `harness.name`
    // set.
    onWatchLost: importHealth.noteWatchLost,
    stateDir: resolveIngestStateDir(options.userDataPath),
    ingestStores,
    // ISS-9839 (ISS-9837 R1c): `collectors/` may not reach for `agentDatabase`.
    batchResumeCursorStore: createIngestBatchResumeCursorStore({
      prisma: agentDatabase.prisma,
      invokeStoreOp,
    }),
    emit: (sessionId?: string) => {
      sendToRendererWindow(
        options.getWindow(),
        DesktopRendererEventChannel.DbChanged,
        {
          sessionId,
        }
      );
      // Goal stage 3: the same post-write moment feeds the sync pump — new
      // local session data is exactly the work-arrival signal the event-driven
      // lane runs on. Fires regardless of window/renderer state (the renderer
      // send above may no-op on a destroyed window; this tee must not).
      options.onLocalSessionDataChanged?.();
    },
    ...(goldenStagingDir
      ? { collectors: createGoldenCollectors(goldenStagingDir) }
      : {}),
    // Golden mode forces "disabled": the one-shot historical import still runs,
    // but no fs.watch ever attaches.
    getCollectionMode: goldenStagingDir
      ? () => "disabled"
      : (harness) =>
          getActiveCollectionMode(
            harness,
            currentHooksState(),
            // FEA-3741: a per-tool toggle off resolves the harness to "disabled"
            // in the routing SSOT too (belt-and-suspenders with the manager's
            // isCollectorEnabled skip; both read the same settings snapshot).
            currentCollectorEnabledState()
          ),
    // FEA-3741 (slice 1): skip a toggled-off harness entirely (no watcher, no
    // tool-home walk). Golden mode omits this gate so its staged corpus import
    // is untouched (the "disabled" mode above still runs the golden import).
    ...(goldenStagingDir
      ? {}
      : {
          isCollectorEnabled: (harness) =>
            currentCollectorEnabledState()[harness] !== false,
        }),
    onWatcherEmission: (harness, externalSessionId) => {
      mutualExclusivityMonitor.record(harness, externalSessionId, "watcher");
    },
    // FEA-3640: forward live-watcher activity to the transcript archive lane so
    // every watcher-mode harness rides the same ~5 min flush as the Claude hook
    // channel. Owned by app.ts (which holds the TranscriptSyncService); omitted
    // when the transcript flag is off.
    ...(options.onLiveTranscriptActivity
      ? { onLiveTranscriptActivity: options.onLiveTranscriptActivity }
      : {}),
    // Historical parsing runs in a utility process, and main-process DB writes
    // yield between sessions so there is no delayed CPU cliff after startup.
    historicalImportDelayMs: desktopHistoricalImportDelayMs,
    historicalImportStaggerMs: desktopHistoricalImportStaggerMs,
    catchupPollMs: desktopCatchupPollMs,
    // ISS-4573 (TEST-ONLY, unpackaged + E2E-launch-env-gated): tighten the
    // per-source parse deadline and drop the quarantine threshold to 1 so a seeded
    // poison transcript is quarantined in one fast wedge, letting the launched-app
    // E2E reach a nonzero `quarantinedCount` (→ the "N transcripts couldn't be read"
    // caveat) within its budget. Spread AFTER the delay config so it only ADDS the
    // two parse options and never touches anything else. `e2eParseQuarantineArmed`
    // is false in every production run (packaged build and/or the E2E launch env
    // unset), so this spreads {} and the manager keeps its generous ~90s deadline
    // and default 3-attempt threshold.
    ...(e2eParseQuarantineArmed ? E2E_PARSE_QUARANTINE_CONFIG : {}),
    // ISS-8982 (TEST-ONLY, unpackaged + E2E-launch-env-gated): abandon each
    // harness's first N historical passes with a recoverable `DbHostExitError`,
    // so the launched-app E2E reaches `RetriesExhausted` by counting passes
    // rather than by SIGKILLing the real db-host on a budget and hoping enough
    // kills land. Spread, not assigned, so a production run adds no key at all.
    ...(e2eBootImportAbandons === null
      ? {}
      : {
          e2eAbandonHistoricalPass: createE2eBootImportAbandonFault(
            e2eBootImportAbandons
          ),
        }),
    ...(historicalParseRunner ? { historicalParseRunner } : {}),
    log: collectorsLog,
    cooperativeDelay: backgroundDelay,
    waitForRendererBackgroundSlot: waitForBackgroundSlot,
    onBootImportComplete: () => schedulePostBootMaintenance(),
    // Both degraded boot-import terminals — the watchdog giving up on a wedged
    // harness (FEA-4156) and a settle with sources left behind (ISS-6207) —
    // release the deferred startup ops and neither runs the cloud-read cutover,
    // which would claim readiness over sessions never imported. ISS-8601 splits
    // them on the maintenance half: TIMEOUT re-arms the rebuild at the next
    // renderer idle (`claimImportComplete: false` keeps that a rebuild, not a
    // readiness claim); retriesExhausted opens projection only when no earlier
    // timeout already made that maintenance owed.
    onBootImportTimeout: () => {
      notifyCollectorImportTimedOut();
      timedOutMaintenanceReArm = scheduleWhenRendererIdle({
        hasRecentRendererRead: options.hasRecentRendererRead,
        run: () => schedulePostBootMaintenance(false),
        log: collectorsLog,
      });
    },
    onBootImportRetriesExhausted: notifyCollectorImportRetriesExhausted,
    // Self-heal catchup-cache/DB divergence: after a DB reset/migration the
    // JSON ingest cache still marks codex/claude sources "seen", but their rows
    // are gone. Surfacing the live id set lets the manager re-import orphans.
    listExistingSessionIds: () => agentDatabase.listExistingSessionIds(),
    deleteSessionRow: (sessionId) => agentDatabase.deleteSessionRow(sessionId),
    // ISS-5266: make the OpenCode subagent withhold durable.
    //
    // The promise is RETURNED, not detached. The collector awaits it before
    // `markSourceImported` seals the store's fingerprint, and refuses the seal
    // if it rejects. Swallowing the rejection here would let the fingerprint
    // advance over a record that never landed, and unchanged bytes are never
    // re-read, so the under-count would read as a real zero permanently.
    onOpencodeSubagentsWithheld: (report) =>
      agentDatabase.diagnostics.recordOpencodeWithheld(
        report,
        new Date().toISOString()
      ),
    // ISS-5266: an install from a release that predates this record would
    // otherwise never re-read its store, leaving the table permanently empty —
    // an emptiness the surface reads as "nothing withheld".
    ...opencodeWithheldReconciliation,
  });
  harnessProgressSource = collectorManager;

  /* FEA-1999: periodic SQLite store integrity-health probe. Runs on the reader
     pool (off the write/IPC hot path), skipped while the first-launch backfill
     is in progress, and emits a redacted fleet health signal via the
     Observability facade (which owns the emit cadence). The schema-aware inputs
     it must be injected with live in database/store-integrity-wiring.ts. */
  const storeIntegrityProbe = createWiredStoreIntegrityProbe({
    agentDatabase,
    emit: (diagnostics) => Observability.storeIntegrityResult(diagnostics),
    getIngestProgress: () => collectorManager.getIngestProgress(),
    log: (message: string) => collectorsLog(message),
  });

  const ensureOtlpReceiverStarted = (): Promise<void> =>
    startAgentCaptureReceivers({
      lifecycle,
      golden: Boolean(golden),
      hookListener,
      otlpReceiver,
      onSessionMeshReady: options.onSessionMeshReady,
      reconcileSessionMeshHooks: () => startSessionMeshHookInstallation(true),
      log: collectorsLog,
    });

  const runtime: AgentDashboardDesignSystemRuntime = {
    connection: agentDatabase.connection,
    syncSource: agentDatabase.syncSource,
    isInitialSessionProjectionReady: isSessionProjectionSettled,
    transcriptSync: agentDatabase.transcriptSync,
    invokeStoreOp,
    emitSyncBatch: options.emitSyncBatch,
    noteMaterializeOutcome: importHealth.noteMaterializeOutcome,
    getUrl: () => hookListener.getUrl(),
    isReady: () => hookListener.isReady(),
    getIngestProgress: () => collectorManager.getIngestProgress(),
    readParseProgress: (harnesses) =>
      readOnboardingParseProgress({
        remainingPendingBytes:
          collectorManager.remainingPendingBytes(harnesses),
        report: collectorManager.getIngestProgress(),
      }),
    // FEA-3639: probe each ENABLED harness's transcript roots for a permission
    // block on demand (a cheap `opendir` over each root). Runs per runtime-status
    // poll, so a granted permission clears the renderer prompt on the next tick
    // without any stored state. Filter through the same collector-enabled
    // snapshot `CollectorManager` uses (FEA-3741): a disabled harness's tool-home
    // walk is deliberately skipped, so the probe must not open its roots either —
    // otherwise it would incidentally touch a TCC folder and raise a prompt for a
    // harness the user isn't collecting. `harnessScanRoots` stays exhaustive over
    // the Harness enum so no enabled collector silently escapes the probe.
    getFileAccessBlocks: () =>
      probeFileAccessBlocks(
        harnessScanRoots(
          (harness) => currentCollectorEnabledState()[harness] !== false
        )
      ),
    getMaintenanceProgress: () => maintenanceProgressState.read(),
    refreshGitHubBranches: (body) => refreshGitHubResyncBranches(body),
    setImportPaused: (paused: boolean) => {
      if (paused) {
        collectorManager.pauseImport();
      } else {
        collectorManager.resumeImport();
      }
    },
    startCollectors: () => {
      if (isClosed()) {
        return;
      }
      const pendingStartPromise = ensureOtlpReceiverStarted();
      void pendingStartPromise.then(() => {
        if (!lifecycle.isCurrentStart(pendingStartPromise)) {
          return;
        }
        collectorManager.start();
        storeIntegrityProbe.start();
      });
    },
    stop: async () => {
      if (!lifecycle.beginStop()) {
        return;
      }
      storeIntegrityProbe.stop();
      // ISS-6336 (whitlockk review): collectors stop BEFORE the final flush.
      // `importHealth.shutdown()` drains the tally then disposes, and
      // `noteIngestFailure` no-ops once disposed — flushing first dropped every
      // failure raised while the still-running pass wound down. Stopping first
      // also settles the generation, so the rejections
      // `historicalParseRunner.stop()` raises are suppressed by the
      // `isImportActive` gate instead of counted. The db host and the OTel
      // exporter are both still up here, so the flush loses nothing by moving.
      await cancelCollectorMaintenance();
      await importHealth.shutdown();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
    },
    // ISS-4713: open the intentional-shutdown window on the db-host client so an
    // exit during teardown is not relabeled unexpected / restarted. Cheap,
    // synchronous, and idempotent — close() sets the same flag as a backstop.
    beginClosing: lifecycle.beginClosing,
    close: () =>
      lifecycle.close(async () => {
        // FEA-2261: release any startup tasks still parked on the import gate so
        // their chains resolve and short-circuit on the `isClosed()` check
        // instead of lingering until the fail-open timeout.
        notifyCollectorImportSettled();
        unsubscribeParsePolicyFlips();
        storeIntegrityProbe.stop();
        // ISS-6336 (whitlockk review): stop the collectors before the final
        // flush, for the reason spelled out on `stop` above.
        await cancelCollectorMaintenance();
        await importHealth.shutdown();
        storeCoordinators.stopCatalog();
        if (dbIpcRegistered) {
          unregisterDesignSystemDbIpcHandlers();
          dbIpcRegistered = false;
        }
        await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
      }),
    restartCollectors: async () => {
      if (isClosed()) {
        return;
      }
      await cancelCollectorMaintenance();
      if (isClosed()) {
        return;
      }
      // FEA-1839: a restart is the config-change boundary (e.g. a hooks toggle).
      // Clear the monitor so a session captured by the watcher under the old mode
      // and by the hook handler under the new mode is not flagged as a violation.
      mutualExclusivityMonitor.reset();
      collectorManager.start();
    },
    registerIpcHandlers,
    loadMeteredUsageRows: (cutoffIso: string) =>
      agentDatabase.loadMeteredUsageRows(cutoffIso),
    // FEA-2923: run a vetted catalog-pack install through the identical
    // streamRun path the renderer catalog-install IPC handler uses (same
    // trust model: install commands come only from the local pack_catalog).
    installPack: (packId: string, harness: string) =>
      streamRun(agentDatabase, {
        pack_id: packId,
        harness,
        action: "install",
        getWindow: options.getWindow,
        // Mirror the catalog-install IPC handler: rescan the pack inventory
        // after the install subprocess completes so getInstalledPackVersion
        // reflects the new state on the next reconcile.
        onComplete: () => void invokeStoreOp("packScanner.run").catch(() => {}),
      }),
    // FEA-2923: read installed version from the local agent_packs inventory.
    getInstalledPackVersion: async (packId: string) => {
      const detail = await packStore.getPack(agentDatabase.prisma, packId);
      return resolveInstalledPackVersion(detail);
    },
  };

  return runtime;
}
