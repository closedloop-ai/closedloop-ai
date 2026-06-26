import path from "node:path";
import {
  type AgentsInsightsResponse,
  type DeliveryInsightsResponse,
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SCOPE_OPTIONS,
  INSIGHTS_SECTION_OPTIONS,
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
  type InsightsScope,
  InsightsScope as InsightsScopeValues,
  type InsightsSection,
  InsightsSection as InsightsSectionValues,
  type UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
} from "electron";
import { resolveBinaryFromLoginShellSync } from "../server/shell-path.js";
import type { SessionPageRequest } from "../shared/agent-db-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
} from "../shared/shared-agent-sessions-contract.js";
import {
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
} from "../shared/shared-branches-contract.js";
import { DESIGN_SYSTEM_DB_IPC_CHANNELS } from "./agent-dashboard-ipc-contract.js";
import { isAgentMonitorHooksEnabled } from "./agent-monitor-hooks.js";
import { AgentHookListener } from "./agent-monitor-listener.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-service.js";
import { detectBillingMode } from "./billing-mode-detector.js";
import { runArtifactLinkBackfillRuntimeBoundary } from "./collectors/artifact-link-backfill-runtime-boundary.js";
import { artifactLinkId } from "./collectors/artifact-ref-extractor.js";
import {
  getActiveCollectionMode,
  type HooksInstalledState,
} from "./collectors/collection-mode.js";
import { CollectorManager } from "./collectors/collector-manager.js";
import { runDataRevisionRebuild } from "./collectors/data-revision-rebuild.js";
import { createMutualExclusivityMonitor } from "./collectors/mutual-exclusivity-monitor.js";
import { createUtilityProcessHistoricalParseRunner } from "./collectors/utility-process-historical-parse-runner.js";
import { createDbHostAgentDatabase } from "./database/db-host/db-host-agent-database.js";
import { DbHostClient } from "./database/db-host/db-host-client.js";
import { coerceDbId } from "./database/ipc-validation.js";
import type { DesktopPrisma } from "./database/prisma-client.js";
import type { SqliteAgentDatabase } from "./database/sqlite.js";
import { createApiErrorWatchdog } from "./database/watchdog.js";
import { OtlpHttpReceiver } from "./otlp-http-receiver.js";
// FEA-2038: catalog GitHub-stats fetch + contents refresh both end in
// `prisma.write`, which can't cross the DB-host method proxy — they run in the
// child via `invokeStoreOp("catalog.fetch.run" | "catalog.contents.refresh")`,
// so `runCatalogFetch` / `refreshCatalogContents` are NOT imported here.
import { scheduleCatalogFetch } from "./packs/catalog-fetcher.js";
import catalogSeed from "./packs/catalog-seed.json" with { type: "json" };
import * as catalogStore from "./packs/catalog-store.js";
import { streamRun } from "./packs/install-orchestrator.js";
import * as packStore from "./packs/pack-store.js";
import * as planStore from "./plans/plan-store.js";
import * as prStore from "./pull-requests/pr-store.js";
import type { MeteredUsageRow } from "./reconciliation-worker.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessionDetail,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "./shared-agent-sessions-api.js";
import {
  type BranchSyncSource,
  getSharedBranchAnalytics,
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchUsage,
} from "./shared-branches-api.js";

export type AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => BrowserWindow | null;
  whenInitialWindowShown?: () => Promise<void>;
  whenInitialDashboardDataServed?: () => Promise<void>;
  whenInitialBackgroundWorkAllowed?: () => Promise<void>;
  waitForRendererBackgroundSlot?: () => Promise<void>;
  onFirstDbIpcServed?: () => void;
  onInitialCollectorImportComplete?: () => void;
  getApiKey?: () => string | null;
  getApiOrigin?: () => string;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  onTerminalFailure: (reason: string) => void;
  userDataPath?: string;
  log?: (scope: string, message: string) => void;
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

export type AgentDashboardDesignSystemRuntime = {
  connection: null;
  syncSource: AgentSessionSyncSource | null;
  getUrl: () => string | null;
  isReady: () => boolean;
  startHookListener: () => void;
  startCollectors: () => void;
  getIngestProgress: () => {
    byHarness: { harness: string; total: number; processed: number }[];
    total: number;
    processed: number;
  };
  stop: () => Promise<void>;
  close: () => Promise<void> | void;
  restartCollectors: () => Promise<void>;
  registerIpcHandlers: () => void;
  loadMeteredUsageRows: (
    cutoffIso: string
  ) => MeteredUsageRow[] | Promise<MeteredUsageRow[]>;
};

