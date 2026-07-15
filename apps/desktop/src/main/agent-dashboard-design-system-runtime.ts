import path from "node:path";
import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SECTION_OPTIONS,
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
  InsightsScope as InsightsScopeValues,
  type InsightsSection,
  InsightsSection as InsightsSectionValues,
} from "@closedloop-ai/loops-api/insights";
import {
  TRACE_COMMENT_ID_MAX_LENGTH,
  type TraceComment,
  type TraceCommentDeleteResult,
  type TraceCommentDraft,
  type TraceCommentReplyDraft,
  type TraceCommentTarget,
  type TraceCommentUpdate,
  traceCommentDraftSchema,
  traceCommentPath,
  traceCommentRepliesPath,
  traceCommentReplyDraftSchema,
  traceCommentsPath,
  traceCommentTargetSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import type { ApiResult } from "@repo/api/src/types/common";
import { parseGitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope";
import type { GitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope-constants";
import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
  type WebContents,
} from "electron";
import type { BranchPrIdentity } from "../server/operations/git-pr.js";
import { resolveBinaryFromLoginShellSync } from "../server/shell-path.js";
import type { SessionPageRequest } from "../shared/agent-db-contract.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../shared/shared-agent-components-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
} from "../shared/shared-agent-sessions-contract.js";
import {
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
} from "../shared/shared-branches-contract.js";
import {
  SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST,
  SHARED_TRACE_COMMENTS_IPC_CHANNELS,
} from "../shared/shared-trace-comments-contract.js";
import { DESIGN_SYSTEM_DB_IPC_CHANNELS } from "./agent-dashboard-ipc-contract.js";
import { instrumentIpcPerf } from "./agent-dashboard-ipc-perf.js";
import { isAgentMonitorHooksEnabled } from "./agent-monitor-hooks.js";
import { AgentHookListener } from "./agent-monitor-listener.js";
import type { AgentSessionSyncTransportPayload } from "./agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SessionAttributionResolverCache,
} from "./agent-session-sync-service.js";
import {
  DesktopIpcOperation,
  type DesktopIpcPerfEventInput,
} from "./app-otel-runtime.js";
import { detectBillingMode } from "./billing-mode-detector.js";
import {
  buildUnavailableCloudInsightsResponse,
  fetchCloudInsights,
} from "./cloud-insights-response.js";
import {
  getActiveCollectionMode,
  type HooksInstalledState,
} from "./collectors/engine/collection-mode.js";
import { CollectorManager } from "./collectors/engine/collector-manager.js";
import { runDataRevisionRebuild } from "./collectors/engine/data-revision-rebuild.js";
import { createMutualExclusivityMonitor } from "./collectors/engine/mutual-exclusivity-monitor.js";
import { createUtilityProcessHistoricalParseRunner } from "./collectors/engine/utility-process-historical-parse-runner.js";
import {
  createGoldenCollectors,
  stageGoldenCorpus,
} from "./collectors/golden/golden-collectors.js";
import { runActivitySegmentBackfillRuntimeBoundary } from "./collectors/parsing/activity-segment-backfill-runtime-boundary.js";
import { runArtifactLinkBackfillRuntimeBoundary } from "./collectors/parsing/artifact-link-backfill-runtime-boundary.js";
import { parseCloudGithubBranchOverlayMap } from "./database/cloud-github-overlay-store.js";
import { localCutoffDay, localDay } from "./database/db-helpers.js";
import { createDbHostAgentDatabase } from "./database/db-host/db-host-agent-database.js";
import { DbHostClient } from "./database/db-host/db-host-client.js";
import { coerceDbId } from "./database/ipc-validation.js";
import type { DbHostAgentDatabase } from "./database/sqlite.js";
import { createStoreIntegrityProbe } from "./database/store-integrity-probe.js";
import type { TranscriptSyncStore } from "./database/transcript-sync-store.js";
import { createApiErrorWatchdog } from "./database/watchdog.js";
import { DesktopCloudGitHubHydration } from "./desktop-cloud-github-hydration.js";
import { coerceDesktopInsightsScope } from "./desktop-insights-scope.js";
import { isAllowedExternalUrl } from "./external-url-allowlist.js";
import { resolveGitHubResyncBranchIds } from "./github-resync-branch-resolution.js";
import type { GoldenModeConfig } from "./golden-mode.js";
import { Observability } from "./observability.js";
import { OtlpHttpReceiver } from "./otlp-http-receiver.js";
// FEA-2038: catalog GitHub-stats fetch + contents refresh both end in
// `prisma.write`, which can't cross the DB-host method proxy — they run in the
// child via `invokeStoreOp("catalog.fetch.run" | "catalog.contents.refresh")`,
// so `runCatalogFetch` / `refreshCatalogContents` are NOT imported here.
import { scheduleCatalogFetch } from "./packs/catalog-fetcher.js";
import catalogSeed from "./packs/catalog-seed.json" with { type: "json" };
import * as catalogStore from "./packs/catalog-store.js";
import {
  type StreamRunResult,
  streamRun,
} from "./packs/install-orchestrator.js";
import { resolveInstalledPackVersion } from "./packs/installed-version.js";
import * as packStore from "./packs/pack-store.js";
import * as planStore from "./plans/plan-store.js";
import { resolveOpenablePlanFilePath } from "./plans/safe-plan-file.js";
import { attachPostBootMaintenanceSettle } from "./post-boot-maintenance-settle.js";
import * as prStore from "./pull-requests/pr-store.js";
import type { MeteredUsageRow } from "./reconciliation-worker.js";
import { sendToRendererWindow } from "./renderer-ipc.js";
import {
  coerceAgentComponentFilters,
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "./shared-agent-components-api.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessionDetail,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "./shared-agent-sessions-api.js";
import {
  type BranchCloudHydrationSource,
  type BranchSyncSource,
  getSharedBranchAnalytics,
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchTrace,
  getSharedBranchUsage,
} from "./shared-branches-api.js";
import type {
  PendingTraceCommentSyncOperation,
  UserIdentity,
} from "./shared-trace-comments-store.js";
import {
  postTraceCommentParentSessionCloudSync,
  type TraceCommentParentSessionSyncResult,
} from "./trace-comment-parent-session-cloud-post.js";
import { syncTraceCommentParentSessionPayloads } from "./trace-comment-parent-session-cloud-sync.js";
import type { TraceCommentParentSessionSyncPopOptions } from "./trace-comment-parent-session-sync-pop.js";

type AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => BrowserWindow | null;
  /**
   * True when an IPC event originates from this app's trusted renderer. Wired
   * from `DesktopWindow.isTrustedSender` so every `desktop:db:*` handler gates
   * on sender trust the same way the gateway-dispatch and renderer-otel handler
   * families do — defense-in-depth against a compromised renderer.
   */
  isTrustedSender: (sender: WebContents) => boolean;
  whenInitialWindowShown?: () => Promise<void>;
  whenInitialDashboardDataServed?: () => Promise<void>;
  whenInitialBackgroundWorkAllowed?: () => Promise<void>;
  waitForRendererBackgroundSlot?: () => Promise<void>;
  onFirstDbIpcServed?: () => void;
  onInitialCollectorImportComplete?: () => void;
  getApiKey?: () => string | null;
  getApiOrigin?: () => string;
  getApiKeyProvenance?: TraceCommentParentSessionSyncPopOptions["getApiKeyProvenance"];
  signDesktopRequest?: TraceCommentParentSessionSyncPopOptions["signDesktopRequest"];
  onDesktopPopUnavailable?: TraceCommentParentSessionSyncPopOptions["onDesktopPopUnavailable"];
  getProfileId?: () => string | null;
  getComputeTargetId?: () => string | null;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  onTerminalFailure: (reason: string) => void;
  /**
   * A live agent session reached a terminal status (completed/error). Wired by
   * the app to fire a desktop completion Notification with a click-through to
   * the session detail, gated on the session-completion-notifications flag.
   */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  /**
   * FEA-2715: a Claude hook event arrived (the transcript archive lane uses it
   * to enqueue the session's transcript — terminal events flush immediately,
   * activity events debounce). Fire-and-forget; wired only when the transcript
   * feature flag is on.
   */
  onTranscriptHookEvent?: (
    hookType: string,
    data: Record<string, unknown>
  ) => void;
  userDataPath?: string;
  /**
   * FEA-2648 golden mode: ingest ONLY the staged golden corpus. When set, the
   * OTLP receiver, hook listener, watchers, and the utility-process historical
   * parser stay off; the one-shot boot import parses in-process through
   * corpus-rooted collectors. userData was already redirected to the throwaway
   * golden profile at startup.
   */
  golden?: GoldenModeConfig | null;
  log?: (scope: string, message: string) => void;
  /**
   * Emit an IPC perf wide event (FEA-1997). Wired to the desktop OTel runtime's
   * `emitIpcPerfEvent`; omitted in contexts without a telemetry runtime, in
   * which case the `list`/`detail`/`usage` handlers run uninstrumented.
   */
  emitIpcPerf?: (input: DesktopIpcPerfEventInput) => void;
};

type AgentDashboardLog = NonNullable<
  AgentDashboardDesignSystemRuntimeOptions["log"]
>;

/**
 * FEA-2038: forwards a `store:`-prefixed op (a store fn that takes a callback and
 * must run wholly in the DB host) to the child over IPC. `args` must be
 * structured-clone-safe — never a function.
 */
type InvokeStoreOp = (name: string, args?: unknown[]) => Promise<unknown>;

/**
 * FEA-2264: which post-boot maintenance pass is currently holding the db-host
 * (the data-revision rebuild, then the artifact-link backfill), or none. The
 * renderer's first-launch banner surfaces this so the user has feedback during
 * the window after the boot import settles but before the dashboard is fully
 * ready — the residual freeze window. `null` phase means no pass is active.
 */
