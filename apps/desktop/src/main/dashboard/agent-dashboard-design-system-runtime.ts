import path from "node:path";
import { parseGitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope";
import type { GitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope-constants";
import { app, ipcMain } from "electron";
import { resolveBinaryFromLoginShellSync } from "../../server/shell-path.js";
import { AGENT_MONITOR_PORT } from "../../shared/contracts.js";
import type { DesktopIngestProgressReport } from "../../shared/ingest-quarantine-contract.js";
import type { StreamRunResult } from "../../shared/install-run-contract.js";
import { isAgentMonitorHooksEnabled } from "../agent-monitor/agent-monitor-hooks.js";
import { AgentHookListener } from "../agent-monitor/agent-monitor-listener.js";
import { isClaudeLiveHookEnabled } from "../agent-monitor/claude-live-hook-flag.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import {
  getSharedBranchDetail,
  getSharedBranches,
} from "../branch/shared-branches-api.js";
import {
  type CollectorEnabledState,
  getActiveCollectionMode,
  type HooksInstalledState,
} from "../collectors/engine/collection-mode.js";
import { CollectorManager } from "../collectors/engine/collector-manager.js";
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
  stageGoldenCorpus,
} from "../collectors/golden/golden-collectors.js";
import { detectBillingMode } from "../cost/billing-mode-detector.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import { dropOnDbHostLifecycleError } from "../database/db-host/db-host-fire-and-forget.js";
import { createWiredStoreIntegrityProbe } from "../database/store-integrity-wiring.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import { resolveGitHubResyncBranchIds } from "../github/github-resync-branch-resolution.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { resolveLoopbackListenerPort } from "../lifecycle/loopback-port-isolation.js";
import { attachPostBootMaintenanceSettle } from "../lifecycle/post-boot-maintenance-settle.js";
import type { CatalogFetchCoordinator } from "../packs/catalog-fetch-coordinator.js";
import { streamRun } from "../packs/install-orchestrator.js";
import { resolveInstalledPackVersion } from "../packs/installed-version.js";
import type { PackScanCoordinator } from "../packs/pack-scan-coordinator.js";
import * as packStore from "../packs/pack-store.js";
import { withIpcProfiling } from "../profiling/ipc-profiling.js";
import { getIpcProfilingSink } from "../profiling/main-profiling-session.js";
import { installImportHealthTracking } from "../telemetry/import-health-telemetry.js";
import { Observability } from "../telemetry/observability.js";
import { OtlpHttpReceiver } from "../telemetry/otlp-http-receiver.js";
import { DEFAULT_OTLP_RECEIVER_PORT } from "../telemetry/otlp-receiver-state.js";
import { delay, yieldToMainLoop } from "../util/main-loop-scheduling.js";
import { createAgentDashboardDbHostLifecycle } from "./agent-dashboard-db-host-lifecycle.js";
import {
  registerDesignSystemDbIpcHandlers,
  unregisterDesignSystemDbIpcHandlers,
} from "./agent-dashboard-db-ipc-registration.js";
import { toBranchSyncSource } from "./agent-dashboard-ipc-coercion.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { resolveIngestStateDir } from "./agent-dashboard-runtime-paths.js";
import {
  backfillClaudePlans,
  scanAgentDashboardPacks,
  seedAgentDashboardCatalog,
} from "./agent-dashboard-startup-maintenance.js";
import { createAgentDashboardStoreCoordinators } from "./agent-dashboard-store-coordinators.js";
import {
  clearTraceCommentCloudSyncErrorLog,
  createTraceCommentSyncDriver,
} from "./agent-dashboard-trace-comment-sync.js";
import { createBranchCloudHydration } from "./branch-cloud-hydration-factory.js";
import type { AgentDashboardMaintenanceProgress } from "./maintenance-progress-state.js";
import { createMaintenanceProgressState } from "./maintenance-progress-state.js";
import { resolveOpencodeWithheldReconciliation } from "./opencode-withheld-reconciliation.js";
import { createPostBootMaintenance } from "./post-boot-maintenance.js";
import { resolveRebuildSyncComputeTargetId } from "./rebuild-sync-compute-target.js";

// ISS-6241: the shape and its generation-guarded writers moved to
// `maintenance-progress-state.ts`; re-exported here so existing importers of the
// runtime's type keep resolving.
export type { AgentDashboardMaintenanceProgress } from "./maintenance-progress-state.js";