/**
 * Resolve the opt-in design-system dashboard database. This helper lives inside
 * the dynamic boundary so default/legacy boot never imports code that can create
 * the SQLite data directory.
 */
export function resolveAgentDashboardDatabasePath(
  userDataPath = app.getPath("userData")
): string {
  // SQLite (libSQL) is a single file, not the PGlite `.pgdata` directory. The
  // new filename also means existing PGlite installs start fresh on a clean
  // SQLite DB and re-derive everything from the on-disk raw logs.
  return path.join(userDataPath, "agent-dashboard.sqlite");
}

/**
 * FEA-1959: one-time remediation — PR artifacts whose branch_name is a default
 * branch (main/master/develop) were mis-stamped by the old import path which
 * used the session's stale gitBranch. Reset them to provisional so the enrichment
 * sweep re-fetches from GitHub and writes the correct headRefName. Returns the
 * number of rows reset so the caller can trigger an enrichment sweep.
 *
 * The `enriched_at IS NULL` guard is what makes this idempotent: enrichment
 * stamps `enriched_at` whenever it commits a state (applyEnrichmentResult), and
 * it only writes branch_name from GitHub's headRefName. So a row with
 * enriched_at set already has a GitHub-confirmed branch_name — if that name is
 * legitimately a default branch, resetting it would just have enrichment write
 * the same value back and re-match next boot, an infinite reset↔enrich cycle.
 * Only the stale-import rows (never enriched) need remediation.
 */
async function remediateMisattributedPrBranches(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    const remediated = await prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE artifacts SET enrichment_state = 'provisional'
         WHERE kind = 'pull_request'
           AND branch_name IN ('main', 'master', 'develop')
           AND enrichment_state = 'final'
           AND enriched_at IS NULL`
      )
    );
    if (remediated > 0) {
      log(
        `PR branch remediation: reset ${remediated} mis-attributed PR(s) to provisional`
      );
    }
    return remediated;
  } catch (e) {
    log(
      `PR branch remediation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
}

/**
 * FEA-1899: bulk link propagation — sessions on branches that have PR artifacts
 * get auto-linked to the PR. Runs once after backfill on every boot. Idempotent
 * (ON CONFLICT DO NOTHING). No transcript re-scan, no gh calls — pure DB join.
 */
