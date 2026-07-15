import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import type {
  AgentHierarchyNode,
  AgentRow,
  AnalyticsData,
  DashboardCoreFeatures,
  DashboardPackSummary,
  DashboardPlanSummary,
  DashboardPullRequestSummary,
  DashboardSkillSummary,
  DashboardSubAgentSummary,
  DashboardSummary,
  DashboardToolSummary,
  EventCountByType,
  EventRow,
  EventWithSession,
  KanbanPages,
  SessionPage,
  SessionPageRequest,
  SessionRow,
  SessionWithAgents,
  TokenAnalytics,
  WorkflowQueryData,
} from "../../shared/agent-db-contract.js";
import type { DiagnosticsData } from "../../shared/diagnostics-contract.js";
import type {
  HookData,
  HookHarness,
  Importer,
  TokenUsageCounts,
  TokenUsageRow,
} from "../agent-dashboard-db-types.js";
import type { AgentSessionSyncSource } from "../agent-session-sync-service.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import { defaultBranchSqlList } from "../enrichment/default-branch-names.js";
import {
  type EnrichmentSweepOptions,
  triggerEnrichmentSweep as triggerEnrichmentSweepFn,
} from "../enrichment/enrichment-runner.js";
import { runHistoricalBackfill as runHistoricalBackfillFn } from "../enrichment/historical-backfill.js";
import { repairPollutedRepoFullNames } from "../enrichment/repo-fullname-repair.js";
import { captureRepoIdentity as captureRepoIdentityFn } from "../enrichment/repo-identity.js";
import {
  CodexOtelTokenUsageSource,
  parseCodexOtelBatch,
} from "../otel/codex-otel-contract.js";
import { persistCodexOtelBatch } from "../otel/codex-otel-writer.js";
import {
  type PackInstallRunEndInput,
  type PackInstallRunStartInput,
  recordInstallRunEnd as recordPackInstallRunEndFn,
  recordInstallRunStart as recordPackInstallRunStartFn,
} from "../packs/catalog-store.js";
import type { MeteredUsageRow } from "../reconciliation-worker.js";
import {
  BASELINE_MIGRATIONS,
  COLLAPSED_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "./baseline-schema.js";
import { createSqliteDashboardQueries } from "./dashboard-queries.js";
import { TERMINAL_STATUS_SET } from "./db-constants.js";
import { collectionViolationEventId } from "./deterministic-event-id.js";
import { getDiagnosticsData as getDiagnosticsDataFn } from "./diagnostics-store.js";
import type { Prisma } from "./generated/client.js";
import { openMigrationDatabase } from "./migration-executor.js";
import { runDesktopMigrations } from "./migration-runner.js";
import { MIGRATIONS } from "./migrations-manifest.js";
import {
  propagateAllBranchPrLinks as propagateAllBranchPrLinksFn,
  remediateMisattributedPrBranches as remediateMisattributedPrBranchesFn,
} from "./pr-link-maintenance.js";
import {
  createDesktopPrisma,
  type DbHostPrisma,
  type DesktopPrisma,
} from "./prisma-client.js";
import {
  createSqliteAgentStore,
  createSqliteEventStore,
  createSqliteSessionStore,
  createSqliteTokenUsageStore,
} from "./read-stores.js";
import {
  sweepExpiredSessions,
  sweepOrphanedSessions,
} from "./session-maintenance.js";
import type { TokenParityResult } from "./store-integrity-probe.js";
import {
  STORE_INTEGRITY_INDEX_SQL,
  storeIntegrityQuickCheckSql,
} from "./store-integrity-sql.js";
import {
  createSqliteSessionSyncSource,
  loadSqliteMeteredUsageRows,
} from "./sync-source.js";
import type { TranscriptExtract } from "./transcript.js";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "./transcript-sync-store.js";
import {
  backfillSessionAnalytics,
  backfillSessionTurnBuckets,
  chunkSessionIdsByMetadataBudget,
  createSqliteImporter,
  createSqliteLifecycle,
  deleteClaudeCodeOtelSessionRows,
  healCacheCostSplit,
  importSessionWithTx,
  recomputeHeadlessSessionAnalytics,
  repriceUnpricedTokenUsage,
  SESSION_ANALYTICS_BACKFILL_CHUNK,
  SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
  upsertSessionAnalyticsRollupBatch,
} from "./write-core.js";
import { createWriteQueue } from "./write-queue.js";

/**
 * FEA-1839: prefix for the synthetic `session_id` of a
 * `mutual_exclusivity_violation` event. A real harness session id is a bare
 * id/uuid, so this namespaced value can never collide with one — keeping the
 * diagnostic row off any real session's event stream and clear of
 * `rebuildSessionFromParse`'s per-session DELETE.
 */
export const COLLECTION_VIOLATION_SESSION_PREFIX = "mutual-exclusivity:";

export type SqliteAgentDatabase = {
  backend: "sqlite";
  connection: null;
  importer: Importer;
  syncSource: AgentSessionSyncSource;
  /** FEA-2715: durable per-transcript-file fingerprint + upload-cursor store. */
  transcriptSync: TranscriptSyncStore;
  sessions: {
    getById(id: string): Promise<SessionRow | undefined>;
    /** Total rows in `sessions` (raw COUNT(*) on the reader pool; FEA-2211). */
    count(): Promise<number>;
    getAll(): Promise<SessionRow[]>;
    getActive(): Promise<SessionRow[]>;
    getDetailsById(id: string): Promise<SessionWithAgents | undefined>;
    getActiveWithDetails(): Promise<SessionWithAgents[]>;
    getHistoricalWithDetails(): Promise<SessionWithAgents[]>;
    getAllWithDetails(): Promise<SessionWithAgents[]>;
    getPage(request?: SessionPageRequest): Promise<SessionPage>;
    getKanbanPages(statuses: string[], limit: number): Promise<KanbanPages>;
    invalidateHistoricalDetails(): void;
    handleSessionMutation(sessionId: string): Promise<void>;
  };
  agents: {
    getBySession(sessionId: string): Promise<AgentRow[]>;
    getBySessionWithChildren(sessionId: string): Promise<AgentHierarchyNode[]>;
  };
  events: {
    getBySession(sessionId: string): Promise<EventRow[]>;
    getBySessionAndAgent(
      sessionId: string,
      agentId: string
    ): Promise<EventRow[]>;
    getAll(): Promise<EventWithSession[]>;
    getWithSession(sessionId: string): Promise<EventWithSession[]>;
    getCountByType(): Promise<EventCountByType[]>;
  };
  tokenUsage: {
    replace(
      sessionId: string,
      model: string,
      counts: TokenUsageCounts,
      now: string,
      tx?: Prisma.TransactionClient
    ): Promise<void>;
    getBySession(sessionId: string): Promise<TokenUsageRow[]>;
  };
  codexOtel: {
    persistBatch(batch: unknown): Promise<void>;
  };
  dashboard: {
    getTokenAnalytics(now?: Date): Promise<TokenAnalytics>;
    getInsights(
      section: InsightsSection,
      period: InsightsPeriod,
      // Optional fixed clock — defaults to real time in production; tests pin it
      // so the date-windowed insights (trend series) are deterministic.
      now?: Date
    ): Promise<
      | DeliveryInsightsResponse
      | UtilizationInsightsResponse
      | AgentsInsightsResponse
    >;
    getAnalytics(now?: Date): Promise<AnalyticsData>;
    getWorkflowData(): Promise<WorkflowQueryData>;
    getCoreFeatures(): Promise<DashboardCoreFeatures>;
    getPacks(): Promise<DashboardPackSummary[]>;
    getSkills(): Promise<DashboardSkillSummary[]>;
    getTools(): Promise<DashboardToolSummary[]>;
    getSubAgents(): Promise<DashboardSubAgentSummary[]>;
    getPlans(): Promise<DashboardPlanSummary[]>;
    getPullRequests(): Promise<DashboardPullRequestSummary[]>;
  };
  getSummary(): Promise<DashboardSummary>;
  /**
   * The single typed Prisma layer — the store's ONLY access path. Writes go
   * through `prisma.write(...)` (serialized writer connection); heavy/independent
   * reads that must run concurrently with the backfill go through
   * `prisma.read(...)` (the `query_only` reader pool); light read-your-writes
   * reads use `prisma.client`. The only raw connection is the boot-time migration
   * handle.
   */
  prisma: DesktopPrisma;
  writeQueue: ReturnType<typeof createWriteQueue>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  processEvent(
    hookType: string,
    data: HookData,
    harness: HookHarness
  ): Promise<boolean>;
  /**
   * FEA-1839: record a mutual-exclusivity violation — the same harness session
   * was emitted by both the hook handler and the live watcher in one process
   * lifetime. Writes exactly one `mutual_exclusivity_violation` row (deterministic
   * id + ON CONFLICT DO NOTHING) into the local `events` store. Never throws.
   */
  recordCollectionModeViolation(
    harness: string,
    externalSessionId: string
  ): Promise<void>;
  loadMeteredUsageRows(cutoffIso: string): Promise<MeteredUsageRow[]>;
  listStaleRevisionSessions(
    currentRevision: number
  ): Promise<Array<{ id: string; harness: string | null; status: string }>>;
  /**
   * All session ids currently in the DB. Used by the collector manager to
   * self-heal catchup-cache/DB divergence: a source the persistent ingest
   * cache marks "seen" whose row was dropped by a DB reset/migration must be
   * re-imported, not skipped (codex/claude orphaning after PGlite→SQLite).
   */
  listExistingSessionIds(): Promise<Set<string>>;
  rebuildSessionFromParse(
    session: NormalizedSession,
    harness: Harness
  ): Promise<{ rebuilt: boolean; activeRace: boolean }>;
  deleteSessionRow(sessionId: string): Promise<void>;
  /**
   * FEA-2641: recompute `session_analytics` rollups for sessions the
   * data-revision rebuild cannot re-derive (source transcript gone). The
   * corrected rollup SQL reads the STORED `sessions.metadata`, so these rows
   * still heal their human/agent classification without a source file. Their
   * stale `data_revision` stamp is preserved (rows were not re-derived from
   * source), so the recompute re-runs on each boot — bounded by the small
   * missing-source population.
   */
  recomputeAnalyticsRollups(sessionIds: string[]): Promise<void>;
  captureRepoIdentity(
    gitPath: string,
    cwd: string
  ): Promise<{ repoFullName: string | null }>;
  triggerEnrichmentSweep(
    gitPath: string,
    ghPath: string,
    opts?: EnrichmentSweepOptions
  ): Promise<void>;
  runHistoricalBackfill(gitPath: string, batchSize: number): Promise<number>;
  /**
   * FEA-1959 post-backfill remediation: reset mis-attributed default-branch PR
   * artifacts to provisional. Runs in the db host (its `prisma.write` can't cross
   * the method proxy); returns the number of rows reset. See pr-link-maintenance.ts.
   */
  remediateMisattributedPrBranches(): Promise<number>;
  /**
   * FEA-1899 post-backfill link propagation: auto-link branch sessions to their
   * PR artifacts. Runs in the db host (its `prisma.write` can't cross the method
   * proxy); returns the number of sessions linked. See pr-link-maintenance.ts.
   */
  propagateAllBranchPrLinks(): Promise<number>;
  /**
   * FEA-1839 API-error watchdog write: flip a stale errored session and its main
   * agent to `error`. A clone-safe method so the main-process watchdog poller can
   * issue the write across the db-host boundary (its `prisma.write` transaction
   * can't cross the method proxy). See watchdog.ts.
   */
  markSessionErrored(sessionId: string): Promise<void>;
  /**
   * FEA-1999 store-integrity read: run `PRAGMA quick_check` plus the
   * index-presence query on the reader pool and return their rows. Clone-safe
   * (plain-row result) so the main-process integrity probe can read across the
   * db-host boundary (its `prisma.read` callback can't cross the method proxy).
   * See store-integrity-probe.ts.
   */
  runStoreIntegrityCheck(maxErrors: number): Promise<{
    quickRows: Record<string, unknown>[];
    indexRows: { name: string }[];
  }>;
  runTokenParityCheck(): Promise<TokenParityResult>;
  /**
   * Pack install/uninstall audit-log writes. Clone-safe methods so the
   * main-process install orchestrator (`streamRun`) can record runs across the
   * db-host boundary (the underlying `prisma.write` can't cross the method
   * proxy). See packs/catalog-store.ts.
   */
  recordPackInstallRunStart(input: PackInstallRunStartInput): Promise<number>;
  recordPackInstallRunEnd(
    id: number,
    input: PackInstallRunEndInput
  ): Promise<void>;
  diagnostics: {
    getData(): Promise<DiagnosticsData>;
  };
  /**
   * Resolves once the background boot-maintenance chain (analytics backfill,
   * re-pricing, headless recompute, FEA-2866 bare-`repo_full_name` repair, …) has
   * SETTLED. The chain is fire-and-forget so db open never blocks on it, but tests
   * that seed rows those passes also mutate must await this before asserting, so
   * the background sweep does not race their fixtures. Never rejects (each pass is
   * `.catch`-isolated).
   */
  whenBootMaintenanceSettled(): Promise<void>;
  close(): Promise<void>;
};

/**
 * The {@link SqliteAgentDatabase} as seen from the MAIN process, where it is the
 * db-host forwarding proxy (FEA-2038). Only `prisma` differs: it is narrowed to
 * {@link DbHostPrisma}, so the callback-taking `prisma.read` / `prisma.write` are
 * not callable over the proxy (a function can't cross the IPC boundary). Every
 * clone-safe method and `prisma.client` read still works. Main-process code that
 * receives the proxy should be typed against this so a `prisma.read/write`
 * callback is a COMPILE error, not a runtime DataCloneError (FEA-2252). The real
 * in-child `SqliteAgentDatabase` is assignable to this, so child code is
 * unaffected.
 */
export type DbHostAgentDatabase = Omit<SqliteAgentDatabase, "prisma"> & {
  readonly prisma: DbHostPrisma;
};

export type OpenSqliteAgentDatabaseOptions = {
  dataDir: string;
  detectBillingMode: (harness: string) => string;
  emit?: (sessionId: string) => void;
  /** Fired once when a live SessionEnd hook drives a session terminal. */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  extractTranscript?: (path: string) => TranscriptExtract | null;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  resolveGitPath?: () => string;
  log?: (message: string) => void;
  now?: () => string;
  staleMinutes?: number;
  // Data-governance retention window (days). Terminal sessions older than this
  // are purged by the boot retention sweep; omit to use the module default.
  retentionDays?: number;
};

export async function openSqliteAgentDatabase(
  options: OpenSqliteAgentDatabaseOptions
): Promise<SqliteAgentDatabase> {
  await mkdir(path.dirname(options.dataDir), { recursive: true });
  // libSQL/SQLite (WAL): `db` is the boot-time migration handle; the Prisma
  // adapter opens its own connection from `dbConfig` (same file, WAL → concurrent
  // reads while the backfill writes).
  const { db, config: dbConfig } = await openMigrationDatabase(options.dataDir);
  const log = options.log ?? (() => {});
  // The migration runner applies pending migrations, baselines a pre-runner
  // install (re-asserts the frozen legacy DDL once — which preserves the
  // FEA-1785 load-bearing ordering — then records the baseline migrations as
  // applied without executing them), and refuses on checksum drift or a
  // downgraded app. A refusal throws; we close the handle so the DB stays
  // closed, and the caller surfaces it as an Agent Monitor boot failure with
  // DB IPC disabled (no crash loop). Runs before the write queue or any store
  // accepts work.
  try {
    await runDesktopMigrations(db, {
      migrations: MIGRATIONS,
      baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
      baselineMigrations: BASELINE_MIGRATIONS,
      collapsedMigrations: COLLAPSED_MIGRATIONS,
      log,
    });
  } catch (error) {
    // Close the handle so the DB stays closed on refusal, but never let a
    // close() failure mask the original migration error (it is the one the
    // boot path surfaces to the user).
    await db.close().catch(() => undefined);
    throw error;
  }
  const nowFn = options.now ?? (() => new Date().toISOString());
  const queue = createWriteQueue();
  // The single Prisma layer (writer + reader pool) over the same file; writes
  // serialize through the shared queue. Built before the stores so their reads
  // can run on it. If construction fails partway (a connection or PRAGMA
  // throwing), createDesktopPrisma disconnects its own opened clients, but the
  // boot-time migration `db` is ours to close — mirror the migration-refusal
  // cleanup so a post-migration boot failure leaks nothing.
  let prisma: DesktopPrisma;
  try {
    prisma = await createDesktopPrisma(dbConfig, queue);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  // FEA-2038: populate analytics rollups for any pre-existing sessions (upgrades
  // to 0004, or sessions imported before the rollup existed), in the background
  // so it never blocks db open. Runs on the Prisma client (created just above).
  //
  // The whole chain is fire-and-forget so db open never blocks on maintenance,
  // but it is captured as `bootMaintenance` and exposed via
  // `whenBootMaintenanceSettled()` so callers (notably tests) that seed rows the
  // background passes also touch — e.g. the FEA-2866 `repairPollutedRepoFullNames`
  // sweep, which resolves/nulls bare `artifacts.repo_full_name` values — can await
  // it and avoid racing the sweep against their own fixtures.
  const bootMaintenance = backfillSessionAnalytics(prisma, log)
    // Run the re-pricing pass once the backfill has SETTLED (resolved or
    // rejected) — it is an independent pass, so a transient backfill failure
    // must not skip it. `.catch` before `.then` decouples them while still
    // ordering re-pricing after the backfill, so any freshly created rollups are
    // repriced in the same boot.
    .catch(() => undefined)
    // COST_ATTRIBUTION_DRIFT: re-price any token_usage rows a newer genai-prices
    // table can now price and refresh the affected cost snapshots, so
    // `session_analytics.est_cost` (the dashboard KPI) and
    // `sessions.cost_usd_estimated` stop undercounting versus the read-time
    // re-pricing surfaces. Background; never blocks db open.
    .then(() => repriceUnpricedTokenUsage(prisma, log))
    .catch(() => undefined)
    .then(() => healCacheCostSplit(prisma, log))
    .catch(() => undefined)
    // FEA-2870: re-derive the analytics rollup for headless/autonomous sessions
    // that a pre-fix rollup marked human-steered, so the autonomy trend + heatmap
    // heal for existing data. Background; never blocks db open, .catch-isolated.
    .then(() => recomputeHeadlessSessionAnalytics(prisma, log))
    .catch(() => undefined)
    // FEA-3132: one-time backfill of session_turn_bucket for the pre-existing
    // corpus so the Insights autonomy trend + activity heatmap read the
    // materialized table for old sessions too. Now json_each-FREE
    // (rebuildSessionTurnBuckets parses metadata in JS), so it no longer SIGTRAPs
    // the @libsql layer on large sessions the way the prior json_each backfill
    // did (db-host exit code 5 -> boot crash storm). Runs after the headless
    // recompute so metadata classification is settled. Background; never blocks
    // db open, .catch-isolated.
    .then(() => backfillSessionTurnBuckets(prisma, log))
    .catch(() => undefined)
    // FEA-2866: repair artifact rows whose repo_full_name is a bare cwd basename
    // (worktree/temp/plain-folder name) the parser recorded before the write
    // path was hardened — resolve to a validated owner/repo or null the junk, so
    // the repo breakdowns stop surfacing non-repositories. Background; never
    // blocks db open, and its .catch keeps a failure from affecting the caller.
    .then(() => repairPollutedRepoFullNames(prisma, log))
    .catch(() => undefined);
  // The events + token-usage stores run on the single Prisma client — `replace`
  // takes an optional `Prisma.TransactionClient` so the importer / lifecycle /
  // sync paths run it inside their `$transaction`.
  const tokenUsage = createSqliteTokenUsageStore(prisma);
  const events = createSqliteEventStore(prisma);
  const sessions = createSqliteSessionStore(prisma);
  const agents = createSqliteAgentStore(prisma, events);
  const dashboard = createSqliteDashboardQueries(prisma);

  // Gap 8: Sweep orphaned sessions left in 'active' status by a process kill
  // that never delivered a SessionEnd hook. Runs once at boot, before the
  // importer starts, so stale sessions are cleaned up proactively.
  //
  // Awaited (not fire-and-forget) under libSQL: a single connection can hold
  // only one open write transaction at a time, so an in-flight sweep
  // transaction would force any concurrent write to fail with SQLITE_BUSY.
  // Completing the sweep before returning the handle guarantees no write
  // transaction is open when the caller (or a test) starts writing. The sweep is
  // a single fast UPDATE over the orphan set, so the boot cost is negligible.
  await sweepOrphanedSessions(prisma, nowFn())
    .then((swept) => {
      if (swept > 0) {
        log(`boot: swept ${swept} orphaned session(s) to abandoned`);
      }
    })
    .catch((e: unknown) =>
      log(
        `boot: orphaned-session sweep failed: ${e instanceof Error ? e.message : String(e)}`
      )
    );

  // Privacy / data-governance: purge terminal sessions older than the retention
  // window so the local store does not keep full session history (transcripts,
  // tool calls, token usage, agents) indefinitely. Runs once per boot, right
  // after the orphan sweep and before the importer — and, like it, is awaited
  // so no retention-delete transaction is left open under libSQL's single
  // connection when the caller starts writing. The delete is bounded to the
  // sessions crossing the window on this boot, so the boot cost stays small.
  await sweepExpiredSessions(prisma, nowFn(), options.retentionDays)
    .then((purged) => {
      if (purged > 0) {
        log(`boot: purged ${purged} session(s) past the retention window`);
      }
    })
    .catch((e: unknown) =>
      log(
        `boot: retention sweep failed: ${e instanceof Error ? e.message : String(e)}`
      )
    );

  const database: SqliteAgentDatabase = {
    backend: "sqlite",
    connection: null,
    prisma,
    writeQueue: queue,
    importer: createSqliteImporter(prisma, tokenUsage, {
      detectBillingMode: options.detectBillingMode,
      now: nowFn,
      log,
      onPostImport: (cwd) => {
        if (!(cwd && options.resolveGitPath)) {
          return;
        }
        const gitPath = options.resolveGitPath();
        captureRepoIdentityFn(gitPath, cwd, prisma, nowFn()).catch(
          (e: unknown) =>
            log(
              `post-import repo identity capture failed: ${e instanceof Error ? e.message : String(e)}`
            )
        );
      },
    }),
    syncSource: createSqliteSessionSyncSource(prisma),
    transcriptSync: createTranscriptSyncStore(prisma),
    sessions,
    agents,
    events,
    tokenUsage,
    codexOtel: {
      persistBatch: async (batch: unknown) => {
        const parsedBatch = parseCodexOtelBatch(batch);
        if (
          parsedBatch.spans.length === 0 &&
          parsedBatch.tokenUsage.length === 0
        ) {
          return;
        }
        // persistCodexOtelBatch owns its own write-queue + `$transaction`
        // serialization via the single Prisma client, so no outer
        // prisma.write wrapper here.
        await persistCodexOtelBatch({
          prisma,
          batch: parsedBatch,
          now: nowFn(),
        });
      },
    },
    dashboard,
    getSummary: () => dashboard.getSummary(),
    run: async (sql: string, ...params: unknown[]) => {
      // Arbitrary-statement escape hatch — runs on the writer through the queue.
      // $executeRawUnsafe applies the $N→?N translation + arg coercion via the
      // prisma-client.ts wrapper.
      await prisma.write((client) => client.$executeRawUnsafe(sql, ...params));
    },
    // The captured background boot-maintenance chain (see `bootMaintenance`
    // above). Never rejects — each pass is `.catch`-isolated — so awaiting it only
    // gates on completion, never on failure. The chain's final `.then` returns the
    // repair count; discard it so the public contract is `Promise<void>`.
    whenBootMaintenanceSettled: async () => {
      await bootMaintenance;
    },
    processEvent: createSqliteLifecycle(prisma, tokenUsage, {
      detectBillingMode: options.detectBillingMode,
      emit: options.emit,
      onSessionTerminal: options.onSessionTerminal,
      extractTranscript: options.extractTranscript,
      getUserIdentity: options.getUserIdentity,
      log,
      now: nowFn,
      staleMinutes: options.staleMinutes,
    }).processEvent,
    loadMeteredUsageRows: (cutoffIso: string) =>
      loadSqliteMeteredUsageRows(prisma, cutoffIso),
    async recordCollectionModeViolation(
      harness: string,
      externalSessionId: string
    ): Promise<void> {
      if (!(harness && externalSessionId)) {
        return;
      }
      try {
        // Synthetic diagnostic session_id (never a real harness session id): keeps
        // the violation row out of any real session's event stream and out of
        // reach of rebuildSessionFromParse's `DELETE FROM events WHERE session_id
        // = $1`, so the row durably persists once written. The real session id is
        // preserved in the data payload.
        const diagnosticSessionId = `${COLLECTION_VIOLATION_SESSION_PREFIX}${harness}:${externalSessionId}`;
        await prisma.write((client) =>
          client.$executeRawUnsafe(
            "INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
            collectionViolationEventId(harness, externalSessionId),
            diagnosticSessionId,
            null,
            "mutual_exclusivity_violation",
            null,
            harness,
            JSON.stringify({ harness, externalSessionId }),
            nowFn()
          )
        );
      } catch (error) {
        log(
          `recordCollectionModeViolation failed (harness=${harness}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async listExistingSessionIds(): Promise<Set<string>> {
      const rows = await prisma.read((reader) =>
        reader.session.findMany({ select: { id: true } })
      );
      return new Set(rows.map((row) => row.id));
    },
    async listStaleRevisionSessions(
      currentRevision: number
    ): Promise<Array<{ id: string; harness: string | null; status: string }>> {
      return prisma.read((reader) =>
        reader.session.findMany({
          where: { dataRevision: { not: currentRevision } },
          select: { id: true, harness: true, status: true },
        })
      );
    },
    async rebuildSessionFromParse(
      session: NormalizedSession,
      harness: Harness
    ): Promise<{ rebuilt: boolean; activeRace: boolean }> {
      if (!(session.sessionId && session.startedAt)) {
        return { rebuilt: false, activeRace: false };
      }
      try {
        return await prisma.write((client) =>
          client.$transaction(async (tx) => {
            // In-tx re-check: a session that is non-terminal (active, running,
            // etc.) must not be rebuilt — it heals via ordinary reimport.
            const current = await tx.session.findUnique({
              where: { id: session.sessionId },
              select: { status: true },
            });
            if (current && !TERMINAL_STATUS_SET.has(current.status)) {
              return { rebuilt: false, activeRace: true };
            }
            await tx.$executeRawUnsafe(
              "DELETE FROM events WHERE session_id = $1",
              session.sessionId
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM token_events WHERE session_id = $1",
              session.sessionId
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
              session.sessionId,
              CodexOtelTokenUsageSource.JsonlParser
            );
            await deleteClaudeCodeOtelSessionRows(tx, session.sessionId);
            await tx.$executeRawUnsafe(
              "DELETE FROM agents WHERE session_id = $1",
              session.sessionId
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM session_artifact_links WHERE session_id = $1",
              session.sessionId
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM pull_requests WHERE session_id = $1",
              session.sessionId
            );
            await tx.$executeRawUnsafe(
              "DELETE FROM artifact_link_backfill_seen WHERE session_id = $1",
              session.sessionId
            );
            // FEA-2267: clear the activity-segment backfill marker too, for
            // symmetry with artifact_link_backfill_seen. The segments themselves
            // are refreshed by importSessionWithTx -> persistActivitySegments
            // below; dropping the marker avoids the backfill re-tiling this
            // rebuilt session a redundant second time after a combined
            // DATA_REVISION + ACTIVITY_CLASSIFIER_VERSION bump.
            await tx.activitySegmentBackfillSeen.deleteMany({
              where: { sessionId: session.sessionId },
            });
            await importSessionWithTx(
              tx,
              tokenUsage,
              { detectBillingMode: options.detectBillingMode, log },
              session,
              harness,
              nowFn(),
              {
                attributionByCwd: new Map(),
                launchMetadataRootByCwd: new Map(),
                repoFullNameByPath: new Map(),
              }
            );
            // FEA-2177 + FEA-2260: rebuilt pull_requests rows may have NULL or
            // a poisoned default-branch branch_name. If the PR artifact was
            // already enriched (branch_name filled from GitHub headRefName),
            // propagate it back so the Branches view's join doesn't lose
            // attribution. The subquery excludes default branches from the
            // artifact source to avoid re-poisoning.
            await tx.$executeRawUnsafe(
              `UPDATE pull_requests SET branch_name = (
                 SELECT a.branch_name FROM artifacts a
                 WHERE a.kind = 'pull_request'
                   AND a.repo_full_name = pull_requests.repo_full_name
                   AND a.pr_number = pull_requests.pr_number
                   AND a.branch_name IS NOT NULL
                   AND (a.branch_name NOT IN (${defaultBranchSqlList()})
                        OR a.enrichment_state = 'final')
                 LIMIT 1
               )
               WHERE session_id = $1
                 AND (branch_name IS NULL
                      OR branch_name IN (${defaultBranchSqlList()}))
                 AND EXISTS (
                   SELECT 1 FROM artifacts a
                   WHERE a.kind = 'pull_request'
                     AND a.repo_full_name = pull_requests.repo_full_name
                     AND a.pr_number = pull_requests.pr_number
                     AND a.branch_name IS NOT NULL
                     AND (a.branch_name NOT IN (${defaultBranchSqlList()})
                          OR a.enrichment_state = 'final')
                 )`,
              session.sessionId
            );
            return { rebuilt: true, activeRace: false };
          })
        );
      } catch (error) {
        log(
          `sqlite rebuildSessionFromParse failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { rebuilt: false, activeRace: false };
      }
    },
    async deleteSessionRow(sessionId: string): Promise<void> {
      // Cloud-side copies of sessions deleted here are removed by FEA-1787's
      // phantom-purge script — no local tombstone mechanism exists.
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          // Re-check status inside the transaction: a session that became
          // non-terminal (active, running) between listing and this tx must
          // not be deleted — it heals via ordinary reimport.
          const current = await tx.session.findUnique({
            where: { id: sessionId },
            select: { status: true },
          });
          if (current && !TERMINAL_STATUS_SET.has(current.status)) {
            return;
          }
          await tx.event.deleteMany({ where: { sessionId } });
          // token_events is @@ignore'd (no PK → excluded from the generated
          // client), so it has no typed delegate; delete it raw inside the
          // same transaction.
          await tx.$executeRawUnsafe(
            "DELETE FROM token_events WHERE session_id = $1",
            sessionId
          );
          // FEA-2267: session_activity_segments has no FK cascade (segments are
          // re-derived per import), so purge it explicitly in the same tx —
          // otherwise the activity-timing rows orphan on session deletion.
          await tx.sessionActivitySegment.deleteMany({ where: { sessionId } });
          // FEA-3132: session_turn_bucket has no FK cascade either (buckets are
          // re-materialized per import by rebuildSessionTurnBuckets), so purge it
          // explicitly too — otherwise the turn-count rows orphan on deletion.
          await tx.sessionTurnBucket.deleteMany({ where: { sessionId } });
          await tx.tokenUsage.deleteMany({ where: { sessionId } });
          await tx.codexTraceSpan.deleteMany({ where: { sessionId } });
          // claude_code_* OTel rows. Inlined as typed deletes here; the raw
          // deleteClaudeCodeOtelSessionRows helper remains for the still-raw
          // rebuildSessionFromParse path until it converts.
          await tx.claudeCodeCostEvent.deleteMany({ where: { sessionId } });
          await tx.claudeCodePermissionEvent.deleteMany({
            where: { sessionId },
          });
          await tx.claudeCodeApiRequest.deleteMany({ where: { sessionId } });
          // FEA-1899: PR rows are now artifacts; detach via the link table only.
          await tx.sessionArtifactLink.deleteMany({ where: { sessionId } });
          await tx.artifactLinkBackfillSeen.deleteMany({
            where: { sessionId },
          });
          // activity_segment_backfill_seen FK-cascades on the session delete
          // below, but delete it explicitly too, mirroring the sibling marker.
          await tx.activitySegmentBackfillSeen.deleteMany({
            where: { sessionId },
          });
          // agents cascade via FK on sessions(id) (foreign_keys=ON on the
          // adapter connection — verified), but the explicit child deletes
          // above cover tables without ON DELETE CASCADE.
          await tx.session.deleteMany({ where: { id: sessionId } });
        })
      );
    },
    async recomputeAnalyticsRollups(sessionIds: string[]): Promise<void> {
      // FEA-3056/FEA-3143 (D6): bound peak memory —
      // `upsertSessionAnalyticsRollupBatch` runs a `json_each` scan over every
      // message of every session in the batch, so a big batch blows the db-host
      // worker's heap (exit code 5 → crash loop → no data). A fixed
      // SESSION_ANALYTICS_BACKFILL_CHUNK count bounds the SESSION count but not
      // the turns/bytes per session, so one ~12 MB transcript still balloons the
      // intermediate ×25. Budget each chunk by summed metadata bytes (secondary
      // count bound = SESSION_ANALYTICS_BACKFILL_CHUNK) so a single oversized
      // session forms its own chunk — matching backfillSessionAnalytics /
      // recomputeHeadlessSessionAnalytics. Output is unchanged: every id still
      // lands in exactly one chunk. The loop commits + releases between chunks;
      // the per-chunk try/catch isolates a heavy chunk.
      const chunks = await chunkSessionIdsByMetadataBudget(
        prisma,
        sessionIds,
        SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
        SESSION_ANALYTICS_BACKFILL_CHUNK
      );
      let offset = 0;
      for (const chunk of chunks) {
        try {
          await prisma.write((client) =>
            client.$transaction((tx) =>
              upsertSessionAnalyticsRollupBatch(tx, chunk, nowFn())
            )
          );
        } catch (error) {
          log(
            `recomputeAnalyticsRollups failed for chunk [${offset}, ${offset + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
          );
        }
        offset += chunk.length;
      }
    },
    async captureRepoIdentity(gitPath: string, cwd: string) {
      const now = nowFn();
      try {
        const result = await captureRepoIdentityFn(gitPath, cwd, prisma, now);
        return { repoFullName: result.repoFullName };
      } catch (error) {
        log(
          `captureRepoIdentity failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { repoFullName: null };
      }
    },
    async triggerEnrichmentSweep(gitPath: string, ghPath: string, opts?) {
      try {
        await triggerEnrichmentSweepFn(prisma, gitPath, ghPath, opts);
      } catch (error) {
        log(
          `enrichment sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async runHistoricalBackfill(gitPath: string, batchSize: number) {
      const now = nowFn();
      try {
        return await runHistoricalBackfillFn(gitPath, prisma, batchSize, now);
      } catch (error) {
        log(
          `historical backfill failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return 0;
      }
    },
    remediateMisattributedPrBranches(): Promise<number> {
      return remediateMisattributedPrBranchesFn(prisma, log);
    },
    propagateAllBranchPrLinks(): Promise<number> {
      return propagateAllBranchPrLinksFn(prisma, log);
    },
    async markSessionErrored(sessionId: string): Promise<void> {
      const now = nowFn();
      // Flip session + main agent together so the dashboard never shows a session
      // in `error` with a still-running agent (or vice versa) between two writes.
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "UPDATE sessions SET status = 'error', updated_at = $1 WHERE id = $2 AND status NOT IN ('completed', 'error', 'abandoned')",
            now,
            sessionId
          );
          await tx.$executeRawUnsafe(
            "UPDATE agents SET status = 'error', ended_at = $1, updated_at = $1 WHERE session_id = $2 AND status NOT IN ('completed', 'error')",
            now,
            sessionId
          );
        })
      );
    },
    runStoreIntegrityCheck(maxErrors: number): Promise<{
      quickRows: Record<string, unknown>[];
      indexRows: { name: string }[];
    }> {
      // Both reads run in ONE reader-pool dispatch so quick_check and the
      // index-presence query observe the SAME committed WAL snapshot.
      return prisma.read(async (reader) => ({
        quickRows: await reader.$queryRawUnsafe<Record<string, unknown>[]>(
          storeIntegrityQuickCheckSql(maxErrors)
        ),
        indexRows: await reader.$queryRawUnsafe<{ name: string }[]>(
          STORE_INTEGRITY_INDEX_SQL
        ),
      }));
    },
    runTokenParityCheck(): Promise<TokenParityResult> {
      // Exclude OTel-only rows (usage_source = 'otel_log_payload') from the
      // token_usage side — the Codex OTel writer persists to token_usage but
      // not token_events, so including them would flag legitimate OTel data
      // as permanent divergence.
      const USAGE_FILTER =
        "WHERE COALESCE(usage_source, 'jsonl_parser') != 'otel_log_payload'";
      return prisma.read(async (reader) => {
        const [usageRow] = await reader.$queryRawUnsafe<
          {
            input: bigint;
            output: bigint;
            cache_read: bigint;
            cache_write: bigint;
          }[]
        >(
          `SELECT
            COALESCE(SUM(input_tokens), 0) as input,
            COALESCE(SUM(output_tokens), 0) as output,
            COALESCE(SUM(cache_read_tokens), 0) as cache_read,
            COALESCE(SUM(cache_write_tokens), 0) as cache_write
          FROM token_usage ${USAGE_FILTER}`
        );
        const [eventsRow] = await reader.$queryRawUnsafe<
          {
            input: bigint;
            output: bigint;
            cache_read: bigint;
            cache_write: bigint;
          }[]
        >(
          `SELECT
            COALESCE(SUM(input_tokens), 0) as input,
            COALESCE(SUM(output_tokens), 0) as output,
            COALESCE(SUM(cache_read_tokens), 0) as cache_read,
            COALESCE(SUM(cache_write_tokens), 0) as cache_write
          FROM token_events`
        );
        const [divergentRow] = await reader.$queryRawUnsafe<{ cnt: bigint }[]>(
          `SELECT COUNT(*) as cnt FROM (
            SELECT session_id, model FROM (
              SELECT session_id, model,
                COALESCE(SUM(input_tokens), 0) as i,
                COALESCE(SUM(output_tokens), 0) as o,
                COALESCE(SUM(cache_read_tokens), 0) as cr,
                COALESCE(SUM(cache_write_tokens), 0) as cw
              FROM token_usage ${USAGE_FILTER}
              GROUP BY session_id, model
            ) u
            FULL OUTER JOIN (
              SELECT session_id, model,
                COALESCE(SUM(input_tokens), 0) as i,
                COALESCE(SUM(output_tokens), 0) as o,
                COALESCE(SUM(cache_read_tokens), 0) as cr,
                COALESCE(SUM(cache_write_tokens), 0) as cw
              FROM token_events
              GROUP BY session_id, model
            ) e USING (session_id, model)
            WHERE COALESCE(u.i, 0) != COALESCE(e.i, 0)
              OR COALESCE(u.o, 0) != COALESCE(e.o, 0)
              OR COALESCE(u.cr, 0) != COALESCE(e.cr, 0)
              OR COALESCE(u.cw, 0) != COALESCE(e.cw, 0)
          )`
        );
        return {
          usageInput: Number(usageRow?.input ?? 0),
          usageOutput: Number(usageRow?.output ?? 0),
          usageCacheRead: Number(usageRow?.cache_read ?? 0),
          usageCacheWrite: Number(usageRow?.cache_write ?? 0),
          eventsInput: Number(eventsRow?.input ?? 0),
          eventsOutput: Number(eventsRow?.output ?? 0),
          eventsCacheRead: Number(eventsRow?.cache_read ?? 0),
          eventsCacheWrite: Number(eventsRow?.cache_write ?? 0),
          divergentSessionCount: Number(divergentRow?.cnt ?? 0),
        };
      });
    },
    recordPackInstallRunStart(
      input: PackInstallRunStartInput
    ): Promise<number> {
      return recordPackInstallRunStartFn(prisma, input);
    },
    recordPackInstallRunEnd(
      id: number,
      input: PackInstallRunEndInput
    ): Promise<void> {
      return recordPackInstallRunEndFn(prisma, id, input);
    },
    diagnostics: {
      getData: () => getDiagnosticsDataFn(prisma),
    },
    close: async () => {
      await queue.drain();
      await prisma.disconnect().catch(() => undefined);
      await db.close();
    },
  };

  return database;
}