export type AgentDashboardDesignSystemRuntime = {
  connection: null;
  syncSource: AgentSessionSyncSource | null;
  /** FEA-2715: transcript archive-lane fingerprint/upload-cursor store. */
  transcriptSync: TranscriptSyncStore | null;
  getUrl: () => string | null;
  isReady: () => boolean;
  startHookListener: () => void;
  startCollectors: () => void;
  getIngestProgress: () => DesktopIngestProgressReport;
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
  /**
   * FEA-3813 (PRD-553 M1): start the local crewd scheduler daemon (runs in the
   * db host). Called from `boot()` gated on the `scheduledTasks` Labs flag —
   * idempotent, so a re-entrant boot is safe. Off ⇒ never called ⇒ no daemon.
   */
  startScheduler: () => Promise<void>;
  /**
   * FEA-3813 (PRD-553 M1): stop the scheduler daemon and drain its in-flight run
   * + pending write-behinds. Called from `shutdown()`; idempotent and safe before
   * `startScheduler`. (Also disposed with the db in `close()`.)
   */
  stopScheduler: () => Promise<void>;
};

export type GitHubResyncNudgeRefreshResult = {
  body: GitHubResyncNudgeBody;
  branchIds: string[];
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
  const cloudHydration = createBranchCloudHydration(options, invokeStoreOp);

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
        cloudHydration
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
  sendToRendererWindow(options.getWindow(), "desktop:db:ready", {});
  sendToRendererWindow(options.getWindow(), "desktop:db:changed", {});

  let closed = false;
  // FEA-2261: the first-launch collector import (thousands of transcripts) plus
  // its post-boot data-revision rebuild and artifact-link backfill is the heavy
  // critical-path work that paints the dashboard. Each of those runs as a
  // synchronous chunk in the DB host, so any OTHER heavy op dispatched
  // concurrently (catalog GitHub-stats fetch, enrichment sweep, historical
  // backfill, catalog maintenance) piles onto the same child loop and starves
  // the renderer's desktop:db:* reads, freezing the UI/banner for ~30s. Hold the
  // non-critical startup background tasks until this signal fires so the import
  // gets the loop to itself; the tasks already serialize one-at-a-time after it.
  let collectorImportSettled = false;
  const collectorImportSettledResolvers = new Set<() => void>();
  const notifyCollectorImportSettled = (): void => {
    if (collectorImportSettled) {
      return;
    }
    collectorImportSettled = true;
    for (const resolve of collectorImportSettledResolvers) {
      resolve();
    }
    collectorImportSettledResolvers.clear();
  };
  const whenCollectorImportSettled = (): Promise<void> => {
    if (collectorImportSettled) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      collectorImportSettledResolvers.add(resolve);
    });
  };
  // Fail open if the import never settles (collectors disabled, a stuck import,
  // a crashed child): these best-effort ops must not be deferred forever. Normal
  // first launches resolve the real signal well inside this window. The timer is
  // unref'd so it never holds the process open, and cleared once either side
  // wins so an early signal does not leave a dangling 5-minute timer.
  const waitForCollectorImportSettledOrTimeout = async (): Promise<void> => {
    if (collectorImportSettled) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS
      );
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
    });
    await Promise.race([whenCollectorImportSettled(), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
  };
  const waitForBackgroundSlot = async (): Promise<void> => {
    if (options.waitForRendererBackgroundSlot) {
      await options.waitForRendererBackgroundSlot();
      return;
    }
    await yieldToMainLoop();
  };
  const backgroundDelay = async (ms: number): Promise<void> => {
    await delay(ms);
    await waitForBackgroundSlot();
  };
  let backgroundTaskTail: Promise<void> = Promise.resolve();
  const enqueueStartupBackgroundTask = (
    task: () => void | Promise<void>
  ): Promise<void> => {
    const previousTask = backgroundTaskTail.catch(() => undefined);
    const currentTask = previousTask.then(async () => {
      if (closed) {
        return;
      }
      await waitForBackgroundSlot();
      if (closed) {
        return;
      }
      await task();
    });
    backgroundTaskTail = currentTask.catch(() => undefined);
    return currentTask;
  };
  // First paint / dashboard-data-served (and, when wired, the renderer live-DB
  // idle window) — the fast startup gate that keeps background work off the loop
  // during the sensitive first-paint window. Bounded to a few seconds; distinct
  // from the up-to-5-minute collector-import settle gate below.
  const waitForInitialBackgroundWorkAllowed = (): Promise<void> =>
    (
      options.whenInitialBackgroundWorkAllowed ??
      options.whenInitialDashboardDataServed ??
      (() => Promise.resolve())
    )();
  const runAfterInitialBackgroundWorkAllowed = (
    taskName: string,
    task: () => void | Promise<void>
  ): void => {
    // First paint / dashboard-data-served gates first, THEN the first-launch
    // collector import + post-boot maintenance must settle (FEA-2261), THEN the
    // task joins the serialized background queue.
    void waitForInitialBackgroundWorkAllowed()
      .then(() => waitForCollectorImportSettledOrTimeout())
      .then(() => enqueueStartupBackgroundTask(task))
      .catch((error: unknown) => {
        log(
          "agent-dashboard",
          `${taskName} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  };
  const runStartupCatalogMaintenance = async (): Promise<void> => {
    if (closed) {
      return;
    }

    await seedAgentDashboardCatalog(invokeStoreOp, log);
    // ISS-4428: `pack_catalog` is now populated, so the required-plugin
    // installer can resolve its vetted install commands. Signal catalog
    // readiness so a distribution that was deferred ("runtime not ready") while
    // the catalog was unseeded is retried now, rather than staying `pending`
    // until the next cloud-online. Guarded on `closed` so a runtime torn down
    // mid-maintenance does not fire a post-disposal retry.
    if (!closed) {
      options.onCatalogSeeded?.();
    }
    await waitForBackgroundSlot();
    if (closed) {
      return;
    }
    await scanAgentDashboardPacks(invokeStoreOp, log);
    await waitForBackgroundSlot();
    if (closed) {
      return;
    }
    await backfillClaudePlans(invokeStoreOp, log);
    sendToRendererWindow(options.getWindow(), "desktop:db:changed", {});
  };
  runAfterInitialBackgroundWorkAllowed(
    "Startup catalog maintenance",
    runStartupCatalogMaintenance
  );

  const resolveGitPath = () => resolveBinaryFromLoginShellSync("git").path;

  // Login-shell binary lookup is synchronous; wait for the first visible window
  // so git path resolution cannot hold first paint.
  const runStartupHistoricalBackfill = async (): Promise<void> => {
    if (closed) {
      return;
    }

    const gitPath = resolveGitPath();
    await agentDatabase
      .runHistoricalBackfill(gitPath, 50)
      .catch((e: unknown) =>
        log(
          "agent-enrichment",
          `Startup backfill failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
  };
  runAfterInitialBackgroundWorkAllowed(
    "Startup historical backfill",
    runStartupHistoricalBackfill
  );

  // FEA-2648 golden mode: no background egress — catalog fetches hit GitHub and
  // trace-comment sync POSTs to the cloud API; both stay unscheduled so an
  // isolated corpus walkthrough neither talks to the network nor mutates the
  // throwaway DB with live data.
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
  const traceCommentSync = createTraceCommentSyncDriver({
    invokeStoreOp,
    getSyncSource: () => agentDatabase.syncSource,
    options,
    isClosed: () => closed,
    enqueueBackgroundTask: enqueueStartupBackgroundTask,
    log: (message: string) => log("trace-comments", message),
  });
  if (!golden) {
    void waitForInitialBackgroundWorkAllowed()
      .then(() => traceCommentSync.startRetryInterval())
      .catch((error: unknown) =>
        log(
          "trace-comments",
          `Retry interval start deferred: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    runAfterInitialBackgroundWorkAllowed(
      "Initial trace-comment sync retry",
      traceCommentSync.runPendingSync
    );
  }

  let startPromise: Promise<void> | null = null;

  const collectorsLog = (message: string): void =>
    log("agent-collectors", message);
  // ISS-4573 (TEST-ONLY): the parse-quarantine seam arms only for an UNPACKAGED
  // build launched with the exact E2E sentinel. PR #4085 review (wongk): resolve
  // `app.isPackaged` HERE, at the main-process composition root, and pass it to the
  // seam so a packaged client that inherits the flag can never arm. Computed once
  // and reused for both the manager config and the explicit worker capability.
  const e2eParseQuarantineArmed = isE2eParseQuarantineEnabled(
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
        // PR #4085 review (wongk): the worker cannot read `app.isPackaged`, so it
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

  const otlpReceiver = new OtlpHttpReceiver({
    port: loopbackPort(DEFAULT_OTLP_RECEIVER_PORT),
    log: (message: string) => log("otlp-http-receiver", message),
    onBindError: (reason) => {
      collectorsLog(`OTLP receiver unavailable: ${reason}`);
    },
    onClaudeExport: (payload) => {
      log(
        "otlp-http-receiver",
        `received Claude ${payload.kind} export with ${payload.resourceAttributes.length} resource batch(es)`
      );
    },
    onCodexExport: (payload) => {
      log(
        "otlp-http-receiver",
        `received Codex ${payload.kind} export with ${payload.resourceAttributes.length} resource batch(es)`
      );
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
    log: (message: string) => log("agent-monitor-listener", message),
    onBindError: options.onTerminalFailure,
  });

  const isMaintenanceActive = (generation: number): boolean =>
    !closed && maintenanceGeneration === generation;

  const schedulePostBootMaintenance = (): void => {
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
        onSettleActive: () => {
          options.onInitialCollectorImportComplete?.();
          // FEA-2261: release the non-critical startup background tasks now that
          // the first-launch import + post-boot maintenance have settled.
          notifyCollectorImportSettled();
        },
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

  const cancelCollectorMaintenance = async (): Promise<void> => {
    maintenanceGeneration++;
    // FEA-2264: the bumped generation makes the in-flight task's finalizer skip
    // the clear (it no longer owns the runtime), so reset here directly — a
    // cancelled maintenance window must not leave the banner showing "finishing
    // up" forever.
    clearMaintenanceProgress();
    collectorManager.stop();
    historicalParseRunner?.stop();
    packScanCoordinator?.stop();
    const task = maintenanceTask;
    if (task) {
      await task.catch(() => {});
    }
  };

  // FEA-2648: stage the frozen corpus into the golden profile before any
  // collector sees it — even a readOnly open of the WAL-mode opencode.db would
  // drop -wal/-shm sidecars into the frozen raw/ dirs.
  const goldenStagingDir = golden
    ? path.join(
        options.userDataPath ?? app.getPath("userData"),
        "corpus-staging"
      )
    : null;
  if (golden && goldenStagingDir) {
    stageGoldenCorpus(golden.corpusDir, goldenStagingDir);
  }

  // ISS-5103: decorate the importer with the import-health tally (no-op when the
  // host wired no telemetry seam). See installImportHealthTracking.
  const importHealth = installImportHealthTracking({
    emitImportHealth: options.emitImportHealth,
    database: agentDatabase,
    log: collectorsLog,
  });

  // ISS-5266 (wongk review): the upgrade guard, resolved before the collectors
  // are built because `listSources` cannot await. See the module for why a
  // failed lookup must NOT force a rescan.
  const opencodeWithheldReconciliation =
    await resolveOpencodeWithheldReconciliation({
      listRecordedScanPaths: () =>
        agentDatabase.diagnostics.listOpencodeWithheldScanPaths(),
      log: collectorsLog,
    });

  const collectorManager = new CollectorManager({
    importer: importHealth.importer,
    detectBillingMode,
    stateDir: resolveIngestStateDir(options.userDataPath),
    emit: (sessionId?: string) => {
      sendToRendererWindow(options.getWindow(), "desktop:db:changed", {
        sessionId,
      });
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
    ...(historicalParseRunner ? { historicalParseRunner } : {}),
    log: collectorsLog,
    cooperativeDelay: backgroundDelay,
    waitForRendererBackgroundSlot: waitForBackgroundSlot,
    onBootImportComplete: schedulePostBootMaintenance,
    // FEA-4156: the boot import gave up (a wedged harness the watchdog timed out
    // on). Deliberately does NOT run post-boot maintenance — that would re-queue
    // history rebuild + artifact-link backfill onto the still-wedged import host
    // and strand the splash in the Compute stage. The renderer reads the degraded
    // `timedOut` ingest signal to resolve the splash into its graceful
    // partial-import state. We still release the deferred best-effort startup ops
    // here so a wedged import can't hold them forever (mirroring the maintenance
    // settle path and the existing fail-open timeout).
    onBootImportTimeout: notifyCollectorImportSettled,
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

  const ensureOtlpReceiverStarted = (): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    if (!startPromise) {
      if (golden) {
        // FEA-2648: golden mode binds neither the OTLP receiver nor the hook
        // listener. Assign (not just return) a resolved promise — callers
        // identity-check the returned promise against `startPromise` before
        // starting the collector manager.
        startPromise = Promise.resolve();
      } else {
        const pendingStartPromise = otlpReceiver.start().then((state) => {
          if (closed || startPromise !== pendingStartPromise) {
            return;
          }
          if (!state.available) {
            collectorsLog(`OTLP receiver unavailable: ${state.reason}`);
          }
        });
        startPromise = pendingStartPromise;
        void hookListener.start();
      }
    }
    return startPromise;
  };

  const runtime: AgentDashboardDesignSystemRuntime = {
    connection: agentDatabase.connection,
    syncSource: agentDatabase.syncSource,
    transcriptSync: agentDatabase.transcriptSync,
    getUrl: () => hookListener.getUrl(),
    isReady: () => hookListener.isReady(),
    startHookListener: () => {
      void ensureOtlpReceiverStarted();
    },
    getIngestProgress: () => collectorManager.getIngestProgress(),
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
    refreshGitHubBranches: async (body) => {
      const parsed = parseGitHubResyncNudgeBody(body);
      if (!cloudHydration) {
        return { body: parsed.body, branchIds: [] };
      }
      const source = toBranchSyncSource(agentDatabase);
      const list = await getSharedBranches(
        source,
        { forceRefresh: true },
        cloudHydration
      );
      const branchIds = resolveGitHubResyncBranchIds(
        parsed.body.scopes,
        list.items
      );
      await Promise.all(
        branchIds.map((id) =>
          getSharedBranchDetail(source, id, cloudHydration, {
            forceRefresh: true,
          })
        )
      );
      return { body: parsed.body, branchIds };
    },
    setImportPaused: (paused: boolean) => {
      if (paused) {
        collectorManager.pauseImport();
      } else {
        collectorManager.resumeImport();
      }
    },
    startCollectors: () => {
      if (closed) {
        return;
      }
      const pendingStartPromise = ensureOtlpReceiverStarted();
      void pendingStartPromise.then(() => {
        if (closed || startPromise !== pendingStartPromise) {
          return;
        }
        collectorManager.start();
        storeIntegrityProbe.start();
      });
    },
    stop: async () => {
      if (closed) {
        return;
      }
      startPromise = null;
      storeIntegrityProbe.stop();
      await importHealth.shutdown();
      await cancelCollectorMaintenance();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
    },
    beginClosing: () => {
      // ISS-4713: open the intentional-shutdown window on the db-host client so
      // an exit during teardown is not relabeled unexpected / restarted. Cheap,
      // synchronous, and idempotent — close() sets the same flag as a backstop.
      dbHostLifecycle.beginClosing();
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      startPromise = null;
      // FEA-2261: release any startup tasks still parked on the import gate so
      // their chains resolve and short-circuit on the `closed` check instead of
      // lingering until the fail-open timeout.
      notifyCollectorImportSettled();
      storeIntegrityProbe.stop();
      await importHealth.shutdown();
      storeCoordinators.stopCatalog();
      traceCommentSync.stopRetryInterval();
      clearTraceCommentCloudSyncErrorLog();
      if (dbIpcRegistered) {
        unregisterDesignSystemDbIpcHandlers();
        dbIpcRegistered = false;
      }
      await cancelCollectorMaintenance();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
      await dbHostLifecycle.close();
    },
    restartCollectors: async () => {
      if (closed) {
        return;
      }
      await cancelCollectorMaintenance();
      if (closed) {
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
    // FEA-3813 (PRD-553 M1): forward scheduler control to the db-host child (the
    // daemon + its writer connection live there). `agentDatabase.scheduler.*` are
    // clone-safe methods, so the proxy forwards them over IPC.
    startScheduler: () => {
      if (closed) {
        return Promise.resolve();
      }
      return agentDatabase.scheduler.start();
    },
    stopScheduler: () => agentDatabase.scheduler.stop(),
  };

  return runtime;
}

const desktopHistoricalImportDelayMs = 0;
const desktopHistoricalImportStaggerMs = 1000;
const desktopCatchupPollMs = 30 * 60_000;

// FEA-2261: upper bound on how long the non-critical startup background tasks
// (catalog GitHub-stats fetch, enrichment sweep, historical backfill, catalog
// maintenance) wait for the first-launch collector import + post-boot
// maintenance to settle before falling open. Generous on purpose: a normal
// first launch resolves the real signal well inside this window, so this cap
// only protects the pathological case (no collectors, a stuck/crashed import)
// from deferring these best-effort ops indefinitely.
const STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS = 5 * 60_000;