async function propagateAllBranchPrLinks(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<number> {
  try {
    // Join through pull_requests (lifecycle detail store) for the correct
    // branch_name↔PR mapping. artifacts.branch_name is unreliable (set from
    // the importing session's branch, not the PR's head ref).
    // SQLite has no md5()/left()/now(): resolve the missing links first, then
    // insert each with a JS-computed deterministic id (matching
    // propagateBranchPrLinks / linkBranchSessionsToPr). The ON CONFLICT on the
    // natural triple still de-dupes regardless of the id encoding.
    const missing = await prisma.client.$queryRawUnsafe<
      {
        session_id: string;
        pr_artifact_id: string;
        identity_key: string;
      }[]
    >(
      `SELECT DISTINCT
           sal.session_id,
           pr_art.id AS pr_artifact_id,
           pr_art.identity_key
         FROM session_artifact_links sal
         JOIN artifacts branch ON sal.artifact_id = branch.id
           AND branch.kind = 'branch'
           AND branch.repo_full_name IS NOT NULL
         JOIN pull_requests pr ON pr.repo_full_name = branch.repo_full_name
           AND pr.branch_name = branch.branch_name
           AND pr.pr_number IS NOT NULL
           AND pr.branch_name NOT IN ('main', 'master', 'develop', 'HEAD')
         JOIN artifacts pr_art ON pr_art.kind = 'pull_request'
           AND pr_art.repo_full_name = pr.repo_full_name
           AND pr_art.pr_number = pr.pr_number
           -- NULL pr_state (unenriched) treated as open: temporary over-link that
           -- self-heals once the enrichment sweep sets pr_state. Accepted tradeoff.
           AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
         WHERE NOT EXISTS (
           SELECT 1 FROM session_artifact_links ex
           WHERE ex.session_id = sal.session_id AND ex.artifact_id = pr_art.id
             AND ex.relation = 'workspace'
         )`
    );
    if (missing.length === 0) {
      return 0;
    }
    const now = new Date().toISOString();
    // Each link is its own isolated write (matching the prior per-row autonomous
    // inserts): one bad row can't roll back the batch, and the shared write queue
    // isn't held for the whole loop. ON CONFLICT DO NOTHING keeps re-runs free.
    let linked = 0;
    for (const m of missing) {
      const linkId = artifactLinkId(
        m.session_id,
        "pull_request",
        m.identity_key,
        "workspace"
      );
      linked += await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO session_artifact_links
             (id, session_id, artifact_id, relation, method, evidence, is_primary,
              status, extractor_version, observed_at, created_at)
           VALUES ($1, $2, $3, 'workspace', 'branch_pr_association', '{}', 0,
                   'candidate', 1, $4, $4)
           ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
          linkId,
          m.session_id,
          m.pr_artifact_id,
          now
        )
      );
    }
    if (linked > 0) {
      log(`branch→PR link propagation: linked ${linked} session(s) to PRs`);
    }
    return linked;
  } catch (e) {
    log(
      `branch→PR link propagation failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
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
      options
        .getWindow()
        ?.webContents.send("desktop:db:changed", { sessionId });
    },
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

  const registerIpcHandlers = () => {
    if (dbIpcRegistered) {
      return;
    }
    dbIpcRegistered = true;
    registerDesignSystemDbIpcHandlers(
      () => agentDatabasePromise,
      options,
      invokeStoreOp
    );
  };

  await agentDatabasePromise;
  registerIpcHandlers();
  log("agent-dashboard", "SQLite runtime active for Agent Dashboard database");
  // The renderer may have first-painted against disabled IPC responders while
  // SQLite opened. Nudge DB-backed caches once live handlers can serve data.
  options.getWindow()?.webContents.send("desktop:db:ready", {});
  options.getWindow()?.webContents.send("desktop:db:changed", {});

  let closed = false;
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
  const runAfterInitialBackgroundWorkAllowed = (
    taskName: string,
    task: () => void | Promise<void>
  ): void => {
    const waitForBackgroundWork =
      options.whenInitialBackgroundWorkAllowed ??
      options.whenInitialDashboardDataServed ??
      options.whenInitialWindowShown ??
      (() => Promise.resolve());
    void waitForBackgroundWork()
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
    options.getWindow()?.webContents.send("desktop:db:changed", {});
  };
  runAfterInitialBackgroundWorkAllowed(
    "Startup catalog maintenance",
    runStartupCatalogMaintenance
  );

  const resolveGitPath = () => resolveBinaryFromLoginShellSync("git").path;
  const resolveGhPath = () => resolveBinaryFromLoginShellSync("gh").path;

  // Login-shell binary lookup is synchronous; wait for the first visible window
  // so git/gh path resolution cannot hold first paint.
  const runStartupEnrichment = async (): Promise<void> => {
    if (closed) {
      return;
    }

    const gitPath = resolveGitPath();
    // FEA-2038: the sweep runs in the DB host, so cooperative-delay/cancel
    // callbacks (which can't cross IPC) are dropped — the child's defaults
    // (no pause, always-continue) are correct off the main thread.
    await agentDatabase
      .triggerEnrichmentSweep(gitPath, resolveGhPath(), {
        debounce: false,
      })
      .catch((e: unknown) =>
        log(
          "agent-enrichment",
          `Startup sweep failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
    await waitForBackgroundSlot();
    if (closed) {
      return;
    }
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
    "Startup enrichment",
    runStartupEnrichment
  );

  let catalogFetchTimer: ReturnType<typeof setInterval> | null = null;
  runAfterInitialBackgroundWorkAllowed("Initial catalog fetch", async () => {
    await waitForBackgroundSlot();
    await invokeStoreOp("catalog.fetch.run");
  });
  catalogFetchTimer = scheduleCatalogFetch(() =>
    invokeStoreOp("catalog.fetch.run")
  );

  let startPromise: Promise<void> | null = null;

  const collectorsLog = (message: string): void =>
    log("agent-collectors", message);
  const historicalParseRunner = createUtilityProcessHistoricalParseRunner({
    log: collectorsLog,
  });
  let maintenanceGeneration = 0;
  let maintenanceTask: Promise<void> | null = null;

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
    const task = runPostBootMaintenance(generation)
      .then(() => {
        if (isMaintenanceActive(generation)) {
          options.onInitialCollectorImportComplete?.();
        }
      })
      .finally(() => {
        if (maintenanceTask === task) {
          maintenanceTask = null;
        }
      });
    maintenanceTask = task;
  };

  const runPostBootMaintenance = async (generation: number): Promise<void> => {
    const shouldContinue = () => isMaintenanceActive(generation);
    const rebuildCancelled = await runDataRevisionMaintenance(shouldContinue);
    if (rebuildCancelled || !shouldContinue()) {
      return;
    }
    await runArtifactLinkBackfillMaintenance(shouldContinue);
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
          historicalParseRunner.parseSource(collector.key, source),
      });
      if (!shouldContinue()) {
        return true;
      }
      if (summary.rebuilt > 0 || summary.deleted > 0) {
        // The rebuild mutates rows outside the hook/import emit paths —
        // drop the cached historical list and nudge the renderer or the
        // dashboard keeps serving pre-rebuild numbers.
        agentDatabase.sessions.invalidateHistoricalDetails();
        options.getWindow()?.webContents.send("desktop:db:changed", {});
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
    const remediated = await remediateMisattributedPrBranches(
      agentDatabase.prisma,
      collectorsLog
    );
    if (!shouldContinue()) {
      return;
    }
    if (remediated > 0) {
      await agentDatabase
        .triggerEnrichmentSweep(resolveGitPath(), resolveGhPath(), {
          debounce: false,
        })
        .catch((e: unknown) =>
          collectorsLog(
            `Post-remediation sweep failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      if (!shouldContinue()) {
        return;
      }
    }
    const linked = await propagateAllBranchPrLinks(
      agentDatabase.prisma,
      collectorsLog
    );
    if (!shouldContinue()) {
      return;
    }
    if (linked > 0) {
      options.getWindow()?.webContents.send("desktop:db:changed", {});
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
        triggerEnrichmentSweep: () =>
          agentDatabase.triggerEnrichmentSweep(
            resolveGitPath(),
            resolveGhPath(),
            {
              debounce: false,
            }
          ),
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

  const cancelCollectorMaintenance = async (): Promise<void> => {
    maintenanceGeneration++;
    collectorManager.stop();
    historicalParseRunner.stop();
    const task = maintenanceTask;
    if (task) {
      await task.catch(() => {});
    }
  };

  const collectorManager = new CollectorManager({
    importer: agentDatabase.importer,
    detectBillingMode,
    stateDir: path.join(
      options.userDataPath ?? app.getPath("userData"),
      "agent-dashboard-ingest"
    ),
    emit: (sessionId?: string) => {
      options
        .getWindow()
        ?.webContents.send("desktop:db:changed", { sessionId });
    },
    getCollectionMode: (harness) =>
      getActiveCollectionMode(harness, currentHooksState()),
    onWatcherEmission: (harness, externalSessionId) => {
      mutualExclusivityMonitor.record(harness, externalSessionId, "watcher");
    },
    // Historical parsing runs in a utility process, and main-process DB writes
    // yield between sessions so there is no delayed CPU cliff after startup.
    historicalImportDelayMs: desktopHistoricalImportDelayMs,
    historicalImportStaggerMs: desktopHistoricalImportStaggerMs,
    catchupPollMs: desktopCatchupPollMs,
    historicalParseRunner,
    log: collectorsLog,
    cooperativeDelay: backgroundDelay,
    onBootImportComplete: schedulePostBootMaintenance,
    // Self-heal catchup-cache/DB divergence: after a DB reset/migration the
    // JSON ingest cache still marks codex/claude sources "seen", but their rows
    // are gone. Surfacing the live id set lets the manager re-import orphans.
    listExistingSessionIds: () => agentDatabase.listExistingSessionIds(),
  });

  // Gap 3: API error watchdog — polls active sessions for stale Stop events
  // with error summaries that the live hook path may have missed. Its status
  // writes go through `prisma.write`, serializing at the shared write queue.
  const watchdog = createApiErrorWatchdog(agentDatabase.prisma, {
    log: (message: string) => collectorsLog(`watchdog: ${message}`),
  });

  const ensureOtlpReceiverStarted = (): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    if (!startPromise) {
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
    return startPromise;
  };

  const runtime: AgentDashboardDesignSystemRuntime = {
    connection: agentDatabase.connection,
    syncSource: agentDatabase.syncSource,
    getUrl: () => hookListener.getUrl(),
    isReady: () => hookListener.isReady(),
    startHookListener: () => {
      void ensureOtlpReceiverStarted();
    },
    getIngestProgress: () => collectorManager.getIngestProgress(),
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
      });
    },
    stop: async () => {
      if (closed) {
        return;
      }
      startPromise = null;
      watchdog.stop();
      await cancelCollectorMaintenance();
      await Promise.all([hookListener.stop(), otlpReceiver.stop()]);
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      startPromise = null;
      watchdog.stop();
      if (catalogFetchTimer) {
        clearInterval(catalogFetchTimer);
        catalogFetchTimer = null;
      }
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
  };

  return runtime;
}

function registerDesignSystemDbIpcHandlers(
  getAgentDatabase: () => Promise<SqliteAgentDatabase>,
  options: AgentDashboardDesignSystemRuntimeOptions,
  invokeStoreOp: InvokeStoreOp
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
        agentDatabase: SqliteAgentDatabase,
        ...args: TArgs
      ) => TResult | Promise<TResult>
    ) =>
    async (_event: IpcMainInvokeEvent, ...args: TArgs): Promise<TResult> => {
      const result = await handler(await getAgentDatabase(), ...args);
      notifyFirstDbIpcServed();
      return result;
    };

  // FEA-1791: hands a store handler the typed Prisma client (reads via
  // prisma.client, writes via prisma.write) for stores converted off raw SQL.
  const withPrisma = <TArgs extends unknown[], TResult>(
    handler: (
      prisma: SqliteAgentDatabase["prisma"],
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
        const parsedScope = coerceInsightsScope(scope);
        if (parsedScope === InsightsScopeValues.Org) {
          const cloud = await fetchCloudInsights(
            parsedSection,
            parsedPeriod,
            options
          );
          if (cloud) {
            return cloud;
          }
        }
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
        return streamRun(agentDatabase.prisma, {
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
        return streamRun(agentDatabase.prisma, {
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
        void shell.openPath(filePath);
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
      if (typeof prUrl === "string") {
        void shell.openExternal(prUrl);
      }
    })
  );

  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
    withDb((agentDatabase, request: unknown) =>
      getSharedAgentSessions(
        agentDatabase.syncSource,
        coerceSharedQuery(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
    withDb((agentDatabase, id: unknown) =>
      getSharedAgentSessionDetail(agentDatabase.syncSource, id)
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
    withDb((agentDatabase, request: unknown) =>
      getSharedAgentSessionUsage(
        agentDatabase.syncSource,
        coerceSharedQuery(request)
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
        coerceSharedQuery(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.detail,
    withDb((agentDatabase, id: unknown) =>
      getSharedBranchDetail(toBranchSyncSource(agentDatabase), id)
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
        coerceSharedQuery(request)
      )
    )
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
}

function coerceSharedQuery(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
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
 * needs: `prisma` for the list/usage/analytics reads (FEA-1791 — they now run on
 * the single Prisma client, no longer the raw `storeDb` handle), plus the shared
 * `syncSource` loader the DETAIL op (D1) uses to hydrate each linked session's
 * real per-session usage + the cross-session merged trace (the same loader the
 * Sessions handlers pass). Downstream branch reads still cannot reach
 * `.sessions`/`.agents`/`.events` directly — only through that loader.
 */
function toBranchSyncSource(
  agentDatabase: SqliteAgentDatabase
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

function coerceInsightsScope(value: unknown): InsightsScope {
  return INSIGHTS_SCOPE_OPTIONS.includes(value as InsightsScope)
    ? (value as InsightsScope)
    : InsightsScopeValues.Me;
}

async function fetchCloudInsights(
  section: InsightsSection,
  period: InsightsPeriod,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse
  | null
> {
  const apiKey = options.getApiKey?.();
  const apiOrigin = options.getApiOrigin?.();
  if (!(apiKey && apiOrigin)) {
    return null;
  }

  const url = new URL(`/insights/${section}`, apiOrigin);
  url.searchParams.set("period", period);
  url.searchParams.set("scope", InsightsScopeValues.Org);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as
    | DeliveryInsightsResponse
    | UtilizationInsightsResponse
    | AgentsInsightsResponse;
}

const desktopHistoricalImportDelayMs = 0;
const desktopHistoricalImportStaggerMs = 1000;
const desktopCatchupPollMs = 30 * 60_000;

function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