export type AgentDashboardMaintenanceProgress = {
  active: boolean;
  phase: "rebuild" | "artifact-links" | null;
};

export type AgentDashboardDesignSystemRuntime = {
  connection: null;
  syncSource: AgentSessionSyncSource | null;
  /** FEA-2715: transcript archive-lane fingerprint/upload-cursor store. */
  transcriptSync: TranscriptSyncStore | null;
  getUrl: () => string | null;
  isReady: () => boolean;
  startHookListener: () => void;
  startCollectors: () => void;
  getIngestProgress: () => {
    byHarness: { harness: string; total: number; processed: number }[];
    total: number;
    processed: number;
    preparing: boolean;
    complete: boolean;
  };
  getMaintenanceProgress: () => AgentDashboardMaintenanceProgress;
  resolveBranchPrIdentity: (
    branchId: string
  ) => Promise<BranchPrIdentity | null>;
  refreshGitHubBranches: (
    body: unknown
  ) => Promise<GitHubResyncNudgeRefreshResult>;
  setImportPaused: (paused: boolean) => void;
  stop: () => Promise<void>;
  close: () => Promise<void> | void;
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

export type GitHubResyncNudgeRefreshResult = {
  body: GitHubResyncNudgeBody;
  branchIds: string[];
};

/**
 * Resolve the opt-in design-system dashboard database. This helper lives inside
 * the dynamic boundary so default/legacy boot never imports code that can create
 * the SQLite data directory.
 */
function resolveAgentDashboardDatabasePath(
  userDataPath = app.getPath("userData")
): string {
  // SQLite (libSQL) is a single file, not the PGlite `.pgdata` directory. The
  // new filename also means existing PGlite installs start fresh on a clean
  // SQLite DB and re-derive everything from the on-disk raw logs.
  return path.join(userDataPath, "agent-dashboard.sqlite");
}

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
  // FEA-2038: SQLite + Prisma + all stores run in a dedicated utilityProcess
  // (the DB host) so the 6–20 GB first-launch backfill never blocks the main
  // thread. The child opens the DB (with billing-mode/git/gh resolvers wired on
  // its side); main only forwards calls and relays the child's change events.
  const dbHost = new DbHostClient({
    onEmit: (sessionId: string) => {
      // The child already invalidated its own session caches before emitting;
      // here we only nudge the renderer to refetch.
      sendToRendererWindow(options.getWindow(), "desktop:db:changed", {
        sessionId,
      });
    },
    onSessionTerminal: options.onSessionTerminal,
    onLog: (message: string) => log("agent-sqlite", message),
  });
  // Forwarding proxy: every consumer below keeps calling `agentDatabase.*`
  // unchanged, but each call executes in the DB host over IPC.
  const agentDatabase = createDbHostAgentDatabase(dbHost);
  const agentDatabasePromise = dbHost
    .start({
      dataDir: resolveAgentDashboardDatabasePath(options.userDataPath),
      identity: options.getUserIdentity?.() ?? null,
    })
    .then(() => agentDatabase);

  // FEA-2038: store ops whose store fn takes a callback (prisma.write) can't run
  // over the method proxy — a function can't cross IPC. They execute wholly in
  // the DB host via `store:`-prefixed invokes.
  const invokeStoreOp = (
    name: string,
    args: unknown[] = []
  ): Promise<unknown> => dbHost.invoke(`store:${name}`, args);
  const cloudHydration = createBranchCloudHydration(options, invokeStoreOp);

  const registerIpcHandlers = () => {
    if (dbIpcRegistered) {
      return;
    }
    dbIpcRegistered = true;
    registerDesignSystemDbIpcHandlers(
      () => agentDatabasePromise,
      options,
      invokeStoreOp,
      cloudHydration
    );
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
      options.whenInitialWindowShown ??
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

  let catalogFetchTimer: ReturnType<typeof setInterval> | null = null;
  if (!golden) {
    runAfterInitialBackgroundWorkAllowed("Initial catalog fetch", async () => {
      await waitForBackgroundSlot();
      await invokeStoreOp("catalog.fetch.run");
    });
    catalogFetchTimer = scheduleCatalogFetch(() =>
      invokeStoreOp("catalog.fetch.run")
    );
  }
  let activePendingTraceCommentSync: Promise<void> | null = null;
  const runPendingTraceCommentSync = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (activePendingTraceCommentSync) {
      await activePendingTraceCommentSync;
      return;
    }
    const sync = runPendingTraceCommentCloudSync(
      invokeStoreOp,
      agentDatabase.syncSource,
      options
    ).finally(() => {
      if (activePendingTraceCommentSync === sync) {
        activePendingTraceCommentSync = null;
      }
    });
    activePendingTraceCommentSync = sync;
    await sync;
  };
  // FEA-2261: the periodic pending-trace-comment retry runs db-host store ops
  // (and, on a 404, syncSource.loadSyncedSessions) every
  // TRACE_COMMENT_BACKGROUND_SYNC_INTERVAL_MS. Route every tick through the
  // serialized startup queue so a retry never overlaps the still-draining startup
  // tasks and always yields a renderer background slot before touching the child
  // loop — that per-tick gate is what keeps the lightweight pending-targets query
  // off the first-launch import.
  //
  // FEA-2931: start the interval behind the fast first-paint gate only, NOT the
  // collector-import settle. Gating the START behind the settle coupled the
  // failed-upload retry SLA (FEA-2242, ~10s) to first-launch maintenance, so a
  // transient 500 went unretried for up to STARTUP_BACKGROUND_COLLECTOR_IMPORT_-
  // FAIL_OPEN_MS (5 min) whenever collectors were idle/disabled/stuck.
  let traceCommentSyncTimer: ReturnType<typeof setInterval> | null = null;
  const startTraceCommentSyncRetryInterval = (): void => {
    if (closed || traceCommentSyncTimer) {
      return;
    }
    traceCommentSyncTimer = setInterval(() => {
      void enqueueStartupBackgroundTask(runPendingTraceCommentSync).catch(
        (error: unknown) =>
          log(
            "trace-comments",
            `Pending sync retry failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
      );
    }, TRACE_COMMENT_BACKGROUND_SYNC_INTERVAL_MS);
  };
  if (!golden) {
    void waitForInitialBackgroundWorkAllowed()
      .then(startTraceCommentSyncRetryInterval)
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
      runPendingTraceCommentSync
    );
  }

  let startPromise: Promise<void> | null = null;

  const collectorsLog = (message: string): void =>
    log("agent-collectors", message);
  // FEA-2648: the utility-process worker rebuilds default home-rooted
  // collectors, which would reject staged corpus sources — golden mode parses
  // in-process through the injected collectors instead.
  const historicalParseRunner = golden
    ? null
    : createUtilityProcessHistoricalParseRunner({
        log: collectorsLog,
      });
  let maintenanceGeneration = 0;
  let maintenanceTask: Promise<void> | null = null;
  // FEA-2264: the live post-boot maintenance phase, surfaced to the renderer via
  // the runtime status payload so the first-launch banner can stay up (with calm
  // copy) across the data-revision rebuild + artifact-link backfill window. Reset
  // to inactive whenever the owning generation finishes or is cancelled.
  let maintenanceProgress: AgentDashboardMaintenanceProgress = {
    active: false,
    phase: null,
  };
  const setMaintenancePhase = (
    generation: number,
    phase: AgentDashboardMaintenanceProgress["phase"]
  ): void => {
    if (!isMaintenanceActive(generation)) {
      return;
    }
    maintenanceProgress = { active: true, phase };
  };
  const clearMaintenanceProgress = (): void => {
    maintenanceProgress = { active: false, phase: null };
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

  // FEA-1839: detect a harness session emitted by BOTH the hook handler and the
  // live watcher (a double-counting bug) and persist one violation row.
  const mutualExclusivityMonitor = createMutualExclusivityMonitor({
    onViolation: (harness, externalSessionId) => {
      void agentDatabase.recordCollectionModeViolation(
        harness,
        externalSessionId
      );
    },
    log: collectorsLog,
  });

  const otlpReceiver = new OtlpHttpReceiver({
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
    lifecycle: {
      processEvent: (hookType, data, harness) => {
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

  const runPostBootMaintenance = async (generation: number): Promise<void> => {
    const shouldContinue = () => isMaintenanceActive(generation);
    setMaintenancePhase(generation, "rebuild");
    const rebuildCancelled = await runDataRevisionMaintenance(shouldContinue);
    if (rebuildCancelled || !shouldContinue()) {
      return;
    }
    setMaintenancePhase(generation, "artifact-links");
    await runArtifactLinkBackfillMaintenance(shouldContinue);
    if (!shouldContinue()) {
      return;
    }
    // FEA-2267: re-derive activity-segment tiling for sessions scanned at an
    // older ACTIVITY_CLASSIFIER_VERSION (or never scanned), under the same
    // generation/shouldContinue cancellation guard.
    await runActivitySegmentBackfillMaintenance(shouldContinue);
  };

  // Returns true only when cancellation should block subsequent maintenance.
  const runDataRevisionMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<boolean> => {
    try {
      const summary = await runDataRevisionRebuild({
        collectors: collectorManager.getCollectors(),
        db: agentDatabase,
        log: collectorsLog,
        shouldContinue,
        cooperativeDelay: backgroundDelay,
        parseSource: (collector, source) =>
          historicalParseRunner
            ? historicalParseRunner.parseSource(collector.key, source)
            : collector.parse(source),
      });
      if (!shouldContinue()) {
        return true;
      }
      if (
        summary.rebuilt > 0 ||
        summary.deleted > 0 ||
        summary.missingSourceRollupsRecomputed > 0
      ) {
        // The rebuild mutates rows outside the hook/import emit paths —
        // drop the cached historical list and nudge the renderer or the
        // dashboard keeps serving pre-rebuild numbers. (FEA-2641: the
        // missing-source rollup recompute mutates session_analytics the same
        // out-of-band way.)
        agentDatabase.sessions.invalidateHistoricalDetails();
        sendToRendererWindow(options.getWindow(), "desktop:db:changed", {});
      }
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return true;
      }
      collectorsLog(
        `data-revision rebuild failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
    return false;
  };

  const runPostBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    // Runs in the DB host via a clone-safe method; its `prisma.write` callback
    // can't cross the method proxy from here. See database/pr-link-maintenance.ts.
    const remediated = await agentDatabase.remediateMisattributedPrBranches();
    if (!shouldContinue()) {
      return;
    }
    const linked = await agentDatabase.propagateAllBranchPrLinks();
    if (!shouldContinue()) {
      return;
    }
    if (remediated > 0 || linked > 0) {
      sendToRendererWindow(options.getWindow(), "desktop:db:changed", {});
    }
  };

  const runArtifactLinkBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    try {
      await runArtifactLinkBackfillRuntimeBoundary({
        invokeStoreOp,
        shouldContinue,
        getWindow: options.getWindow,
        triggerEnrichmentSweep: () => Promise.resolve(),
        onEnrichmentSweepFailure: (e: unknown) =>
          collectorsLog(
            `Post-backfill sweep failed: ${e instanceof Error ? e.message : String(e)}`
          ),
      });
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return;
      }
      collectorsLog(
        `artifact-link backfill failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    if (!shouldContinue()) {
      return;
    }
    await runPostBackfillMaintenance(shouldContinue);
  };

  const runActivitySegmentBackfillMaintenance = async (
    shouldContinue: () => boolean
  ): Promise<void> => {
    try {
      await runActivitySegmentBackfillRuntimeBoundary({
        invokeStoreOp,
        shouldContinue,
        getWindow: options.getWindow,
      });
    } catch (e: unknown) {
      if (!shouldContinue()) {
        return;
      }
      collectorsLog(
        `activity-segment backfill failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  const cancelCollectorMaintenance = async (): Promise<void> => {
    maintenanceGeneration++;
    // FEA-2264: the bumped generation makes the in-flight task's finalizer skip
    // the clear (it no longer owns the runtime), so reset here directly — a
    // cancelled maintenance window must not leave the banner showing "finishing
    // up" forever.
    clearMaintenanceProgress();
    collectorManager.stop();
    historicalParseRunner?.stop();
    const task = maintenanceTask;
    if (task) {
      await task.catch(() => {});
    }
  };

  // FEA-2648: stage the frozen corpus into the golden profile before any
  // collector sees it — even a readOnly open of the WAL-mode opencode.db would
  // drop -wal/-shm sidecars into the human-owned raw/ dirs.
  const goldenStagingDir = golden
    ? path.join(
        options.userDataPath ?? app.getPath("userData"),
        "corpus-staging"
      )
    : null;
  if (golden && goldenStagingDir) {
    stageGoldenCorpus(golden.corpusDir, goldenStagingDir);
  }

  const collectorManager = new CollectorManager({
    importer: agentDatabase.importer,
    detectBillingMode,
    stateDir: path.join(
      options.userDataPath ?? app.getPath("userData"),
      "agent-dashboard-ingest"
    ),
    emit: (sessionId?: string) => {
      sendToRendererWindow(options.getWindow(), "desktop:db:changed", {
        sessionId,
      });
    },
    ...(goldenStagingDir
      ? { collectors: createGoldenCollectors(goldenStagingDir) }
      : {}),
    // Golden mode forces "disabled": the one-shot historical import still runs,
    // but no fs.watch ever attaches.
    getCollectionMode: goldenStagingDir
      ? () => "disabled"
      : (harness) => getActiveCollectionMode(harness, currentHooksState()),
    onWatcherEmission: (harness, externalSessionId) => {
      mutualExclusivityMonitor.record(harness, externalSessionId, "watcher");
    },
    // Historical parsing runs in a utility process, and main-process DB writes
    // yield between sessions so there is no delayed CPU cliff after startup.
    historicalImportDelayMs: desktopHistoricalImportDelayMs,
    historicalImportStaggerMs: desktopHistoricalImportStaggerMs,
    catchupPollMs: desktopCatchupPollMs,
    ...(historicalParseRunner ? { historicalParseRunner } : {}),
    log: collectorsLog,
    cooperativeDelay: backgroundDelay,
    waitForRendererBackgroundSlot: waitForBackgroundSlot,
    onBootImportComplete: schedulePostBootMaintenance,
    // Self-heal catchup-cache/DB divergence: after a DB reset/migration the
    // JSON ingest cache still marks codex/claude sources "seen", but their rows
    // are gone. Surfacing the live id set lets the manager re-import orphans.
    listExistingSessionIds: () => agentDatabase.listExistingSessionIds(),
    deleteSessionRow: (sessionId) => agentDatabase.deleteSessionRow(sessionId),
  });

  // Gap 3: API error watchdog — polls active sessions for stale Stop events
  // with error summaries that the live hook path may have missed. Its status
  // writes go through `prisma.write`, serializing at the shared write queue.
  const watchdog = createApiErrorWatchdog(agentDatabase, {
    log: (message: string) => collectorsLog(`watchdog: ${message}`),
  });

  // FEA-1999: periodic SQLite store integrity-health probe. Runs on the reader
  // pool (off the write/IPC hot path), skipped while the first-launch backfill
  // is in progress, and emits a redacted fleet health signal via the
  // Observability facade (which owns the emit cadence).
  const storeIntegrityProbe = createStoreIntegrityProbe(agentDatabase, {
    emit: (diagnostics) => Observability.storeIntegrityResult(diagnostics),
    isBootImportInProgress: () => {
      const progress = collectorManager.getIngestProgress();
      // `preparing` covers the pre-scan phase where the source enumeration is
      // running but the total is still 0, so quick_check does not contend with
      // the first-launch backfill before its progress total is known.
      return (
        progress.preparing ||
        (progress.total > 0 && progress.processed < progress.total)
      );
    },
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
    getMaintenanceProgress: () => maintenanceProgress,
    resolveBranchPrIdentity: async (branchId) => {
      const detail = await getSharedBranchDetail(
        toBranchSyncSource(agentDatabase),
        branchId
      );
      if (!detail) {
        return null;
      }
      return {
        repoFullName: detail.repoFullName,
        prNumber: detail.prNumber,
        prUrl: detail.prUrl,
      };
    },
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
        watchdog.start();
        storeIntegrityProbe.start();
      });
    },
    stop: async () => {
      if (closed) {
        return;
      }
      startPromise = null;
      watchdog.stop();
      storeIntegrityProbe.stop();
      await cancelCollectorMaintenance();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
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
      watchdog.stop();
      storeIntegrityProbe.stop();
      if (catalogFetchTimer) {
        clearInterval(catalogFetchTimer);
        catalogFetchTimer = null;
      }
      if (traceCommentSyncTimer) {
        clearInterval(traceCommentSyncTimer);
        traceCommentSyncTimer = null;
      }
      traceCommentCloudSyncErrorLogTimes.clear();
      if (dbIpcRegistered) {
        unregisterDesignSystemDbIpcHandlers();
        dbIpcRegistered = false;
      }
      await cancelCollectorMaintenance();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
      await dbHost.close();
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
  };

  return runtime;
}

function registerDesignSystemDbIpcHandlers(
  getAgentDatabase: () => Promise<DbHostAgentDatabase>,
  options: AgentDashboardDesignSystemRuntimeOptions,
  invokeStoreOp: InvokeStoreOp,
  cloudHydration: BranchCloudHydrationSource | undefined
): void {
  unregisterDesignSystemDbIpcHandlers();

  let firstDbIpcServed = false;
  const notifyFirstDbIpcServed = (): void => {
    if (firstDbIpcServed) {
      return;
    }
    firstDbIpcServed = true;
    options.onFirstDbIpcServed?.();
  };

  const withDb =
    <TArgs extends unknown[], TResult>(
      handler: (
        agentDatabase: DbHostAgentDatabase,
        ...args: TArgs
      ) => TResult | Promise<TResult>
    ) =>
    async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<TResult> => {
      // Sender trust gates the entire handler (matches gateway-dispatch-ipc and
      // renderer-otel-ipc). Reject IPC from any frame other than the trusted
      // renderer before touching the DB so a compromised renderer cannot reach
      // host-side handlers like open-plan/open-pr.
      if (!options.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      const result = await handler(await getAgentDatabase(), ...args);
      notifyFirstDbIpcServed();
      return result;
    };

  // Hands a store handler the clone-safe Prisma reader (prisma.client). Writes
  // can't cross the db-host proxy, so they run in the child via invokeStoreOp,
  // never here; DbHostPrisma omits prisma.read/write so that is a compile error.
  const withPrisma = <TArgs extends unknown[], TResult>(
    handler: (
      prisma: DbHostAgentDatabase["prisma"],
      ...args: TArgs
    ) => TResult | Promise<TResult>
  ) =>
    withDb((agentDatabase, ...args: TArgs) =>
      handler(agentDatabase.prisma, ...args)
    );

  ipcMain.handle(
    "desktop:db:get-sessions",
    withDb((agentDatabase) => agentDatabase.sessions.getAll())
  );

  ipcMain.handle(
    "desktop:db:get-sessions-page",
    withDb((agentDatabase, request: unknown) =>
      agentDatabase.sessions.getPage(coerceSessionPageRequest(request))
    )
  );

  ipcMain.handle(
    "desktop:db:get-kanban-pages",
    withDb((agentDatabase, statuses: unknown, limit: unknown) => {
      const safeStatuses = Array.isArray(statuses)
        ? statuses.filter((s): s is string => typeof s === "string")
        : [];
      const safeLimit =
        typeof limit === "number" && Number.isInteger(limit)
          ? Math.min(Math.max(limit, 1), 100)
          : 25;
      return agentDatabase.sessions.getKanbanPages(safeStatuses, safeLimit);
    })
  );

  ipcMain.handle(
    "desktop:db:get-session",
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getById(sessionId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-session-details",
    withDb((agentDatabase, id: unknown) => {
      const sessionId = coerceDbId(id);
      if (sessionId === null) {
        return undefined;
      }
      return agentDatabase.sessions.getDetailsById(sessionId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-agents",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySession(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-events",
    withDb((agentDatabase, sessionId: unknown, agentId?: unknown) => {
      const sid = coerceDbId(sessionId);
      if (sid === null) {
        return [];
      }
      const aid = coerceDbId(agentId);
      if (aid !== null) {
        return agentDatabase.events.getBySessionAndAgent(sid, aid);
      }
      return agentDatabase.events.getBySession(sid);
    })
  );

  ipcMain.handle(
    "desktop:db:get-dashboard-summary",
    withDb((agentDatabase) => agentDatabase.getSummary())
  );

  ipcMain.handle(
    "desktop:db:get-sessions-with-details",
    withDb((agentDatabase) => agentDatabase.sessions.getAllWithDetails())
  );

  ipcMain.handle(
    "desktop:db:get-event-feed",
    withDb((agentDatabase) => agentDatabase.events.getAll())
  );

  ipcMain.handle(
    "desktop:db:get-events-with-session",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.events.getWithSession(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-event-count-by-type",
    withDb((agentDatabase) => agentDatabase.events.getCountByType())
  );

  ipcMain.handle(
    "desktop:db:get-token-analytics",
    withDb((agentDatabase) => agentDatabase.dashboard.getTokenAnalytics())
  );

  ipcMain.handle(
    "desktop:db:get-insights",
    withDb(
      async (
        agentDatabase,
        section: unknown,
        period: unknown,
        scope: unknown
      ) => {
        const parsedSection = coerceInsightsSection(section);
        const parsedPeriod = coerceInsightsPeriod(period);
        const parsedScope = coerceDesktopInsightsScope(scope);
        if (parsedScope === null) {
          throw new Error("Desktop Insights does not support team scope");
        }
        if (parsedScope === InsightsScopeValues.Org) {
          const cloud = await fetchCloudInsights(
            parsedSection,
            parsedPeriod,
            options
          );
          if (cloud) {
            return cloud;
          }
          return buildUnavailableCloudInsightsResponse(parsedSection);
        }
        // Concurrency is bounded on the db-host side: this call dispatches to
        // the worker's `dashboard.getInsights` op, which runs behind the
        // FEA-2055 `InsightsResultCache` (see insights-cache.ts). That gate
        // caps how many heavy metadata scans compute at once (default 1) at the
        // compute-miss boundary — AFTER its fresh/stale-serve fast returns — so
        // a burst of section widgets can't stampede the worker's heap, while
        // cache hits during backfill still return immediately.
        return agentDatabase.dashboard.getInsights(parsedSection, parsedPeriod);
      }
    )
  );

  ipcMain.handle(
    "desktop:db:get-agent-hierarchy",
    withDb((agentDatabase, sessionId: unknown) => {
      const id = coerceDbId(sessionId);
      if (id === null) {
        return [];
      }
      return agentDatabase.agents.getBySessionWithChildren(id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-analytics",
    withDb((agentDatabase) => agentDatabase.dashboard.getAnalytics())
  );

  ipcMain.handle(
    "desktop:db:get-workflow-data",
    withDb((agentDatabase) => agentDatabase.dashboard.getWorkflowData())
  );

  ipcMain.handle(
    "desktop:db:get-core-features",
    withDb((agentDatabase) => agentDatabase.dashboard.getCoreFeatures())
  );

  ipcMain.handle(
    "desktop:db:get-packs",
    withDb((agentDatabase) => agentDatabase.dashboard.getPacks())
  );

  ipcMain.handle(
    "desktop:db:get-skills",
    withDb((agentDatabase) => agentDatabase.dashboard.getSkills())
  );

  ipcMain.handle(
    "desktop:db:get-tools",
    withDb((agentDatabase) => agentDatabase.dashboard.getTools())
  );

  ipcMain.handle(
    "desktop:db:get-subagents",
    withDb((agentDatabase) => agentDatabase.dashboard.getSubAgents())
  );

  ipcMain.handle(
    "desktop:db:get-plans",
    withDb((agentDatabase) => agentDatabase.dashboard.getPlans())
  );

  ipcMain.handle(
    "desktop:db:get-pull-requests",
    withDb((agentDatabase) => agentDatabase.dashboard.getPullRequests())
  );

  // --- Diagnostics (FEA-1959) ---
  ipcMain.handle(
    "desktop:db:get-diagnostics",
    withDb((agentDatabase) => agentDatabase.diagnostics.getData())
  );

  // --- Catalog (FEA-1314) ---
  ipcMain.handle(
    "desktop:db:get-catalog",
    withPrisma((prisma) => catalogStore.listCatalog(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-catalog-entry",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return catalogStore.getCatalog(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-readme",
    withPrisma(async (prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      const entry = await catalogStore.getCatalog(prisma, packId);
      return entry?.readmeExcerpt ?? null;
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-contents",
    withPrisma(async (prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      const entry = await catalogStore.getCatalog(prisma, packId);
      if (!entry) {
        return null;
      }
      // FEA-2038: refreshCatalogContents ends in prisma.write — run it in the DB
      // host (it can't cross the method proxy). The reads stay on the proxy.
      await invokeStoreOp("catalog.contents.refresh", [entry]);
      const refreshed = await catalogStore.getCatalog(prisma, packId);
      return refreshed?.contentsCache ?? null;
    })
  );

  ipcMain.handle(
    "desktop:db:get-catalog-history",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return [];
      }
      return catalogStore.listHistory(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:catalog-install",
    withDb(
      async (
        agentDatabase,
        packId: unknown,
        harness: unknown,
        cwd?: unknown
      ) => {
        if (typeof packId !== "string" || typeof harness !== "string") {
          return { started: false };
        }
        return streamRun(agentDatabase, {
          pack_id: packId,
          harness,
          action: "install",
          cwd: typeof cwd === "string" ? cwd : undefined,
          getWindow: options.getWindow,
          // FEA-2038: the CLI spawn + output streaming stays in main (streamRun
          // here); only the post-install rescan runs in the DB host. The
          // run-record writes now serialize via prisma.write on the one client.
          onComplete: () =>
            void invokeStoreOp("packScanner.run").catch(() => {}),
        });
      }
    )
  );

  ipcMain.handle(
    "desktop:db:catalog-uninstall",
    withDb(
      async (
        agentDatabase,
        packId: unknown,
        harness: unknown,
        cwd?: unknown
      ) => {
        if (typeof packId !== "string" || typeof harness !== "string") {
          return { started: false };
        }
        return streamRun(agentDatabase, {
          pack_id: packId,
          harness,
          action: "uninstall",
          cwd: typeof cwd === "string" ? cwd : undefined,
          getWindow: options.getWindow,
          // FEA-2038: CLI spawn + streaming stay in main; only the post-uninstall
          // rescan runs in the DB host. Run-record writes go through prisma.write.
          onComplete: () =>
            void invokeStoreOp("packScanner.run").catch(() => {}),
        });
      }
    )
  );

  // FEA-2038: runCatalogFetch's prisma.write can't cross the method proxy, so
  // the whole fetch runs in the DB host. withDb keeps the DB-readiness await +
  // first-IPC signal that withPrisma provided.
  ipcMain.handle(
    "desktop:db:catalog-refresh",
    withDb(() => invokeStoreOp("catalog.fetch.run"))
  );

  ipcMain.handle(
    "desktop:db:get-install-runs",
    withPrisma((prisma, packId?: unknown) =>
      catalogStore.listInstallRuns(
        prisma,
        typeof packId === "string" ? { pack_id: packId } : {}
      )
    )
  );

  // --- Installed Packs (FEA-1224) ---

  ipcMain.handle(
    "desktop:db:get-installed-packs",
    withPrisma((prisma) => packStore.listPacks(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-pack-detail",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return null;
      }
      return packStore.getPack(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-pack-sessions",
    withPrisma((prisma, packId: unknown) => {
      if (typeof packId !== "string") {
        return [];
      }
      return packStore.listPackSessions(prisma, packId);
    })
  );

  ipcMain.handle(
    "desktop:db:get-all-skills",
    withPrisma((prisma) => packStore.listSkills(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-skill-invocations",
    withPrisma((prisma, name: unknown) => {
      if (typeof name !== "string") {
        return [];
      }
      return packStore.listSkillInvocations(prisma, name);
    })
  );

  ipcMain.handle(
    "desktop:db:get-recent-projects",
    withPrisma(async (prisma) => {
      const rows = await prisma.client.$queryRawUnsafe<{ cwd: string }[]>(
        `SELECT cwd
       FROM sessions
       WHERE cwd IS NOT NULL AND cwd != ''
       GROUP BY cwd
       ORDER BY MAX(started_at) DESC NULLS LAST
       LIMIT 20`
      );
      return rows.map((r) => r.cwd);
    })
  );

  // --- Plans (FEA-1189) ---

  ipcMain.handle(
    "desktop:db:get-plans-list",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return planStore.listPlans(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        needsConfirmation:
          typeof o.needsConfirmation === "boolean"
            ? o.needsConfirmation
            : undefined,
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:get-plan",
    withPrisma((prisma, id: unknown) => {
      if (typeof id !== "string") {
        return null;
      }
      return planStore.getPlan(prisma, id);
    })
  );

  ipcMain.handle(
    "desktop:db:get-plan-versions",
    withPrisma((prisma, planId: unknown) => {
      if (typeof planId !== "string") {
        return [];
      }
      return planStore.getPlanVersions(prisma, planId);
    })
  );

  // FEA-2038: confirmPlan/rejectPlan use prisma.write — run in the DB host.
  ipcMain.handle(
    "desktop:db:confirm-plan",
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.confirm", [id]);
    })
  );

  ipcMain.handle(
    "desktop:db:reject-plan",
    withDb((_agentDatabase, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      return invokeStoreOp("plans.reject", [id]);
    })
  );

  ipcMain.handle(
    "desktop:db:open-plan",
    withPrisma(async (prisma, id: unknown, target?: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      const plan = await planStore.getPlan(prisma, id);
      if (!plan) {
        return;
      }
      const filePath = String(
        target === "log" ? plan.sourceLogPath : plan.filePath
      );
      if (filePath && filePath !== "null" && filePath !== "undefined") {
        // shell.openPath hands the path to the OS file association, which would
        // *execute* a `.command`/`.app`/script the store row points at. Only
        // open real files inside the agent homes with a non-executable
        // extension; reject anything else (poisoned sync record / spoofed row).
        const safePath = resolveOpenablePlanFilePath(filePath, [
          // Plan backfill roots plansDir at Electron's app home (see
          // backfillClaudePlans); include it so it is accepted even when
          // app.getPath("home") diverges from os.homedir().
          path.join(app.getPath("home"), ".claude"),
        ]);
        if (safePath) {
          void shell.openPath(safePath);
        } else {
          options.log?.(
            "agent-dashboard",
            `Refused to open plan path outside allowed roots: ${filePath}`
          );
        }
      }
    })
  );

  // --- Pull Requests (FEA-1226) ---

  ipcMain.handle(
    "desktop:db:get-pr-stats",
    withPrisma((prisma) => prStore.getPrStats(prisma))
  );

  ipcMain.handle(
    "desktop:db:get-pr-sessions",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return prStore.listPrSessions(prisma, {
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:get-pr-list",
    withPrisma((prisma, opts?: unknown) => {
      const o =
        typeof opts === "object" && opts !== null
          ? (opts as Record<string, unknown>)
          : {};
      return prStore.listPullRequests(prisma, {
        sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
        repo: typeof o.repo === "string" ? o.repo : undefined,
        limit: typeof o.limit === "number" ? o.limit : undefined,
        offset: typeof o.offset === "number" ? o.offset : undefined,
      });
    })
  );

  ipcMain.handle(
    "desktop:db:open-pr",
    withPrisma(async (prisma, id: unknown) => {
      if (typeof id !== "string") {
        return;
      }
      const prs = await prStore.listPullRequests(prisma);
      const pr = prs.find((p) => p.id === id);
      const prUrl = pr?.prUrl;
      if (typeof prUrl === "string" && isAllowedExternalUrl(prUrl)) {
        void shell.openExternal(prUrl);
      }
    })
  );

  // FEA-2211: surface a failed perf `session_count` COUNT (best-effort; falls
  // back to 0) so a silent zero is observable in the desktop log.
  const onSessionCountError = (error: unknown): void =>
    options.log?.(
      "agent-dashboard",
      `ipc perf session_count query failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  const ipcPerfOptions = { onSessionCountError };
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.List,
        options.emitIpcPerf,
        (agentDatabase, request: unknown) =>
          getSharedAgentSessions(
            agentDatabase.syncSource,
            coerceSharedQuery(request)
          ),
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.Detail,
        options.emitIpcPerf,
        (agentDatabase, id: unknown) =>
          getSharedAgentSessionDetail(agentDatabase.syncSource, id),
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.Usage,
        options.emitIpcPerf,
        (agentDatabase, request: unknown) =>
          getSharedAgentSessionUsage(
            agentDatabase.syncSource,
            coerceSharedQuery(request)
          ),
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedAgentSessionAnalytics(
        agentDatabase.syncSource,
        coerceSharedQuery(request)
      )
    )
  );

  // Branches (PLN-983 / Epic A) — A2 is the SOLE registrar of these four
  // channels. Downstream chunks (B1 list, D1 detail, A3 usage/analytics, B6
  // analytics extras) flesh out only the handler bodies in shared-branches-api.ts
  // and MUST NOT re-register here (a duplicate ipcMain.handle throws). The branch
  // serving reads through the same SQLite handle the sessions handlers use.
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.list,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranches(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        cloudHydration
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.detail,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchDetail(
        toBranchSyncSource(agentDatabase),
        coerceSharedBranchDetailId(request),
        cloudHydration,
        { forceRefresh: coerceSharedBranchForceRefresh(request) }
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.trace,
    withDb((agentDatabase, id: unknown) =>
      getSharedBranchTrace(toBranchSyncSource(agentDatabase), id)
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.usage,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchUsage(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchAnalytics(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        cloudHydration
      )
    )
  );

  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.list,
    withDb(async (agentDatabase, target: unknown) => {
      const parsedTarget = coerceTraceCommentTarget(target);
      if (!parsedTarget) {
        return [];
      }
      await runTraceCommentCloudSync(
        invokeStoreOp,
        agentDatabase.syncSource,
        parsedTarget,
        options
      ).catch((error) =>
        logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
      );
      return listLocalTraceComments(
        invokeStoreOp,
        parsedTarget,
        getTraceCommentStoreScope(options)
      );
    })
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.create,
    withDb(async (agentDatabase, target: unknown, draft: unknown) => {
      const parsedTarget = coerceTraceCommentTarget(target);
      const parsedDraft = coerceTraceCommentDraft(draft);
      if (!(parsedTarget && parsedDraft)) {
        throw new Error("Invalid trace comment IPC payload.");
      }
      const created = await createLocalTraceComment(
        invokeStoreOp,
        parsedTarget,
        parsedDraft,
        getTraceCommentStoreScope(options)
      );
      void runTraceCommentCloudSync(
        invokeStoreOp,
        agentDatabase.syncSource,
        parsedTarget,
        options
      ).catch((error) =>
        logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
      );
      return created;
    })
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.reply,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        commentId: unknown,
        draft: unknown
      ) => {
        const parsedTarget = coerceTraceCommentTarget(target);
        const parsedCommentId = coerceTraceCommentId(commentId);
        const parsedDraft = coerceTraceCommentReplyDraft(draft);
        if (!(parsedTarget && parsedCommentId && parsedDraft)) {
          throw new Error("Invalid trace comment reply IPC payload.");
        }
        const updated = await createLocalTraceCommentReply(
          invokeStoreOp,
          parsedTarget,
          parsedCommentId,
          parsedDraft,
          getTraceCommentStoreScope(options)
        );
        void runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return updated;
      }
    )
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.update,
    withDb(
      async (
        agentDatabase,
        target: unknown,
        commentId: unknown,
        update: unknown
      ) => {
        const parsedTarget = coerceTraceCommentTarget(target);
        const parsedCommentId = coerceTraceCommentId(commentId);
        const parsedUpdate = coerceTraceCommentUpdate(update);
        if (!(parsedTarget && parsedCommentId && parsedUpdate)) {
          throw new Error("Invalid trace comment IPC payload.");
        }
        const updated = await updateLocalTraceComment(
          invokeStoreOp,
          parsedTarget,
          parsedCommentId,
          parsedUpdate,
          getTraceCommentStoreScope(options)
        );
        void runTraceCommentCloudSync(
          invokeStoreOp,
          agentDatabase.syncSource,
          parsedTarget,
          options
        ).catch((error) =>
          logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
        );
        return updated;
      }
    )
  );
  ipcMain.handle(
    SHARED_TRACE_COMMENTS_IPC_CHANNELS.delete,
    withDb(async (agentDatabase, target: unknown, commentId: unknown) => {
      const parsedTarget = coerceTraceCommentTarget(target);
      const parsedCommentId = coerceTraceCommentId(commentId);
      if (!(parsedTarget && parsedCommentId)) {
        throw new Error("Invalid trace comment IPC payload.");
      }
      const deleted = await deleteLocalTraceComment(
        invokeStoreOp,
        parsedTarget,
        parsedCommentId,
        getTraceCommentStoreScope(options)
      );
      void runTraceCommentCloudSync(
        invokeStoreOp,
        agentDatabase.syncSource,
        parsedTarget,
        options
      ).catch((error) =>
        logTraceCommentCloudSyncError(options, "sync", parsedTarget, error)
      );
      return deleted;
    })
  );

  // --- Optimization analytics (FEA-2923 / AC-022 / T-16.11) ---
  // All three handlers read from local SQLite only (agent_component_session_usage
  // + token_events/token_usage + claude_code_api_request) via withPrisma. Raw SQL
  // is required because token_events is @@ignore'd (no Prisma delegate) and the
  // joins span multiple tables without Prisma relations.

  ipcMain.handle(
    "desktop:db:get-component-model-trend",
    withPrisma(
      async (
        prisma,
        componentKind: unknown,
        componentKey: unknown,
        modelFilter?: unknown,
        days?: unknown
      ) => {
        if (
          typeof componentKind !== "string" ||
          typeof componentKey !== "string"
        ) {
          return {
            componentKind: "",
            componentKey: "",
            windowDays: 0,
            points: [],
          };
        }
        const windowDays =
          typeof days === "number" && days > 0 && days <= 365 ? days : 30;
        const modelArg =
          typeof modelFilter === "string" && modelFilter.length > 0
            ? modelFilter
            : null;

        // FEA-3006: cutoff as a LOCAL calendar day, matching the localDay()
        // buckets the queries below GROUP BY (and the rest of desktop Insights).
        const cutoffDay = localCutoffDay(windowDays);

        // Join agent_component_session_usage to token_events on session_id,
        // group by (model, day). token_events is @@ignore, so raw SQL required.
        const modelFilter_ = modelArg ? "AND te.model = ?" : "";
        // The latency query joins claude_code_api_request (alias `car`) instead
        // of token_events (`te`), so its model predicate must reference
        // car.model — reusing modelFilter_ here would emit `te.model` against a
        // query with no `te` table (SQLITE_ERROR: no such column: te.model).
        const latencyModelFilter_ = modelArg ? "AND car.model = ?" : "";
        const modelArgs_ = modelArg ? [modelArg] : [];

        const tokenRows = await prisma.client.$queryRawUnsafe<
          {
            day: string;
            model: string;
            input_tokens: bigint;
            output_tokens: bigint;
            cache_read_tokens: bigint;
            cache_write_tokens: bigint;
            cost_usd: number | null;
          }[]
        >(
          `SELECT
            ${localDay("s.started_at")} AS day,
            te.model,
            COALESCE(SUM(te.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(te.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(te.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(te.cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(te.cost_usd_estimated), 0) AS cost_usd
          FROM (
            -- FEA-2990: a session may now hold several usage rows for one
            -- component (one per git_branch). Collapse to one session row before
            -- the token join so per-branch splits don't fan out the sums.
            SELECT DISTINCT session_id
            FROM agent_component_session_usage
            WHERE component_kind = ? AND component_key = ?
          ) acsu
          INNER JOIN sessions s ON s.id = acsu.session_id
          INNER JOIN token_events te ON te.session_id = acsu.session_id
          -- FEA-3006 / FEA-2430: bucket the Day axis by the session's LOCAL day
          -- (localDay of the raw started_at), never the storage-only UTC
          -- started_day column, so this panel agrees with the rest of Insights.
          WHERE ${localDay("s.started_at")} >= ?
            ${modelFilter_}
          GROUP BY day, te.model
          ORDER BY day ASC, te.model ASC`,
          componentKind,
          componentKey,
          cutoffDay,
          ...modelArgs_
        );

        // Latency: mean and max per (model, day) from claude_code_api_request
        // using the session ids that touched this component. These are AVG/MAX,
        // NOT true percentiles — labeled honestly as avg/max so a single slow
        // request cannot masquerade as a "p90". (SQLite has no percentile_cont;
        // computing true percentiles would require a window-function pass over
        // every duration row, which is not warranted for this dashboard.)
        const latencyRows = await prisma.client.$queryRawUnsafe<
          {
            day: string;
            model: string;
            avg_ms: number | null;
            max_ms: number | null;
          }[]
        >(
          `SELECT
            ${localDay("s.started_at")} AS day,
            car.model,
            AVG(car.duration_ms) AS avg_ms,
            MAX(car.duration_ms) AS max_ms
          FROM (
            -- FEA-2990: collapse per-branch usage rows to one session row before
            -- the api-request join so per-branch splits don't fan out the
            -- AVG/MAX latency aggregates.
            SELECT DISTINCT session_id
            FROM agent_component_session_usage
            WHERE component_kind = ? AND component_key = ?
          ) acsu
          INNER JOIN sessions s ON s.id = acsu.session_id
          INNER JOIN claude_code_api_request car ON car.session_id = acsu.session_id
          -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
          -- storage-only UTC started_day column.
          WHERE ${localDay("s.started_at")} >= ?
            ${latencyModelFilter_}
          GROUP BY day, car.model
          ORDER BY day ASC, car.model ASC`,
          componentKind,
          componentKey,
          cutoffDay,
          ...modelArgs_
        );

        // Compaction: count sessions per (model, day) that emitted an actual
        // context-compaction event. The prior proxy (cache_write_tokens > 0)
        // fired on nearly every session once prompt caching is on, so it tracked
        // session count, not truncation. The `events` table records a real
        // 'Compaction' event per context-window compaction (write-core.ts, from
        // the parser's session.compactions), which is the authoritative signal.
        // Compaction is session-level (model-agnostic); we keep the (day, model)
        // grouping by attributing a compacted session to each model it used that
        // day, joining events on session_id.
        const compactionRows = await prisma.client.$queryRawUnsafe<
          { day: string; model: string; compaction_count: bigint }[]
        >(
          `SELECT
            ${localDay("s.started_at")} AS day,
            te.model,
            COUNT(DISTINCT acsu.session_id) AS compaction_count
          FROM agent_component_session_usage acsu
          INNER JOIN sessions s ON s.id = acsu.session_id
          INNER JOIN token_events te ON te.session_id = acsu.session_id
          INNER JOIN events ev
            ON ev.session_id = acsu.session_id
            AND ev.event_type = 'Compaction'
          WHERE acsu.component_kind = ?
            AND acsu.component_key = ?
            -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
            -- storage-only UTC started_day column.
            AND ${localDay("s.started_at")} >= ?
            ${modelFilter_}
          GROUP BY day, te.model`,
          componentKind,
          componentKey,
          cutoffDay,
          ...modelArgs_
        );

        // Index latency + compaction by "day:model" for O(N) merge.
        const latencyByKey = new Map<
          string,
          { avg_ms: number | null; max_ms: number | null }
        >();
        for (const r of latencyRows) {
          latencyByKey.set(`${r.day}:${r.model}`, {
            avg_ms: r.avg_ms,
            max_ms: r.max_ms,
          });
        }
        const compactionByKey = new Map<string, number>();
        for (const r of compactionRows) {
          compactionByKey.set(
            `${r.day}:${r.model}`,
            Number(r.compaction_count)
          );
        }

        const points = tokenRows.map((r) => {
          const key = `${r.day}:${r.model}`;
          const latency = latencyByKey.get(key);
          return {
            day: r.day,
            model: r.model,
            inputTokens: Number(r.input_tokens),
            outputTokens: Number(r.output_tokens),
            cacheReadTokens: Number(r.cache_read_tokens),
            cacheWriteTokens: Number(r.cache_write_tokens),
            estimatedCostUsd: r.cost_usd ?? null,
            latencyAvgMs: latency?.avg_ms ?? null,
            latencyMaxMs: latency?.max_ms ?? null,
            compactionCount: compactionByKey.get(key) ?? 0,
          };
        });

        return {
          componentKind,
          componentKey,
          windowDays,
          points,
        };
      }
    )
  );

  ipcMain.handle(
    "desktop:db:get-subagent-frequency",
    withPrisma(async (prisma, subagentKey: unknown, days?: unknown) => {
      if (typeof subagentKey !== "string") {
        return { subagentKey: "", windowDays: 0, points: [] };
      }
      const windowDays =
        typeof days === "number" && days > 0 && days <= 365 ? days : 30;

      // FEA-3006: cutoff as a LOCAL calendar day, matching the localDay()
      // buckets below (and the rest of desktop Insights).
      const cutoffDay = localCutoffDay(windowDays);

      const rows = await prisma.client.$queryRawUnsafe<
        { day: string; session_count: bigint; invocations: bigint }[]
      >(
        // FEA-2999: bucket by LOCAL day derived from the raw session timestamp
        // (localDay(s.started_at)), matching local-insights.ts. started_day is a
        // UTC-day derivation FEA-2430 declared storage-only ("any DISPLAY read
        // must re-bucket from the raw timestamp with strftime(..., 'localtime')")
        // — reading it directly landed pull-in activity on the wrong calendar day
        // for non-UTC users and disagreed with the rest of the dashboard.
        `SELECT
          ${localDay("s.started_at")} AS day,
          COUNT(DISTINCT acsu.session_id) AS session_count,
          SUM(acsu.invocations) AS invocations
        FROM agent_component_session_usage acsu
        INNER JOIN sessions s ON s.id = acsu.session_id
        WHERE acsu.component_kind = 'subagent'
          AND acsu.component_key = ?
          -- FEA-3006 / FEA-2430: bucket by the session's LOCAL day, not the
          -- storage-only UTC started_day column.
          AND ${localDay("s.started_at")} >= ?
        GROUP BY day
        ORDER BY day ASC`,
        subagentKey,
        cutoffDay
      );

      return {
        subagentKey,
        windowDays,
        points: rows.map((r) => ({
          day: r.day,
          sessionCount: Number(r.session_count),
          invocations: Number(r.invocations),
        })),
      };
    })
  );

  ipcMain.handle(
    "desktop:db:is-skill-loaded",
    withPrisma(async (prisma, skillKey: unknown) => {
      if (typeof skillKey !== "string") {
        return {
          skillKey: "",
          existsInInventory: false,
          hasUsage: false,
          totalInvocations: 0,
          lastUsedAt: null,
        };
      }

      const [inventoryRow, usageRow] = await Promise.all([
        prisma.client.agentComponent.findFirst({
          where: { componentKind: "skill", componentKey: skillKey },
          select: { id: true },
        }),
        prisma.client.$queryRawUnsafe<
          {
            total_invocations: bigint;
            last_used_at: string | null;
          }[]
        >(
          `SELECT
            COALESCE(SUM(invocations), 0) AS total_invocations,
            MAX(last_invoked_at) AS last_used_at
          FROM agent_component_session_usage
          WHERE component_kind = 'skill'
            AND component_key = ?`,
          skillKey
        ),
      ]);

      const usage = usageRow[0];
      const totalInvocations = Number(usage?.total_invocations ?? 0);

      return {
        skillKey,
        existsInInventory: inventoryRow !== null,
        hasUsage: totalInvocations > 0,
        totalInvocations,
        lastUsedAt: usage?.last_used_at ?? null,
      };
    })
  );

  // --- Agent components local read (FEA-2923 / T-16.3) ---
  // Backs the desktop-local AgentComponentsDataSource: the renderer reads the
  // org inventory (agent_components + agent_component_session_usage, incl. the
  // plugin child-usage rollup) straight from local SQLite over these two
  // channels — no HTTP, no network. Mirrors the sessions/branches read wiring.
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
    // `withDb` (not `withPrisma`) so the reader also receives the local sessions
    // sync source, letting it compute the KLOC/$ column from the invoking
    // sessions' local-git LOC + cost (FEA-3090) instead of returning null.
    withDb((agentDatabase, filters: unknown) =>
      listAgentComponentsLocal(
        agentDatabase.prisma,
        coerceAgentComponentFilters(filters),
        options.getComputeTargetId?.() ?? null,
        agentDatabase.syncSource
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
    // `withDb` (not `withPrisma`) so the reader also receives the local sessions
    // sync source, letting it hydrate `sessionsTab` from the invoking sessions
    // (FEA-2923 MEDIUM soul review) instead of returning [].
    withDb((agentDatabase, slug: unknown) => {
      if (typeof slug !== "string" || slug.length === 0) {
        return null;
      }
      return getAgentComponentDetailLocal(
        agentDatabase.prisma,
        slug,
        options.getComputeTargetId?.() ?? null,
        agentDatabase.syncSource
      );
    })
  );
}

function unregisterDesignSystemDbIpcHandlers(): void {
  for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST) {
    ipcMain.removeHandler(channel);
  }
}

function coerceSharedQuery(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function coerceSharedBranchDetailId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function coerceSharedBranchForceRefresh(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as { forceRefresh?: unknown }).forceRefresh === true
    ? true
    : undefined;
}

function createBranchCloudHydration(
  options: AgentDashboardDesignSystemRuntimeOptions,
  invokeStoreOp: InvokeStoreOp
): BranchCloudHydrationSource | undefined {
  if (!(options.getApiKey && options.getApiOrigin)) {
    return undefined;
  }
  return new DesktopCloudGitHubHydration({
    getApiKey: options.getApiKey,
    getApiOrigin: options.getApiOrigin,
    getIdentityScope: () => {
      const identity = options.getUserIdentity?.() ?? null;
      return {
        userId: identity?.userId ?? null,
        organizationId: identity?.organizationId ?? null,
        profileId: options.getProfileId?.() ?? null,
        computeTargetId: options.getComputeTargetId?.() ?? null,
      };
    },
    store: {
      readOverlays: async (identityKey, repoNames) =>
        parseCloudGithubBranchOverlayMap(
          await invokeStoreOp("cloudGithubOverlays.read", [
            identityKey,
            repoNames,
          ])
        ),
      writeOverlays: (identityKey, repoNames, overlays, lastSyncedAt) =>
        invokeStoreOp("cloudGithubOverlays.write", [
          identityKey,
          repoNames,
          overlays,
          lastSyncedAt,
        ]).then(() => undefined),
    },
  });
}

async function seedAgentDashboardCatalog(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<void> {
  try {
    // FEA-2038: upsertCatalogSeed uses prisma.write — runs in the DB host. The
    // seed doc is plain JSON, so it forwards as a structured-clone-safe arg.
    await invokeStoreOp("catalog.seed", [catalogSeed]);
    log("agent-dashboard", "Catalog seed applied");
  } catch (e) {
    log(
      "agent-dashboard",
      `Catalog seed failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

async function scanAgentDashboardPacks(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<void> {
  try {
    // FEA-2038: runPackScanner uses prisma.write — runs in the DB host. The
    // cooperative-delay callback can't cross IPC; the scanner runs off the main
    // thread there, so no pause is needed.
    await invokeStoreOp("packScanner.run");
    log("agent-dashboard", "Pack scanner completed");
  } catch (e) {
    log(
      "agent-dashboard",
      `Pack scanner failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

async function backfillClaudePlans(
  invokeStoreOp: InvokeStoreOp,
  log: AgentDashboardLog
): Promise<void> {
  try {
    const plansDir = path.join(
      process.env.CLAUDE_HOME || path.join(app.getPath("home"), ".claude"),
      "plans"
    );
    // FEA-2038: upsertPlan uses prisma.write — the extract + upsert loop runs
    // wholly in the DB host (plansDir is a serializable string arg).
    const count = (await invokeStoreOp("plans.backfill", [plansDir])) as number;
    if (count > 0) {
      log("agent-dashboard", `Backfilled ${count} plans from ~/.claude/plans/`);
    }
  } catch (e) {
    log(
      "agent-dashboard",
      `Plan backfill failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Narrow the full SQLite handle to the `BranchSyncSource` the branch serving
 * needs: `prisma` for the list/usage/analytics reads, plus the shared
 * `syncSource` loader the DETAIL op (D1) uses to hydrate each linked session's
 * real per-session usage + the cross-session merged trace (the same loader the
 * Sessions handlers pass). Downstream branch reads still cannot reach
 * `.sessions`/`.agents`/`.events` directly — only through that loader.
 */
function toBranchSyncSource(
  agentDatabase: DbHostAgentDatabase
): BranchSyncSource {
  return {
    prisma: agentDatabase.prisma,
    syncSource: agentDatabase.syncSource,
  };
}

function coerceSessionPageRequest(
  value: unknown
): SessionPageRequest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return {
    limit: typeof raw.limit === "number" ? raw.limit : undefined,
    offset: typeof raw.offset === "number" ? raw.offset : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    q: typeof raw.q === "string" ? raw.q : undefined,
  };
}

function coerceInsightsSection(value: unknown): InsightsSection {
  return INSIGHTS_SECTION_OPTIONS.includes(value as InsightsSection)
    ? (value as InsightsSection)
    : InsightsSectionValues.Delivery;
}

function coerceInsightsPeriod(value: unknown): InsightsPeriod {
  return INSIGHTS_PERIOD_OPTIONS.includes(value as InsightsPeriod)
    ? (value as InsightsPeriod)
    : InsightsPeriodValues.Quarter;
}

const activeTraceCommentCloudSyncs = new Map<string, Promise<void>>();
const activeTraceCommentParentSessionSyncs = new Map<string, Promise<void>>();
const traceCommentCloudSyncErrorLogTimes = new Map<string, number>();
const TRACE_COMMENT_CLOUD_SYNC_ERROR_LOG_INTERVAL_MS = 30_000;
const TRACE_COMMENT_BACKGROUND_SYNC_INTERVAL_MS = 10_000;

async function listLocalTraceComments(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  identity: UserIdentity
): Promise<TraceComment[]> {
  return (await invokeStoreOp("traceComments.list", [
    target,
    identity,
  ])) as TraceComment[];
}

async function createLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.create", [
    target,
    draft,
    identity,
  ])) as TraceComment;
}

async function createLocalTraceCommentReply(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  draft: TraceCommentReplyDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.reply", [
    target,
    commentId,
    draft,
    identity,
  ])) as TraceComment;
}

async function updateLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  update: TraceCommentUpdate,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.update", [
    target,
    commentId,
    update,
    identity,
  ])) as TraceComment;
}

async function deleteLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  identity: UserIdentity
): Promise<TraceCommentDeleteResult> {
  return (await invokeStoreOp("traceComments.delete", [
    target,
    commentId,
    identity,
  ])) as TraceCommentDeleteResult;
}

async function upsertCloudTraceComments(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  comments: readonly TraceComment[],
  identity: UserIdentity
): Promise<void> {
  await invokeStoreOp("traceComments.upsertCloud", [
    target,
    comments,
    identity,
  ]);
}

async function listPendingLocalTraceCommentOperations(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  identity: UserIdentity
): Promise<PendingTraceCommentSyncOperation[]> {
  return (await invokeStoreOp("traceComments.listPendingOperations", [
    target,
    identity,
  ])) as PendingTraceCommentSyncOperation[];
}

async function listPendingLocalTraceCommentTargets(
  invokeStoreOp: InvokeStoreOp,
  identity: UserIdentity
): Promise<TraceCommentTarget[]> {
  return (await invokeStoreOp("traceComments.listPendingTargets", [
    identity,
  ])) as TraceCommentTarget[];
}

async function markLocalTraceCommentUploaded(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  cloudComment: TraceComment
): Promise<void> {
  await invokeStoreOp("traceComments.markUploaded", [
    localCommentId,
    cloudComment,
  ]);
}

async function markLocalTraceCommentSyncFailed(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  error: unknown,
  operation: PendingTraceCommentSyncOperation["operation"]
): Promise<void> {
  await invokeStoreOp("traceComments.markSyncFailed", [
    localCommentId,
    syncErrorMessage(error),
    operation,
  ]);
}

async function markLocalTraceCommentReplyUploaded(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  localReplyId: string,
  cloudComment: TraceComment
): Promise<void> {
  await invokeStoreOp("traceComments.markReplyUploaded", [
    localCommentId,
    localReplyId,
    cloudComment,
  ]);
}

async function markLocalTraceCommentReplySyncFailed(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  localReplyId: string,
  error: unknown
): Promise<void> {
  await invokeStoreOp("traceComments.markReplySyncFailed", [
    localCommentId,
    localReplyId,
    syncErrorMessage(error),
  ]);
}

async function markLocalTraceCommentDeleted(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string
): Promise<void> {
  await invokeStoreOp("traceComments.markDeleted", [localCommentId]);
}

function runTraceCommentCloudSync(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  if (!hasCloudTraceCommentsAuth(options)) {
    return Promise.resolve();
  }

  const key = traceCommentTargetKey(target);
  const active = activeTraceCommentCloudSyncs.get(key);
  if (active) {
    return active;
  }

  const sync = synchronizeTraceCommentTargetWithCloud(
    invokeStoreOp,
    syncSource,
    target,
    options
  ).finally(() => {
    activeTraceCommentCloudSyncs.delete(key);
  });
  activeTraceCommentCloudSyncs.set(key, sync);
  return sync;
}

async function runPendingTraceCommentCloudSync(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  if (!hasCloudTraceCommentsAuth(options)) {
    return;
  }

  let targets: TraceCommentTarget[];
  const identity = getTraceCommentStoreScope(options);
  try {
    targets = await listPendingLocalTraceCommentTargets(
      invokeStoreOp,
      identity
    );
  } catch (error) {
    options.log?.(
      "trace-comments",
      `Pending sync discovery failed: ${syncErrorMessage(error)}`
    );
    return;
  }

  for (const target of targets) {
    await runTraceCommentCloudSync(invokeStoreOp, syncSource, target, options);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeps the pending operation sync flow linear and auditable under the deadline.
async function synchronizeTraceCommentTargetWithCloud(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  try {
    const identity = getTraceCommentStoreScope(options);
    const cloudComments = await withTraceCommentSessionRetry(
      syncSource,
      target,
      options,
      () => fetchCloudTraceComments<TraceComment[]>(target, "GET", options)
    );
    await upsertCloudTraceComments(
      invokeStoreOp,
      target,
      cloudComments,
      identity
    );
  } catch (error) {
    logTraceCommentCloudSyncError(options, "list", target, error);
  }

  const pending = await listPendingLocalTraceCommentOperations(
    invokeStoreOp,
    target,
    getTraceCommentStoreScope(options)
  );
  for (const pendingOperation of pending) {
    try {
      if (pendingOperation.operation === "create") {
        const uploaded = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(target, "POST", options, {
              anchor: pendingOperation.comment.anchor,
              body: pendingOperation.comment.body,
            })
        );
        await markLocalTraceCommentUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          uploaded
        );
        continue;
      }

      if (pendingOperation.operation === "update") {
        const cloudCommentId = pendingOperation.cloudCommentId;
        if (!cloudCommentId) {
          continue;
        }
        const updated = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(
              target,
              "PATCH",
              options,
              { body: pendingOperation.comment.body },
              cloudCommentId
            )
        );
        await markLocalTraceCommentUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          updated
        );
        continue;
      }

      if (pendingOperation.operation === "reply") {
        const cloudCommentId = pendingOperation.cloudCommentId;
        const reply = pendingOperation.reply;
        const localReplyId = pendingOperation.localReplyId;
        if (!(cloudCommentId && reply && localReplyId)) {
          continue;
        }
        const updated = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(
              target,
              "POST",
              options,
              { body: reply.body },
              cloudCommentId,
              "replies"
            )
        );
        await markLocalTraceCommentReplyUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          localReplyId,
          updated
        );
        continue;
      }

      const cloudCommentId = pendingOperation.cloudCommentId;
      if (!cloudCommentId) {
        continue;
      }
      await withTraceCommentSessionRetry(syncSource, target, options, () =>
        fetchCloudTraceComments<TraceCommentDeleteResult>(
          target,
          "DELETE",
          options,
          undefined,
          cloudCommentId
        )
      );
      await markLocalTraceCommentDeleted(
        invokeStoreOp,
        pendingOperation.comment.id
      );
    } catch (error) {
      if (
        pendingOperation.operation === "reply" &&
        pendingOperation.localReplyId
      ) {
        await markLocalTraceCommentReplySyncFailed(
          invokeStoreOp,
          pendingOperation.comment.id,
          pendingOperation.localReplyId,
          error
        );
        logTraceCommentCloudSyncError(options, "upload", target, error);
        continue;
      }
      await markLocalTraceCommentSyncFailed(
        invokeStoreOp,
        pendingOperation.comment.id,
        error,
        pendingOperation.operation
      );
      logTraceCommentCloudSyncError(options, "upload", target, error);
    }
  }
}

function traceCommentTargetKey(target: TraceCommentTarget): string {
  return `${target.type}:${target.id}`;
}

function logTraceCommentCloudSyncError(
  options: AgentDashboardDesignSystemRuntimeOptions,
  phase: "list" | "sync" | "upload",
  target: TraceCommentTarget,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${phase}:${traceCommentTargetKey(target)}:${message}`;
  const now = Date.now();
  const lastLoggedAt = traceCommentCloudSyncErrorLogTimes.get(key) ?? 0;
  if (now - lastLoggedAt < TRACE_COMMENT_CLOUD_SYNC_ERROR_LOG_INTERVAL_MS) {
    return;
  }
  traceCommentCloudSyncErrorLogTimes.set(key, now);
  options.log?.(
    "trace-comments",
    `Cloud ${phase} failed for ${traceCommentTargetKey(target)}: ${message}`
  );
}

function syncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

async function withTraceCommentSessionRetry<T>(
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableMissingSession(error, target)) {
      throw error;
    }
    await syncCloudSessionForTraceComments(syncSource, target, options);
    return await operation();
  }
}

function isRetryableMissingSession(
  error: unknown,
  target: TraceCommentTarget
): boolean {
  return (
    target.type === "session" &&
    error instanceof TraceCommentCloudRequestError &&
    error.status === 404
  );
}

async function syncCloudSessionForTraceComments(
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  if (target.type !== "session") {
    return;
  }
  if (!syncSource) {
    throw new Error("Desktop session source unavailable.");
  }
  const computeTargetId = options.getComputeTargetId?.();
  if (!computeTargetId) {
    throw new Error("Desktop compute target unavailable.");
  }

  const syncKey = `${computeTargetId}:${target.id}`;
  const active = activeTraceCommentParentSessionSyncs.get(syncKey);
  if (active) {
    return active;
  }
  const sync = syncCloudSessionForTraceCommentsOnce(
    syncSource,
    target,
    options,
    computeTargetId
  ).finally(() => {
    if (activeTraceCommentParentSessionSyncs.get(syncKey) === sync) {
      activeTraceCommentParentSessionSyncs.delete(syncKey);
    }
  });
  activeTraceCommentParentSessionSyncs.set(syncKey, sync);
  return sync;
}

async function syncCloudSessionForTraceCommentsOnce(
  syncSource: AgentSessionSyncSource,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions,
  computeTargetId: string
): Promise<void> {
  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  const sessions = await syncSource.loadSyncedSessions([target.id], cache);
  const session = sessions[0];
  if (!session) {
    throw new Error(
      "Desktop session source did not return the target session."
    );
  }

  await syncTraceCommentParentSessionPayloads(session, (payload) =>
    postCloudAgentSessionSync(target.id, payload, options, computeTargetId)
  );
}

async function postCloudAgentSessionSync(
  sessionId: string,
  payload: AgentSessionSyncTransportPayload,
  options: AgentDashboardDesignSystemRuntimeOptions,
  computeTargetId: string
): Promise<TraceCommentParentSessionSyncResult> {
  return postTraceCommentParentSessionCloudSync(
    sessionId,
    payload,
    options,
    computeTargetId
  );
}

function hasCloudTraceCommentsAuth(
  options: AgentDashboardDesignSystemRuntimeOptions
): boolean {
  return Boolean(options.getApiKey?.() && options.getApiOrigin?.());
}

function getTraceCommentStoreScope(
  options: AgentDashboardDesignSystemRuntimeOptions
): UserIdentity {
  const identity = options.getUserIdentity?.() ?? null;
  return {
    profileId: options.getProfileId?.() ?? null,
    computeTargetId: options.getComputeTargetId?.() ?? null,
    userId: identity?.userId ?? null,
    organizationId: identity?.organizationId ?? null,
  };
}

async function fetchCloudTraceComments<T>(
  target: TraceCommentTarget,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  options: AgentDashboardDesignSystemRuntimeOptions,
  body?: TraceCommentDraft | TraceCommentReplyDraft | TraceCommentUpdate,
  commentId?: string,
  childPath?: "replies"
): Promise<T> {
  const apiKey = options.getApiKey?.();
  const apiOrigin = options.getApiOrigin?.();
  if (!(apiKey && apiOrigin)) {
    throw new Error("Desktop cloud API key unavailable.");
  }

  const url = new URL(
    traceCommentCloudPath(target, commentId, childPath),
    apiOrigin
  );
  const computeTargetId = options.getComputeTargetId?.();
  if (target.type === "session" && computeTargetId) {
    url.searchParams.set("computeTargetId", computeTargetId);
  }
  const response = await fetch(url, {
    ...(body ? {} : { cache: "no-store" }),
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResult<T> | null;
  if (!(response.ok && payload?.success === true)) {
    throw new TraceCommentCloudRequestError(
      payload && "error" in payload
        ? payload.error
        : `Trace comments request failed with status ${response.status}.`,
      response.status
    );
  }
  return payload.data;
}

class TraceCommentCloudRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TraceCommentCloudRequestError";
    this.status = status;
  }
}

function traceCommentCloudPath(
  target: TraceCommentTarget,
  commentId?: string,
  childPath?: "replies"
): string {
  if (!commentId) {
    return traceCommentsPath(target);
  }
  return childPath === "replies"
    ? traceCommentRepliesPath(target, commentId)
    : traceCommentPath(target, commentId);
}

function coerceTraceCommentTarget(value: unknown): TraceCommentTarget | null {
  const result = traceCommentTargetSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceTraceCommentDraft(value: unknown): TraceCommentDraft | null {
  const result = traceCommentDraftSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceTraceCommentReplyDraft(
  value: unknown
): TraceCommentReplyDraft | null {
  const result = traceCommentReplyDraftSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceTraceCommentUpdate(value: unknown): TraceCommentUpdate | null {
  const result = traceCommentUpdateSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceTraceCommentId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= TRACE_COMMENT_ID_MAX_LENGTH
    ? value
    : null;
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

function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
