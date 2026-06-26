import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import { parseIsoMs, roundNumber } from "../session-marker-utils.js";
import {
  openLibsqlDatabase,
  type SqliteClient,
  type SqliteExecutor,
} from "./libsql-executor.js";

// Re-exported so existing importers keep resolving these from sqlite.ts.
export type {
  Results,
  SqliteClient,
  SqliteExecutor,
  TransactionalSqliteExecutor,
} from "./libsql-executor.js";

import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import {
  deriveSessionTracePresentation,
  SESSION_TRACE_SOURCE_LIMITS,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
  sessionPrWithLifecycle,
} from "@repo/api/src/session-trace/derivation";
import type {
  LocalArtifactSessionUsage,
  SessionPrRelationType,
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
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
import { isMeteredApi } from "../../shared/billing-mode.js";
import type { DiagnosticsData } from "../../shared/diagnostics-contract.js";
import { computeSessionTiming } from "../../shared/session-timing.js";
import {
  type EstimateTokenCostResult,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import type {
  HookData,
  Importer,
  ImportResult,
  TokenUsageCounts,
  TokenUsageRow,
} from "../agent-dashboard-db-types.js";
import type {
  ActivityBucket,
  SessionMarker,
  SessionPR,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "../agent-session-sync-contract.js";
import { estimateSessionPayloadBytes } from "../agent-session-sync-payload.js";
import {
  type AgentSessionAnalyticsAgentTypeGroup,
  type AgentSessionAnalyticsAggregate,
  type AgentSessionAnalyticsRepositoryGroup,
  type AgentSessionAnalyticsToolGroup,
  type AgentSessionSyncSource,
  type AgentSessionUsageAggregate,
  type AgentSessionUsageAggregateFilters,
  type PersistedSyncState,
  parseJsonObjectText,
  parseJsonValueText,
  parsePersistedObservedIds,
  resolveBillingModeForRow,
  resolveSessionAttribution,
  resolveSessionAttributionAsync,
  resolveTokenUsageCostUsd,
  type SessionAttributionResolverCache,
  type SessionCursorRow,
  type SessionListCursorPage,
  type SessionListCursorPageRequest,
  SessionListCursorSortKey,
} from "../agent-session-sync-service.js";
import { resolveBillingMode } from "../billing-mode-detector.js";
import {
  type ArtifactRefRecord,
  artifactLinkId,
  canonicalKeyForRef,
  extractArtifactRefs,
  extractLaunchMetadataRefs,
} from "../collectors/artifact-ref-extractor.js";
import { DATA_REVISION } from "../collectors/data-revision.js";
import { scanSubagentTranscriptStream } from "../collectors/subagent-scanner.js";
import type {
  Harness,
  NormalizedSession,
  NormalizedToolUse,
} from "../collectors/types.js";
import {
  type EnrichmentSweepOptions,
  triggerEnrichmentSweep as triggerEnrichmentSweepFn,
} from "../enrichment/enrichment-runner.js";
import { runHistoricalBackfill as runHistoricalBackfillFn } from "../enrichment/historical-backfill.js";
import {
  type ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../enrichment/identity-key.js";
import { captureRepoIdentity as captureRepoIdentityFn } from "../enrichment/repo-identity.js";
import {
  ModelPricingCurrency,
  ModelPricingSource,
} from "../model-pricing/model-pricing-fixture.js";
import {
  CodexOtelTokenUsageSource,
  parseCodexOtelBatch,
} from "../otel/codex-otel-contract.js";
import { persistCodexOtelBatch } from "../otel/codex-otel-writer.js";
import { upsertPullRequest } from "../pull-requests/pr-store.js";
import type { MeteredUsageRow } from "../reconciliation-worker.js";
import {
  buildArtifactSessionMarkers,
  mergeSessionMarkers,
} from "../session-artifact-markers.js";
import { reportTokenCostPricingMiss } from "../token-cost-pricing-miss.js";
import {
  addStorageTokenCounts,
  InvalidTokenCountError,
  readStorageTokenCount,
} from "../token-counts.js";
import {
  BASELINE_MIGRATIONS,
  COLLAPSED_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "./baseline-schema.js";
import {
  buildEventDedupKey,
  collectionViolationEventId,
  deterministicEventId,
} from "./deterministic-event-id.js";
import { getDiagnosticsData as getDiagnosticsDataFn } from "./diagnostics-store.js";
import type { Prisma } from "./generated/client.js";
import { computeLocalInsights } from "./local-insights.js";
import { runDesktopMigrations } from "./migration-runner.js";
import { MIGRATIONS } from "./migrations-manifest.js";
import { createDesktopPrisma, type DesktopPrisma } from "./prisma-client.js";
import { sweepOrphanedSessions } from "./session-maintenance.js";
import { createTranscriptCache, type TranscriptExtract } from "./transcript.js";
import { createWriteQueue } from "./write-queue.js";

const defaultTranscriptExtract = createTranscriptCache();

/**
 * FEA-1459 Fix 6: Resolve the machine's IANA timezone for day-bucketing queries.
 * Falls back to "UTC" if Intl is unavailable.
 */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Desktop-local session/agent status model for the embedded sqlite store. This
 * is intentionally DISTINCT from the cloud `SESSION_STATUS` in
 * `@closedloop-ai/loops-api/session-status`: the desktop store tracks a richer,
 * live agent lifecycle (e.g. `working`/`running`) that the cloud contract does
 * not model, and it lives entirely inside this process. Keeping the consts
 * local avoids coupling the embedded schema to the cross-runtime contract.
 */
const DESKTOP_SESSION_STATUS = {
  ACTIVE: "active",
  WAITING: "waiting",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
  ERROR: "error",
} as const;
const DESKTOP_AGENT_STATUS = {
  WORKING: "working",
  WAITING: "waiting",
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

const TERMINAL_STATUSES = `('${DESKTOP_SESSION_STATUS.COMPLETED}', '${DESKTOP_SESSION_STATUS.ABANDONED}', '${DESKTOP_SESSION_STATUS.ERROR}')`;
const TERMINAL_STATUS_SET = new Set<string>([
  DESKTOP_SESSION_STATUS.COMPLETED,
  DESKTOP_SESSION_STATUS.ABANDONED,
  DESKTOP_SESSION_STATUS.ERROR,
]);
const MAX_SESSION_PAGE_LIMIT = 100;
const DEFAULT_SESSION_PAGE_LIMIT = 25;
const COMPACTION_RE = /compact|compress|context.*(reduc|truncat|summar)/i;
const WAITING_INPUT_RE =
  /needs your permission|waiting for your input|is waiting|requires approval|permission to use/i;
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;
const MAX_EVENT_DATA_BYTES = 64 * 1024;
const GITHUB_REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
const SESSION_TRACE_BUCKET_TARGET = 40;
const SESSION_TRACE_PHASE_EVENT_RE =
  /(^|[._:-])(loop\.perf\.phase|session[_:. -]?trace[_:. -]?phase|trace[_:. -]?phase|phase)([._:-]|$)/i;
const SESSION_TRACE_THROTTLE_EVENT_RE =
  /(^|[._:-])(session[_:. -]?trace[_:. -]?throttle|trace[_:. -]?throttle|provider[_:. -]?rate[_:. -]?limit|rate[_:. -]?limit|usage[_:. -]?limit|throttle)([._:-]|$)/i;
const SESSION_TRACE_CORRECTION_EVENT_RE =
  /(^|[._:-])(session[_:. -]?trace[_:. -]?correction|trace[_:. -]?correction|manual[_:. -]?regression|change[_:. -]?request|review[_:. -]?requested[_:. -]?changes|approval[_:. -]?denied|negative[_:. -]?feedback|correction)([._:-]|$)/i;

/**
 * FEA-1839: prefix for the synthetic `session_id` of a
 * `mutual_exclusivity_violation` event. A real harness session id is a bare
 * id/uuid, so this namespaced value can never collide with one — keeping the
 * diagnostic row off any real session's event stream and clear of
 * `rebuildSessionFromParse`'s per-session DELETE.
 */
export const COLLECTION_VIOLATION_SESSION_PREFIX = "mutual-exclusivity:";

interface SessionRowRaw extends Record<string, unknown> {
  id: string;
  status: string;
  harness: string | null;
  billing_mode: string | null;
  model: string | null;
}

interface AgentRowRaw extends Record<string, unknown> {
  id: string;
  status: string;
  type: string | null;
  parent_agent_id: string | null;
}

export type SqliteAgentDatabase = {
  backend: "sqlite";
  connection: null;
  importer: Importer;
  syncSource: AgentSessionSyncSource;
  sessions: {
    getById(id: string): Promise<SessionRow | undefined>;
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
    getTokenAnalytics(): Promise<TokenAnalytics>;
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
    getAnalytics(): Promise<AnalyticsData>;
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
   * FEA-1791: the single typed Prisma client over this SQLite handle. Store
   * reads go through `prisma.client` (typed delegates or the `$queryRawUnsafe`
   * escape hatch) and writes through `prisma.write(...)`, serialized on the
   * shared write queue. (The legacy raw `storeDb` accessor has been removed.)
   */
  prisma: DesktopPrisma;
  writeQueue: ReturnType<typeof createWriteQueue>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  processEvent(
    hookType: string,
    data: HookData,
    harness: string
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
  diagnostics: {
    getData(): Promise<DiagnosticsData>;
  };
  close(): Promise<void>;
};

export type OpenSqliteAgentDatabaseOptions = {
  dataDir: string;
  detectBillingMode: (harness: string) => string;
  emit?: (sessionId: string) => void;
  extractTranscript?: (path: string) => TranscriptExtract | null;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  resolveGitPath?: () => string;
  resolveGhPath?: () => string;
  log?: (message: string) => void;
  now?: () => string;
  staleMinutes?: number;
};

export async function openSqliteAgentDatabase(
  options: OpenSqliteAgentDatabaseOptions
): Promise<SqliteAgentDatabase> {
  await mkdir(path.dirname(options.dataDir), { recursive: true });
  // libSQL/SQLite (WAL): the raw store path uses `db`; the Prisma adapter opens
  // its own connection from `dbConfig` (same file, WAL → concurrent reads while
  // the backfill writes).
  const { db, config: dbConfig } = await openLibsqlDatabase(options.dataDir);
  const log = options.log ?? (() => {});
  // FEA-1791 Phase 2: the migration runner replaces the legacy
  // db.exec(SQLITE_SCHEMA) boot. It applies pending migrations, baselines a
  // pre-runner install (re-asserts the frozen legacy DDL once — which preserves
  // the FEA-1785 load-bearing ordering — then records the baseline migrations
  // as applied without executing them), and refuses on checksum drift or a
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
  // FEA-1791 Phase 3: one Prisma client over the same handle; writes serialize
  // through the same queue as the raw store path. Built before the stores so the
  // converted reads can run on it.
  const prisma = createDesktopPrisma(dbConfig, queue);
  // FEA-2038: populate analytics rollups for any pre-existing sessions (upgrades
  // to 0004, or sessions imported before the rollup existed), in the background
  // so it never blocks db open. Runs on the Prisma client (created just above).
  backfillSessionAnalytics(prisma, log).catch(() => undefined);
  // FEA-1791 Phase 3: the events + token-usage stores run fully on the single
  // Prisma client — `replace` takes an optional `Prisma.TransactionClient` so the
  // importer / lifecycle / sync paths run it inside their `$transaction`.
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
  // transaction would force any concurrent write — including the raw store
  // writes that bypass the queue — to fail with SQLITE_BUSY. Completing the
  // sweep before returning the handle guarantees no write transaction is open
  // when the caller (or a test) starts writing. The sweep is a single fast
  // UPDATE over the orphan set, so the boot cost is negligible.
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
        captureRepoIdentityFn(gitPath, cwd, prisma, nowFn())
          .then((identity) => {
            // A live import wrote new artifact links; the startup sweep already
            // ran, so without this they stay unenriched until the next restart.
            // Scope to the captured repo and let the debounce coalesce bursts.
            if (!options.resolveGhPath) {
              return;
            }
            return triggerEnrichmentSweepFn(
              prisma,
              gitPath,
              options.resolveGhPath(),
              {
                repoFullName: identity.repoFullName ?? undefined,
              }
            );
          })
          .catch((e: unknown) =>
            log(
              `post-import enrichment failed: ${e instanceof Error ? e.message : String(e)}`
            )
          );
      },
    }),
    syncSource: createSqliteSessionSyncSource(db, prisma),
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
        // queue.run/db.transaction wrapper here.
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
      await db.query(sql, params);
    },
    processEvent: createSqliteLifecycle(prisma, tokenUsage, {
      detectBillingMode: options.detectBillingMode,
      emit: options.emit,
      extractTranscript: options.extractTranscript,
      getUserIdentity: options.getUserIdentity,
      log,
      now: nowFn,
      staleMinutes: options.staleMinutes,
    }).processEvent,
    loadMeteredUsageRows: (cutoffIso: string) =>
      loadSqliteMeteredUsageRows(db, cutoffIso),
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
        await queue.run(() =>
          db.query(
            "INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
            [
              collectionViolationEventId(harness, externalSessionId),
              diagnosticSessionId,
              null,
              "mutual_exclusivity_violation",
              null,
              harness,
              JSON.stringify({ harness, externalSessionId }),
              nowFn(),
            ]
          )
        );
      } catch (error) {
        log(
          `recordCollectionModeViolation failed (harness=${harness}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async listExistingSessionIds(): Promise<Set<string>> {
      const result = await db.query<{ id: string }>("SELECT id FROM sessions");
      return new Set(result.rows.map((row) => row.id));
    },
    async listStaleRevisionSessions(
      currentRevision: number
    ): Promise<Array<{ id: string; harness: string | null; status: string }>> {
      const result = await db.query<{
        id: string;
        harness: string | null;
        status: string;
      }>("SELECT id, harness, status FROM sessions WHERE data_revision != $1", [
        currentRevision,
      ]);
      return result.rows;
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
            const current = await tx.$queryRawUnsafe<
              {
                status: string;
                updated_at: string | null;
              }[]
            >(
              "SELECT status, updated_at FROM sessions WHERE id = $1",
              session.sessionId
            );
            if (current[0] && !TERMINAL_STATUS_SET.has(current[0].status)) {
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
            await importSessionWithTx(
              tx,
              tokenUsage,
              { detectBillingMode: options.detectBillingMode },
              session,
              harness,
              nowFn(),
              {
                attributionByCwd: new Map(),
                launchMetadataRootByCwd: new Map(),
                repoFullNameByPath: new Map(),
              }
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
          // agents cascade via FK on sessions(id) (foreign_keys=ON on the
          // adapter connection — verified), but the explicit child deletes
          // above cover tables without ON DELETE CASCADE.
          await tx.session.deleteMany({ where: { id: sessionId } });
        })
      );
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

/**
 * The promise-chain write queue that serializes all writes on SQLite's single
 * connection. Exported so tests can drive the Prisma factory with the SAME
 * implementation, preventing the test queue from drifting from production.
 */
// Explicit column projection for session list/detail reads. Lists ONLY the
// columns `toSessionRow` (and `detailRowsToList`) actually consume, so the
// large unused `sessions` columns — `metadata` is read and therefore kept, but
// the JSONB `trace_phase_sources` / `throttle_sources` / `correction_sources`
// and the `cost_*` / `data_revision` columns are NOT materialized on every
// listed row. Behavior-preserving: identical mapped `SessionRow` output, fewer
// bytes read. `attachEstimatedCosts` re-queries `cost_usd_estimated` on its own,
// so dropping it here is safe.
const SESSION_ROW_COLUMNS = [
  "id",
  "name",
  "status",
  "cwd",
  "model",
  "started_at",
  "updated_at",
  "ended_at",
  "awaiting_input_since",
  "metadata",
  "harness",
  "billing_mode",
  "user_id",
  "organization_id",
] as const;

// `s.`-aliased column list for the detail CTE queries that join aggregate
// counts onto `sessions s` (replaces the prior `s.*`).
const SESSION_DETAIL_SELECT_COLUMNS = SESSION_ROW_COLUMNS.map(
  (column) => `s.${column}`
).join(", ");

// Columns that make up a SessionRow, projected explicitly (matches
// SESSION_ROW_COLUMNS) so the typed reads return exactly the SessionRow shape and
// no later schema column leaks through.
const SESSION_ROW_SELECT = {
  id: true,
  name: true,
  status: true,
  cwd: true,
  model: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
  awaitingInputSince: true,
  metadata: true,
  harness: true,
  billingMode: true,
  userId: true,
  organizationId: true,
} satisfies Prisma.SessionSelect;

// FEA-1791 Phase 3: the session store runs entirely on the single DesktopPrisma
// client. The plain reads (getById/getAll/getActive) are typed delegates. The
// DETAIL reads (getDetailsById/getActiveWithDetails/getHistoricalWithDetails/
// getPage) stay on raw `$queryRawUnsafe` BY DESIGN — sessionDetailsCtes() folds
// the per-session COUNT(agents)/COUNT(events)/SUM(tokens) into the row in ONE
// server-side aggregate-join. That is both un-typeable (events/token_usage have
// no session relation; total_tokens is a SUM, not a relation `_count`) and the
// performant choice: replacing it with per-table groupBy reads marshalled into a
// JS join is a real regression. getPage's `q` search additionally needs
// `LIKE … ESCAPE` (Prisma `contains` does not escape `%`/`_`, verified against
// libSQL). Only attachEstimatedCosts is converted to typed delegates — two
// id-scoped findMany reads, identical cost/shape to the old raw helpers, no perf
// change. The still-raw `selectRowsByIds`/`selectTokenUsageRows` helpers remain
// for the tx-coupled sync/importer/analytics paths (later PRs).
function createSqliteSessionStore(prisma: DesktopPrisma) {
  let historicalDetailsCache: SessionWithAgents[] | null = null;

  return {
    async getById(id: string): Promise<SessionRow | undefined> {
      return (
        (await prisma.client.session.findUnique({
          where: { id },
          select: SESSION_ROW_SELECT,
        })) ?? undefined
      );
    },
    async getAll(): Promise<SessionRow[]> {
      return await prisma.client.session.findMany({
        select: SESSION_ROW_SELECT,
        orderBy: { startedAt: "desc" },
      });
    },
    async getActive(): Promise<SessionRow[]> {
      return await prisma.client.session.findMany({
        where: { status: { notIn: Array.from(TERMINAL_STATUS_SET) } },
        select: SESSION_ROW_SELECT,
        orderBy: { startedAt: "desc" },
      });
    },
    async getDetailsById(id: string): Promise<SessionWithAgents | undefined> {
      // Single server-side aggregate-join (sessionDetailsCtes): per-session
      // COUNT(agents) / COUNT(events) / SUM(tokens) LEFT-JOINed to the row in ONE
      // query. Stays raw on the one client deliberately — Prisma can't express it
      // typed (events/token_usage have no session relation; total_tokens is a SUM,
      // not a relation `_count`), and, more importantly, it is far cheaper than
      // fetching every session's per-table aggregate and joining in JS.
      const rows = await prisma.client.$queryRawUnsafe<
        Record<string, unknown>[]
      >(
        `${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.id = $1
      `,
        id
      );
      const sessions = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, sessions);
      return sessions[0];
    },
    async getActiveWithDetails(): Promise<SessionWithAgents[]> {
      const rows = await prisma.client.$queryRawUnsafe<
        Record<string, unknown>[]
      >(`${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.status NOT IN ${TERMINAL_STATUSES}
        ORDER BY s.started_at DESC
      `);
      const sessions = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, sessions);
      return sessions;
    },
    async getHistoricalWithDetails(): Promise<SessionWithAgents[]> {
      if (historicalDetailsCache) {
        return historicalDetailsCache;
      }
      const rows = await prisma.client.$queryRawUnsafe<
        Record<string, unknown>[]
      >(`${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        WHERE s.status IN ${TERMINAL_STATUSES}
        ORDER BY s.started_at DESC
      `);
      historicalDetailsCache = detailRowsToList(rows);
      await attachEstimatedCosts(prisma, historicalDetailsCache);
      return historicalDetailsCache;
    },
    async getAllWithDetails(): Promise<SessionWithAgents[]> {
      return [
        ...(await this.getActiveWithDetails()),
        ...(await this.getHistoricalWithDetails()),
      ];
    },
    async getPage(request?: SessionPageRequest): Promise<SessionPage> {
      // Same single aggregate-join as the other detail reads, with the dynamic
      // status/search WHERE + LIMIT/OFFSET. Raw on the one client: the per-session
      // COUNT/SUM join is cheaper than per-table groupBy + JS, and the `q` search
      // needs `LIKE … ESCAPE` (Prisma `contains` does not escape `%`/`_`).
      const { limit, offset, status, q } = coercePageRequest(request);
      const { whereSql, params } = pageWhereClause(status, q);
      const totalResult = await prisma.client.$queryRawUnsafe<
        { count: bigint }[]
      >(`SELECT COUNT(*) as count FROM sessions s ${whereSql}`, ...params);
      const rows = await prisma.client.$queryRawUnsafe<
        Record<string, unknown>[]
      >(
        `${sessionDetailsCtes()}
        SELECT
          ${SESSION_DETAIL_SELECT_COLUMNS},
          COALESCE(ac.agent_count, 0) as agent_count,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(tt.total_tokens, '0') as total_tokens
        FROM sessions s
        LEFT JOIN agent_counts ac ON ac.session_id = s.id
        LEFT JOIN event_counts ec ON ec.session_id = s.id
        LEFT JOIN token_totals tt ON tt.session_id = s.id
        ${whereSql}
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
        ...params,
        limit,
        offset
      );
      const sessions = detailRowsToList(rows);
      // FEA-1459 Fix 10: Compute estimated cost per session from token_usage.
      await attachEstimatedCosts(prisma, sessions);
      return {
        sessions,
        total: Number(totalResult[0]?.count ?? 0),
        limit,
        offset,
      };
    },
    async getKanbanPages(
      statuses: string[],
      limit: number
    ): Promise<KanbanPages> {
      const result: KanbanPages = {};
      for (const status of statuses) {
        result[status] = await this.getPage({ limit, status });
      }
      return result;
    },
    invalidateHistoricalDetails(): void {
      historicalDetailsCache = null;
    },
    async handleSessionMutation(sessionId: string): Promise<void> {
      const session = await this.getById(sessionId);
      if (!session || TERMINAL_STATUS_SET.has(session.status)) {
        historicalDetailsCache = null;
      }
    },
  };
}

function coercePageRequest(request: SessionPageRequest | undefined): {
  limit: number;
  offset: number;
  status: string | null;
  q: string | null;
} {
  const requestedLimit = request?.limit;
  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_SESSION_PAGE_LIMIT)
      : DEFAULT_SESSION_PAGE_LIMIT;
  const requestedOffset = request?.offset;
  const offset =
    typeof requestedOffset === "number" && Number.isInteger(requestedOffset)
      ? Math.max(requestedOffset, 0)
      : 0;
  const status =
    typeof request?.status === "string" && request.status.length > 0
      ? request.status
      : null;
  const q =
    typeof request?.q === "string" && request.q.trim().length > 0
      ? request.q.trim()
      : null;
  return { limit, offset, status, q };
}

function pageWhereClause(
  status: string | null,
  q: string | null
): {
  whereSql: string;
  params: unknown[];
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status === DESKTOP_AGENT_STATUS.WAITING) {
    where.push(
      `s.status NOT IN ${TERMINAL_STATUSES} AND s.awaiting_input_since IS NOT NULL`
    );
  } else if (status === DESKTOP_AGENT_STATUS.RUNNING) {
    where.push(
      `s.status NOT IN ${TERMINAL_STATUSES} AND s.awaiting_input_since IS NULL`
    );
  } else if (status && status !== "all") {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  if (q) {
    const escaped = q.replace(/[%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    const start = params.length + 1;
    params.push(like, like, like, like);
    where.push(
      `(s.id LIKE $${start} ESCAPE '\\' OR s.name LIKE $${start + 1} ESCAPE '\\' OR s.cwd LIKE $${start + 2} ESCAPE '\\' OR s.model LIKE $${start + 3} ESCAPE '\\')`
    );
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

// Columns that make up an AgentRow, projected explicitly so the typed reads
// return exactly the AgentRow shape.
const AGENT_ROW_SELECT = {
  id: true,
  sessionId: true,
  name: true,
  type: true,
  subagentType: true,
  status: true,
  task: true,
  currentTool: true,
  startedAt: true,
  updatedAt: true,
  endedAt: true,
  awaitingInputSince: true,
  parentAgentId: true,
  metadata: true,
} satisfies Prisma.AgentSelect;

// FEA-1791 Phase 3: both agent reads run on typed Prisma delegates.
// getBySessionWithChildren builds its parent/child tree in memory from
// parentAgentId, so the old correlated `children_count` subquery was dead
// (never read) and is dropped.
function createSqliteAgentStore(
  prisma: DesktopPrisma,
  eventStore: ReturnType<typeof createSqliteEventStore>
) {
  return {
    async getBySession(sessionId: string): Promise<AgentRow[]> {
      return await prisma.client.agent.findMany({
        where: { sessionId },
        select: AGENT_ROW_SELECT,
        orderBy: { startedAt: "asc" },
      });
    },
    async getBySessionWithChildren(
      sessionId: string
    ): Promise<AgentHierarchyNode[]> {
      const allAgents = await prisma.client.agent.findMany({
        where: { sessionId },
        select: AGENT_ROW_SELECT,
        orderBy: { startedAt: "asc" },
      });
      const eventsByAgent = new Map<string, AgentHierarchyNode["events"]>();
      for (const e of await eventStore.getBySession(sessionId)) {
        if (!e.agentId) {
          continue;
        }
        const list = eventsByAgent.get(e.agentId) ?? [];
        list.push({
          eventType: e.eventType,
          toolName: e.toolName,
          summary: e.summary,
          createdAt: e.createdAt,
        });
        eventsByAgent.set(e.agentId, list);
      }

      const agentMap = new Map<string, AgentHierarchyNode>();
      const roots: AgentHierarchyNode[] = [];
      for (const agent of allAgents) {
        agentMap.set(agent.id, {
          agentId: agent.id,
          name: agent.name,
          type: agent.type,
          subagentType: agent.subagentType,
          status: agent.status,
          task: agent.task,
          currentTool: agent.currentTool,
          children: [],
          events: eventsByAgent.get(agent.id) ?? [],
        });
      }
      for (const agent of allAgents) {
        const node = agentMap.get(agent.id)!;
        if (agent.parentAgentId && agentMap.has(agent.parentAgentId)) {
          agentMap.get(agent.parentAgentId)!.children.push(node);
        } else {
          roots.push(node);
        }
      }
      return roots;
    },
  };
}

// The events columns that make up an EventRow, projected explicitly so a future
// schema column never silently leaks into the IPC payload via `...row`.
const EVENT_ROW_SELECT = {
  id: true,
  sessionId: true,
  agentId: true,
  eventType: true,
  toolName: true,
  summary: true,
  data: true,
  createdAt: true,
} satisfies Prisma.EventSelect;

// FEA-1791 Phase 3: the events store is read-only, so all five reads run on
// typed Prisma delegates. `events.session_id` has no FK/relation to `sessions`
// (events may arrive before their session row — see the Event model in
// schema.prisma), so the two session-name reads cannot use a relation `include`;
// they resolve the name with a separate typed query + an in-memory map, which
// preserves the old LEFT JOIN's "name is null when the session row is absent"
// semantics.
function createSqliteEventStore(prisma: DesktopPrisma) {
  return {
    async getBySession(sessionId: string): Promise<EventRow[]> {
      return await prisma.client.event.findMany({
        where: { sessionId },
        select: EVENT_ROW_SELECT,
        orderBy: { createdAt: "asc" },
      });
    },
    async getBySessionAndAgent(
      sessionId: string,
      agentId: string
    ): Promise<EventRow[]> {
      return await prisma.client.event.findMany({
        where: { sessionId, agentId },
        select: EVENT_ROW_SELECT,
        orderBy: { createdAt: "asc" },
      });
    },
    async getAll(): Promise<EventWithSession[]> {
      const rows = await prisma.client.event.findMany({
        select: EVENT_ROW_SELECT,
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
      const sessionRows =
        sessionIds.length === 0
          ? []
          : await prisma.client.session.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, name: true },
            });
      const nameById = new Map(
        sessionRows.map((row) => [row.id, row.name ?? null])
      );
      return rows.map((row) => ({
        ...row,
        sessionName: nameById.get(row.sessionId) ?? null,
      }));
    },
    async getWithSession(sessionId: string): Promise<EventWithSession[]> {
      const rows = await prisma.client.event.findMany({
        where: { sessionId },
        select: EVENT_ROW_SELECT,
        orderBy: { createdAt: "asc" },
      });
      // No events -> no rows to decorate; skip the session-name lookup, keeping
      // the empty case a single query (mirrors the guard in getAll()).
      if (rows.length === 0) {
        return [];
      }
      const sessionRow = await prisma.client.session.findUnique({
        where: { id: sessionId },
        select: { name: true },
      });
      const sessionName = sessionRow?.name ?? null;
      return rows.map((row) => ({ ...row, sessionName }));
    },
    async getCountByType(): Promise<EventCountByType[]> {
      // event_type is NOT NULL, so _count.eventType per group equals COUNT(*),
      // and ordering by it reproduces the raw `ORDER BY count DESC`.
      const grouped = await prisma.client.event.groupBy({
        by: ["eventType"],
        _count: { eventType: true },
        orderBy: { _count: { eventType: "desc" } },
      });
      return grouped.map((row) => ({
        eventType: row.eventType,
        count: row._count.eventType,
      }));
    },
  };
}

// FEA-1791 Phase 3: both methods run on the single Prisma client. `getBySession`
// is a typed delegate; `replace` keeps its hand-written `INSERT ... ON CONFLICT
// DO UPDATE` as RAW `$executeRawUnsafe` (named blocker: the update branch
// accumulates baselines `baseline_x = token_usage.x + EXCLUDED.x`, heals
// `created_at` downward via `MIN(...)`, and carries a conflict-target
// `WHERE usage_source != $15` guard — none expressible via Prisma `upsert`). It
// takes an optional `Prisma.TransactionClient` so the importer / lifecycle /
// sync paths run it inside their `$transaction`; called standalone it wraps the
// existing-row read + the upsert in its own atomic `prisma.write($transaction)`.
function createSqliteTokenUsageStore(prisma: DesktopPrisma) {
  return {
    async replace(
      sessionId: string,
      model: string,
      counts: TokenUsageCounts,
      now: string,
      tx?: Prisma.TransactionClient,
      /** FEA-1459 Fix 5: Explicit activity timestamp for created_at. */
      activityTs?: string
    ): Promise<void> {
      const storageCounts = normalizeTokenUsageCounts(counts, "token_usage");
      if (
        storageCounts.input === 0 &&
        storageCounts.output === 0 &&
        storageCounts.cacheRead === 0 &&
        storageCounts.cacheWrite === 0
      ) {
        return;
      }
      const createdAt = activityTs ?? now;
      // FEA-1459 (PR #1511 review): plain overwrite, NOT high-water-mark
      // accumulation. Both callers (boot importer + live-hook extractor)
      // re-derive FULL totals from the entire transcript on every call, and
      // Claude transcripts are append-only — so the latest derivation is
      // always authoritative. The old HWM upsert treated a shrinking raw_*
      // as a counter reset and ADDED the new value on top, which corrupted
      // upgraded installs: the v2 deduped (smaller) totals were stacked onto
      // the v1 inflated rows (input = old_inflated + new_deduped).
      // created_at heals downward via LEAST: boot passes the earliest real
      // activity timestamp, which must win over a previously stamped
      // import/hook time; hook calls pass `now`, which never wins.
      //
      // Gap 5 / compaction resilience: before overwriting, read the existing
      // row. If the new per-model totals are LOWER than the stored values, a
      // transcript compaction rewrote history. Roll the old totals into
      // baseline_* columns before applying the new (post-compaction) values so
      // effective_total = baseline + current remains correct.
      const run = async (itx: Prisma.TransactionClient): Promise<void> => {
        const existing = await itx.$queryRawUnsafe<
          {
            input_tokens: unknown;
            output_tokens: unknown;
            cache_read_tokens: unknown;
            cache_write_tokens: unknown;
          }[]
        >(
          `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM token_usage WHERE session_id = $1 AND model = $2`,
          sessionId,
          model
        );
        const existingRow = existing[0];
        const existingCounts = existingRow
          ? {
              input: tokenCountValue(
                existingRow.input_tokens,
                "token_usage.input_tokens"
              ),
              output: tokenCountValue(
                existingRow.output_tokens,
                "token_usage.output_tokens"
              ),
              cacheRead: tokenCountValue(
                existingRow.cache_read_tokens,
                "token_usage.cache_read_tokens"
              ),
              cacheWrite: tokenCountValue(
                existingRow.cache_write_tokens,
                "token_usage.cache_write_tokens"
              ),
            }
          : null;
        const baselineInput =
          existingCounts && storageCounts.input < existingCounts.input
            ? existingCounts.input
            : 0;
        const baselineOutput =
          existingCounts && storageCounts.output < existingCounts.output
            ? existingCounts.output
            : 0;
        const baselineCacheRead =
          existingCounts && storageCounts.cacheRead < existingCounts.cacheRead
            ? existingCounts.cacheRead
            : 0;
        const baselineCacheWrite =
          existingCounts && storageCounts.cacheWrite < existingCounts.cacheWrite
            ? existingCounts.cacheWrite
            : 0;

        await itx.$executeRawUnsafe(
          `
          INSERT INTO token_usage (
            session_id, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            raw_input, raw_output, raw_cache_read, raw_cache_write,
            baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
            usage_source, revision_id,
            created_at, updated_at, inferred
          )
          VALUES ($1, $2, $3, $4, $5, $6, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16)
          ON CONFLICT (session_id, model) DO UPDATE SET
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens,
            cache_write_tokens = EXCLUDED.cache_write_tokens,
            raw_input = EXCLUDED.raw_input,
            raw_output = EXCLUDED.raw_output,
            raw_cache_read = EXCLUDED.raw_cache_read,
            raw_cache_write = EXCLUDED.raw_cache_write,
            baseline_input = token_usage.baseline_input + EXCLUDED.baseline_input,
            baseline_output = token_usage.baseline_output + EXCLUDED.baseline_output,
            baseline_cache_read = token_usage.baseline_cache_read + EXCLUDED.baseline_cache_read,
            baseline_cache_write = token_usage.baseline_cache_write + EXCLUDED.baseline_cache_write,
            usage_source = EXCLUDED.usage_source,
            revision_id = EXCLUDED.revision_id,
            created_at = MIN(token_usage.created_at, EXCLUDED.created_at),
            updated_at = EXCLUDED.updated_at,
            inferred = EXCLUDED.inferred
          WHERE token_usage.usage_source != $15
        `,
          sessionId,
          model,
          storageCounts.input,
          storageCounts.output,
          storageCounts.cacheRead,
          storageCounts.cacheWrite,
          baselineInput,
          baselineOutput,
          baselineCacheRead,
          baselineCacheWrite,
          CodexOtelTokenUsageSource.JsonlParser,
          DATA_REVISION,
          createdAt,
          now,
          CodexOtelTokenUsageSource.OtelLogPayload,
          // FEA-2085: stamp guessed Codex attributions (SQLite boolean → 0/1).
          counts.inferred ? 1 : 0
        );
      };
      // Join the caller's importer / lifecycle / sync transaction when given one;
      // otherwise wrap the read + upsert in our own atomic write transaction.
      if (tx) {
        await run(tx);
        return;
      }
      await prisma.write((client) => client.$transaction((itx) => run(itx)));
    },
    async getBySession(sessionId: string): Promise<TokenUsageRow[]> {
      const rows = await prisma.client.tokenUsage.findMany({
        where: { sessionId },
        select: {
          sessionId: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          createdAt: true,
          costUsdEstimated: true,
        },
        orderBy: { model: "asc" },
      });
      // The token columns are BIGINT, so Prisma returns them as `bigint`;
      // toTokenUsageRow routes through readStorageTokenCount, which accepts
      // bigint and coerces to a JS-safe number (and preserves the shared cost
      // resolution). Marshal back to the snake_case shape the mapper expects.
      return rows.map((row) =>
        toTokenUsageRow({
          session_id: row.sessionId,
          model: row.model,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cache_read_tokens: row.cacheReadTokens,
          cache_write_tokens: row.cacheWriteTokens,
          created_at: row.createdAt,
          cost_usd_estimated: row.costUsdEstimated,
        })
      );
    },
  };
}

// FEA-1791 Phase 3: every dashboard read runs on the single `DesktopPrisma`
// client — typed delegates where there is a clean form, raw on
// `prisma.client.$queryRawUnsafe` for the aggregation/window/CTE SQL that has
// none. `getInsights` delegates to `computeLocalInsights(prisma, …)`.

// Single success-rate definition for the orchestration dashboard so the
// headline `stats.successRate` and every per-type `effectiveness[].successRate`
// agree: completed over finished (completed + errors), excluding in-flight
// agents from the denominator, defaulting to 100 when nothing has finished yet.
// Previously the per-type rate divided by the full agent count (including
// running/pending agents), so a type with in-flight work reported an
// artificially low rate that contradicted the headline.
function agentSuccessRate(completed: number, errors: number): number {
  const finished = completed + errors;
  return finished > 0 ? (completed / finished) * 100 : 100;
}

// Build a Prisma `status` filter from the shared status vocabulary so agent
// counts classify success/failure identically to the in-memory regexes.
function agentStatusContainsFilter(
  terms: readonly string[]
): { status: { contains: string } }[] {
  return terms.map((term) => ({ status: { contains: term } }));
}

// Build a case-insensitive SQLite predicate over `status` from the same shared
// vocabulary, for the raw aggregation that has no typed equivalent. Terms are
// static constants, so inlining them is injection-safe.
function agentStatusLikePredicate(terms: readonly string[]): string {
  return terms.map((term) => `lower(status) LIKE '%${term}%'`).join(" OR ");
}

function createSqliteDashboardQueries(prisma: DesktopPrisma) {
  return {
    async getSummary(): Promise<DashboardSummary> {
      const [
        totalSessions,
        activeSessions,
        totalAgents,
        totalEvents,
        distinctEventTypes,
        tokenTotals,
        recentSessions,
      ] = await Promise.all([
        prisma.client.session.count(),
        prisma.client.session.count({
          where: { status: { notIn: Array.from(TERMINAL_STATUS_SET) } },
        }),
        prisma.client.agent.count(),
        prisma.client.event.count(),
        // COUNT(DISTINCT event_type): event_type is NOT NULL, so one group per
        // distinct value means the group count equals the distinct count.
        prisma.client.event.groupBy({
          by: ["eventType"],
          _count: { _all: true },
        }),
        // SUM(input_tokens + output_tokens): the two model sums are validated
        // and added (the BigInt columns surface via the raw aggregate, coerced
        // to JS numbers at the token() boundary).
        prisma.client.tokenUsage.aggregate({
          _sum: { inputTokens: true, outputTokens: true },
        }),
        prisma.client.session.findMany({
          select: {
            id: true,
            name: true,
            status: true,
            model: true,
            cwd: true,
            startedAt: true,
          },
          orderBy: { startedAt: "desc" },
          take: 10,
        }),
      ]);
      return {
        totalSessions,
        activeSessions,
        totalAgents,
        totalEvents,
        eventTypeCount: distinctEventTypes.length,
        totalTokens:
          tokenCountValue(tokenTotals._sum.inputTokens, "summary.input") +
          tokenCountValue(tokenTotals._sum.outputTokens, "summary.output"),
        recentSessions: recentSessions.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          model: s.model,
          cwd: s.cwd,
          startedAt: s.startedAt,
        })),
      };
    },
    async getTokenAnalytics(): Promise<TokenAnalytics> {
      // COALESCE(SUM(x), 0): the typed aggregate returns `null` over an empty
      // table; token() maps the null (and any BigInt the raw aggregate surfaces)
      // to a JS number.
      const totals = await prisma.client.tokenUsage.aggregate({
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
        },
      });
      // COUNT(DISTINCT session_id) per model has no typed groupBy form (Prisma
      // _count is row count, not distinct) — stays raw on the one client.
      const byModel = await prisma.client.$queryRawUnsafe<
        {
          model: string;
          input_tokens: bigint;
          output_tokens: bigint;
          sessions: bigint;
        }[]
      >(`
        SELECT model,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          COUNT(DISTINCT session_id) as sessions
        FROM token_usage
        WHERE model IS NOT NULL
        GROUP BY model
        ORDER BY SUM(input_tokens + output_tokens) DESC
      `);
      // FEA-1459 Fix 5+6: Read from token_events (real activity timestamps).
      // SQLite stores created_at as ISO-8601 UTC TEXT; the day bucket is the
      // leading YYYY-MM-DD (UTC). The golden runs under TZ=UTC, so this UTC
      // bucketing matches the captured fixture. token_events is @@ignore'd (no
      // generated delegate), so the strftime day-bucket stays raw.
      const byDay = await prisma.client.$queryRawUnsafe<
        {
          day: string;
          input_tokens: bigint;
          output_tokens: bigint;
        }[]
      >(`
        SELECT substr(created_at, 1, 10) as day,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens
        FROM token_events
        WHERE created_at IS NOT NULL
        GROUP BY substr(created_at, 1, 10)
        ORDER BY day DESC
        LIMIT 30
      `);
      return {
        totalInputTokens: tokenCountValue(
          totals._sum.inputTokens,
          "analytics.input"
        ),
        totalOutputTokens: tokenCountValue(
          totals._sum.outputTokens,
          "analytics.output"
        ),
        totalCacheReadTokens: tokenCountValue(
          totals._sum.cacheReadTokens,
          "analytics.cache_read"
        ),
        totalCacheWriteTokens: tokenCountValue(
          totals._sum.cacheWriteTokens,
          "analytics.cache_write"
        ),
        byModel: byModel.map((r) => ({
          model: r.model,
          inputTokens: tokenCountValue(r.input_tokens, "analytics.model.input"),
          outputTokens: tokenCountValue(
            r.output_tokens,
            "analytics.model.output"
          ),
          sessions: Number(r.sessions ?? 0),
        })),
        byDay: byDay.map((r) => ({
          day: r.day,
          inputTokens: tokenCountValue(r.input_tokens, "analytics.day.input"),
          outputTokens: tokenCountValue(
            r.output_tokens,
            "analytics.day.output"
          ),
        })),
      };
    },
    getInsights(section: InsightsSection, period: InsightsPeriod, now?: Date) {
      return computeLocalInsights(prisma, section, period, now);
    },
    async getAnalytics(): Promise<AnalyticsData> {
      const [
        tokens,
        eventsByType,
        toolUsage,
        dailyEvents,
        sessionsByStatus,
        agentsByStatus,
        agentsByType,
        totalSessions,
        totalAgents,
        totalEvents,
      ] = await Promise.all([
        this.getTokenAnalytics(),
        // event_type is NOT NULL, so the typed groupBy's `_count._all`
        // reproduces COUNT(*); the SQL's ORDER BY count DESC is a JS sort.
        prisma.client.event.groupBy({
          by: ["eventType"],
          _count: { _all: true },
        }),
        // strftime relative-date windows have no typed-delegate form — raw.
        prisma.client.$queryRawUnsafe<{ tool_name: string; count: bigint }[]>(
          "SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 20"
        ),
        // FEA-1459 Fix 6: Bucket daily events by UTC day (ISO TEXT prefix).
        prisma.client.$queryRawUnsafe<{ date: string; count: bigint }[]>(
          "SELECT substr(created_at, 1, 10) as date, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days') GROUP BY substr(created_at, 1, 10) ORDER BY date ASC"
        ),
        prisma.client.session.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.client.agent.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.client.agent.groupBy({
          by: ["type"],
          _count: { _all: true },
        }),
        prisma.client.session.count(),
        prisma.client.agent.count(),
        prisma.client.event.count(),
      ]);
      return {
        tokens,
        eventsByType: [...eventsByType]
          .sort((a, b) => b._count._all - a._count._all)
          .map((r) => ({
            eventType: r.eventType,
            count: r._count._all,
          })),
        toolUsage: toolUsage.map((r) => ({
          toolName: r.tool_name,
          count: Number(r.count ?? 0),
        })),
        dailyEvents: dailyEvents.map((r) => ({
          date: r.date,
          count: Number(r.count ?? 0),
        })),
        sessionsByStatus: sessionsByStatus.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        agentsByStatus: agentsByStatus.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        // COALESCE(type, 'unknown') folds the NULL-type group to 'unknown'; the
        // SQL's ORDER BY count DESC is a JS sort.
        agentsByType: [...agentsByType]
          .sort((a, b) => b._count._all - a._count._all)
          .map((r) => ({
            type: r.type ?? "unknown",
            count: r._count._all,
          })),
        totalSessions,
        totalAgents,
        totalEvents,
      };
    },
    async getWorkflowData(): Promise<WorkflowQueryData> {
      const totalSessions = await prisma.client.session.count();
      const totalAgents = await prisma.client.agent.count();
      const totalSubagents = await prisma.client.agent.count({
        where: { OR: [{ type: "subagent" }, { parentAgentId: { not: null } }] },
      });
      // Classify by the shared status vocabulary (AGENT_*_STATUS_TERMS) so
      // successRate and effectiveness agree with the sessions view: statuses
      // like "success"/"complete"/"done" count as completed and "fail"/"error"
      // as errors, instead of only the exact strings "completed"/"failed".
      const completedAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_SUCCESS_STATUS_TERMS) },
      });
      const errorAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_FAILED_STATUS_TERMS) },
      });
      // Recursive depth CTE — no typed form; raw on the one client.
      const depthRows = await prisma.client.$queryRawUnsafe<
        {
          session_id: string;
          max_depth: bigint;
        }[]
      >(`
        WITH RECURSIVE agent_depth(id, session_id, depth) AS (
          SELECT id, session_id, 0 FROM agents WHERE parent_agent_id IS NULL
          UNION ALL
          SELECT a.id, a.session_id, ad.depth + 1
          FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
        )
        SELECT session_id, MAX(depth) as max_depth FROM agent_depth GROUP BY session_id
      `);
      // AVG(unixepoch(...)) date arithmetic — raw on the one client.
      const durationRow = await prisma.client.$queryRawUnsafe<
        { avg: number | null }[]
      >(`
        SELECT AVG(unixepoch(COALESCE(ended_at, updated_at), 'subsec') - unixepoch(started_at, 'subsec')) as avg
        FROM sessions WHERE started_at IS NOT NULL
          AND unixepoch(COALESCE(ended_at, updated_at), 'subsec') >= unixepoch(started_at, 'subsec')
      `);
      // GROUP BY over COALESCE(subagent_type, MAX(name)) plus conditional SUMs —
      // no typed groupBy form; raw on the one client. The status predicates are
      // derived from the same shared vocabulary as the typed counts above.
      const completedStatusPredicate = agentStatusLikePredicate(
        AGENT_SUCCESS_STATUS_TERMS
      );
      const errorStatusPredicate = agentStatusLikePredicate(
        AGENT_FAILED_STATUS_TERMS
      );
      const subagentTypes = await prisma.client.$queryRawUnsafe<
        {
          subagent_type: string;
          count: bigint;
          completed: bigint;
          errors: bigint;
        }[]
      >(`
        SELECT COALESCE(agents.subagent_type, COALESCE(MAX(agents.type), 'unknown')) as subagent_type,
          COUNT(*) as count,
          SUM(CASE WHEN (${completedStatusPredicate}) THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN (${errorStatusPredicate}) THEN 1 ELSE 0 END) as errors
        FROM agents WHERE parent_agent_id IS NOT NULL OR type = 'subagent'
        GROUP BY agents.subagent_type ORDER BY count DESC
      `);
      // parent_agent_id IS NULL AND (type IS NULL OR type != 'subagent'): the
      // explicit OR branch covers the NULL type regardless of how Prisma's `not`
      // treats nulls, so the union equals the original predicate exactly.
      const mainCount = await prisma.client.agent.count({
        where: {
          parentAgentId: null,
          OR: [{ type: null }, { type: { not: "subagent" } }],
        },
      });
      // GROUP BY over COALESCE(...) join keys — raw on the one client.
      const edges = await prisma.client.$queryRawUnsafe<
        {
          source: string;
          target: string;
          weight: bigint;
        }[]
      >(`
        SELECT COALESCE(p.subagent_type, COALESCE(MAX(p.name), 'main')) as source,
          COALESCE(c.subagent_type, COALESCE(MAX(c.name), 'unknown')) as target,
          COUNT(*) as weight
        FROM agents c JOIN agents p ON c.parent_agent_id = p.id
        GROUP BY p.subagent_type, c.subagent_type ORDER BY weight DESC LIMIT 50
      `);
      const outcomes = await prisma.client.session.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      // LEAD() window over the recent-tool sequence — raw on the one client.
      const toolTransitions = await prisma.client.$queryRawUnsafe<
        {
          source: string;
          target: string;
          value: bigint;
        }[]
      >(`
        WITH recent_tools AS (
          SELECT tool_name, session_id, created_at, id
          FROM events
          WHERE tool_name IS NOT NULL
            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
        ),
        tool_seq AS (
          SELECT tool_name,
            LEAD(tool_name) OVER (PARTITION BY session_id ORDER BY created_at, id) as next_tool
          FROM recent_tools
        )
        SELECT tool_name as source, next_tool as target, COUNT(*) as value
        FROM tool_seq
        WHERE next_tool IS NOT NULL
        GROUP BY source, target ORDER BY value DESC LIMIT 30
      `);
      // strftime relative-date window — raw on the one client.
      const toolCounts = await prisma.client.$queryRawUnsafe<
        { tool_name: string; count: bigint }[]
      >(
        "SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 20"
      );
      // COUNT(DISTINCT) self-join over the per-session agent-type set — raw on
      // the one client.
      const cooccurrence = await prisma.client.$queryRawUnsafe<
        {
          source: string;
          target: string;
          weight: bigint;
        }[]
      >(`
        WITH session_agent_types AS (
          SELECT DISTINCT session_id,
            COALESCE(subagent_type, name, 'unknown') AS agent_type
          FROM agents
        )
        SELECT t1.agent_type as source, t2.agent_type as target,
          COUNT(DISTINCT t1.session_id) as weight
        FROM session_agent_types t1
        JOIN session_agent_types t2
          ON t1.session_id = t2.session_id AND t1.agent_type < t2.agent_type
        GROUP BY t1.agent_type, t2.agent_type ORDER BY weight DESC LIMIT 30
      `);
      const avgDepth =
        depthRows.length > 0
          ? depthRows.reduce(
              (sum, row) => sum + Number(row.max_depth ?? 0),
              0
            ) / depthRows.length
          : 0;
      const successRate = agentSuccessRate(completedAgents, errorAgents);
      const mappedSubagentTypes = subagentTypes.map((row) => ({
        subagentType: row.subagent_type,
        count: Number(row.count ?? 0),
        completed: Number(row.completed ?? 0),
        errors: Number(row.errors ?? 0),
      }));
      return {
        stats: {
          totalSessions,
          totalAgents,
          totalSubagents,
          avgSubagents: totalSessions > 0 ? totalSubagents / totalSessions : 0,
          successRate,
          avgDepth,
          avgDurationSec: Number(durationRow[0]?.avg ?? 0),
          totalCompactions: 0,
          avgCompactions: 0,
          topFlow:
            toolTransitions.length > 0
              ? {
                  source: toolTransitions[0].source,
                  target: toolTransitions[0].target,
                  count: Number(toolTransitions[0].value ?? 0),
                }
              : null,
        },
        orchestration: {
          sessionCount: totalSessions,
          mainCount,
          subagentTypes: mappedSubagentTypes,
          edges: edges.map((r) => ({
            source: r.source,
            target: r.target,
            weight: Number(r.weight ?? 0),
          })),
          outcomes: outcomes.map((r) => ({
            status: r.status,
            count: r._count._all,
          })),
          compactions: { total: 0, sessions: 0 },
        },
        toolFlow: {
          transitions: toolTransitions.map((r) => ({
            source: r.source,
            target: r.target,
            value: Number(r.value ?? 0),
          })),
          toolCounts: toolCounts.map((r) => ({
            toolName: r.tool_name,
            count: Number(r.count ?? 0),
          })),
        },
        effectiveness: mappedSubagentTypes.map((st) => ({
          subagentType: st.subagentType,
          total: st.count,
          completed: st.completed,
          errors: st.errors,
          sessions: 0,
          successRate: agentSuccessRate(st.completed, st.errors),
          avgDuration: null,
          trend: [],
        })),
        cooccurrence: cooccurrence.map((r) => ({
          source: r.source,
          target: r.target,
          weight: Number(r.weight ?? 0),
        })),
      };
    },
    async getCoreFeatures(): Promise<DashboardCoreFeatures> {
      const [packs, skills, tools, subagents, plans, pullRequests] =
        await Promise.all([
          this.getPacks(),
          this.getSkills(),
          this.getTools(),
          this.getSubAgents(),
          this.getPlans(),
          this.getPullRequests(),
        ]);
      return { packs, skills, tools, subagents, plans, pullRequests };
    },
    async getPacks(): Promise<DashboardPackSummary[]> {
      const skills = await this.getSkills();
      const packs = new Map<string, DashboardPackSummary>();
      for (const skill of skills) {
        if (!skill.packId) {
          continue;
        }
        const existing = packs.get(skill.packId);
        if (existing) {
          existing.skillCount++;
          existing.toolCallCount += skill.invocationCount;
          existing.lastUsedAt = maxIso(existing.lastUsedAt, skill.lastUsedAt);
          continue;
        }
        packs.set(skill.packId, {
          id: skill.packId,
          name: titleFromId(skill.packId),
          harness: skill.harness,
          installPath: null,
          sourceUrl: null,
          version: null,
          skillCount: 1,
          toolCallCount: skill.invocationCount,
          lastUsedAt: skill.lastUsedAt,
        });
      }
      return [...packs.values()].sort(compareLastUsedThenName);
    },
    async getSkills(): Promise<DashboardSkillSummary[]> {
      // The Event model has NO Prisma relation to Session (events can predate
      // their session row), so the LEFT JOIN for the per-event harness is a
      // second keyed read folded into a map — a session absent from the lookup
      // yields a null harness, exactly like the outer join's NULL.
      const rows = await prisma.client.event.findMany({
        where: { toolName: "Skill" },
        select: {
          data: true,
          summary: true,
          createdAt: true,
          sessionId: true,
        },
        orderBy: { createdAt: "desc" },
      });
      const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
      const sessionHarnesses =
        sessionIds.length > 0
          ? await prisma.client.session.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, harness: true },
            })
          : [];
      const harnessBySessionId = new Map(
        sessionHarnesses.map((s) => [s.id, s.harness])
      );
      const grouped = new Map<string, DashboardSkillSummary>();
      for (const row of rows) {
        const data = parseJsonObjectText(row.data);
        const name =
          nonEmptyString(data?.skillName) ??
          nonEmptyString(data?.skill) ??
          nonEmptyString(data?.name) ??
          nonEmptyString(row.summary);
        if (!name) {
          continue;
        }
        const harness =
          nonEmptyString(harnessBySessionId.get(row.sessionId) ?? null) ??
          "unknown";
        const packId = packIdFromSkillName(name);
        const id = `${harness}:${packId ?? "standalone"}:${name}`;
        const existing = grouped.get(id);
        if (existing) {
          existing.invocationCount++;
          existing.lastUsedAt = maxIso(
            existing.lastUsedAt,
            row.createdAt ?? null
          );
          continue;
        }
        grouped.set(id, {
          id,
          packId,
          name,
          harness,
          description: nonEmptyString(data?.description) ?? null,
          installPath:
            nonEmptyString(data?.installPath) ??
            nonEmptyString(data?.path) ??
            null,
          invocationCount: 1,
          lastUsedAt: row.createdAt ?? null,
        });
      }
      return [...grouped.values()].sort(compareLastUsedThenName);
    },
    async getTools(): Promise<DashboardToolSummary[]> {
      // COUNT(DISTINCT session_id) + MAX(created_at) per tool — no typed groupBy
      // form (Prisma _count is row count, not distinct); raw on the one client.
      const result = await prisma.client.$queryRawUnsafe<
        {
          tool_name: string;
          invocation_count: bigint;
          session_count: bigint;
          last_used_at: string | null;
        }[]
      >(`
        SELECT tool_name,
          COUNT(*) as invocation_count,
          COUNT(DISTINCT session_id) as session_count,
          MAX(created_at) as last_used_at
        FROM events
        WHERE tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY invocation_count DESC, tool_name ASC
      `);
      return result.map((row) => ({
        toolName: row.tool_name,
        invocationCount: Number(row.invocation_count ?? 0),
        sessionCount: Number(row.session_count ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      }));
    },
    async getSubAgents(): Promise<DashboardSubAgentSummary[]> {
      // GROUP BY over COALESCE(subagent_type, MAX(type)) with conditional SUMs
      // and COUNT(DISTINCT session_id) — no typed groupBy form; raw on the one
      // client. The status predicates are derived from the same shared
      // vocabulary as getWorkflowData so success/failure classify identically.
      const completedStatusPredicate = agentStatusLikePredicate(
        AGENT_SUCCESS_STATUS_TERMS
      );
      const errorStatusPredicate = agentStatusLikePredicate(
        AGENT_FAILED_STATUS_TERMS
      );
      const result = await prisma.client.$queryRawUnsafe<
        {
          subagent_type: string;
          total: bigint;
          completed: bigint;
          errors: bigint;
          sessions: bigint;
          last_used_at: string | null;
        }[]
      >(`
        SELECT COALESCE(agents.subagent_type, COALESCE(MAX(agents.type), 'unknown')) as subagent_type,
          COUNT(*) as total,
          SUM(CASE WHEN (${completedStatusPredicate}) THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN (${errorStatusPredicate}) THEN 1 ELSE 0 END) as errors,
          COUNT(DISTINCT session_id) as sessions,
          MAX(updated_at) as last_used_at
        FROM agents
        WHERE parent_agent_id IS NOT NULL OR type = 'subagent'
        GROUP BY agents.subagent_type
        ORDER BY total DESC, subagent_type ASC
      `);
      return result.map((row) => ({
        subagentType: row.subagent_type,
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0),
        errors: Number(row.errors ?? 0),
        sessions: Number(row.sessions ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      }));
    },
    async getPlans(): Promise<DashboardPlanSummary[]> {
      const result = await prisma.client.session.findMany({
        where: { metadata: { not: null } },
        select: {
          id: true,
          cwd: true,
          harness: true,
          metadata: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });
      const plans: DashboardPlanSummary[] = [];
      const seen = new Set<string>();
      for (const session of result) {
        const metadata = parseJsonObjectText(session.metadata);
        const rawPlans = Array.isArray(metadata?.plans) ? metadata.plans : [];
        for (const [index, rawPlan] of rawPlans.entries()) {
          const plan = asRecord(rawPlan);
          const content = nonEmptyString(plan?.content);
          if (!content) {
            continue;
          }
          const timestamp =
            nonEmptyString(plan?.timestamp) ?? session.updatedAt ?? null;
          const id = `${session.id}:plan:${index}`;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          plans.push({
            id,
            sessionId: session.id,
            title: titleFromPlan(content),
            source: nonEmptyString(plan?.source) ?? null,
            content,
            timestamp,
            harness: session.harness,
            cwd: session.cwd,
          });
        }
      }
      return plans.sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp));
    },
    async getPullRequests(): Promise<DashboardPullRequestSummary[]> {
      // FEA-1899: PRs now live as kind='pull_request' rows in the canonical
      // artifacts table, joined to the sessions that captured them via the pure
      // session_artifact_links join. One row per PR artifact: when a PR links to
      // multiple sessions, DISTINCT ON keeps the strongest link (created >
      // primary > any) so the dashboard never double-counts a PR.
      // ROW_NUMBER() one-row-per-PR window + LEFT JOIN to pull_requests — no
      // typed-delegate form; raw on the one client. pr_number is INTEGER and the
      // raw path can surface it as BigInt, so it is Number()-coerced below.
      const result = await prisma.client.$queryRawUnsafe<
        {
          artifact_id: string;
          session_id: string | null;
          session_name: string | null;
          pr_url: string | null;
          pr_number: bigint | null;
          repo_full_name: string | null;
          branch_name: string | null;
          head_sha: string | null;
          title: string | null;
          harness: string | null;
          observed_at: string | null;
        }[]
      >(`
        SELECT
          ranked.artifact_id    AS artifact_id,
          ranked.session_id     AS session_id,
          ranked.session_name   AS session_name,
          ranked.pr_url         AS pr_url,
          ranked.pr_number      AS pr_number,
          ranked.repo_full_name AS repo_full_name,
          -- Branch is sourced from the AUTHORITATIVE pull_requests row of the
          -- winning link's session: the head ref for a PR that session created,
          -- or null for a merely-referenced PR. That column is import-authoritative
          -- and is deleted+re-derived per session on a DATA_REVISION rebuild, so it
          -- self-corrects on upgrade. The COALESCE-accumulated artifacts.branch_name
          -- can retain a stale pre-fix value a re-derive won't clear, so it is used
          -- ONLY as a fallback when no import row exists (e.g. a PR discovered purely
          -- by branch enrichment, which writes the real head to the artifact alone).
          CASE
            WHEN pr.session_id IS NOT NULL THEN pr.branch_name
            ELSE ranked.artifact_branch_name
          END                   AS branch_name,
          ranked.head_sha       AS head_sha,
          ranked.title          AS title,
          ranked.harness        AS harness,
          ranked.observed_at    AS observed_at
        FROM (
          SELECT
            a.id              AS artifact_id,
            sal.session_id    AS session_id,
            s.name            AS session_name,
            a.url             AS pr_url,
            a.pr_number       AS pr_number,
            a.repo_full_name  AS repo_full_name,
            a.branch_name     AS artifact_branch_name,
            a.head_sha        AS head_sha,
            a.title           AS title,
            a.harness         AS harness,
            a.observed_at     AS observed_at,
            ROW_NUMBER() OVER (
              PARTITION BY a.id
              ORDER BY
                CASE WHEN sal.relation = 'created' THEN 0 ELSE 1 END,
                CASE WHEN sal.is_primary THEN 0 ELSE 1 END,
                sal.created_at ASC
            ) AS rn
          FROM artifacts a
          JOIN session_artifact_links sal ON sal.artifact_id = a.id
          JOIN sessions s ON s.id = sal.session_id
          WHERE a.kind = 'pull_request'
            AND a.pr_number IS NOT NULL
            AND a.repo_full_name IS NOT NULL
        ) ranked
        LEFT JOIN pull_requests pr
          ON pr.session_id = ranked.session_id
          AND pr.repo_full_name = ranked.repo_full_name
          AND pr.pr_number = ranked.pr_number
        WHERE ranked.rn = 1
      `);
      const pullRequests: DashboardPullRequestSummary[] = [];
      for (const row of result) {
        const number = row.pr_number == null ? null : Number(row.pr_number);
        const repoFullName = row.repo_full_name;
        if (number == null || !repoFullName) {
          continue;
        }
        pullRequests.push({
          id: row.artifact_id,
          sessionId: row.session_id,
          sessionName: row.session_name,
          prUrl:
            row.pr_url ?? `https://github.com/${repoFullName}/pull/${number}`,
          prNumber: number,
          repoFullName,
          branchName: row.branch_name,
          headSha: row.head_sha,
          title: row.title,
          harness: row.harness,
          observedAt: row.observed_at,
        });
      }
      return pullRequests.sort((a, b) =>
        compareIsoDesc(a.observedAt, b.observedAt)
      );
    },
  };
}

function createSqliteLifecycle(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    emit?: (sessionId: string) => void;
    extractTranscript?: (path: string) => TranscriptExtract | null;
    getUserIdentity?: () => {
      userId: string | null;
      organizationId: string | null;
    } | null;
    log: (message: string) => void;
    now: () => string;
    staleMinutes?: number;
  }
) {
  const staleMinutes = deps.staleMinutes ?? 180;
  const extract = deps.extractTranscript ?? defaultTranscriptExtract;

  return {
    async processEvent(
      hookType: string,
      data: HookData,
      harness: string
    ): Promise<boolean> {
      const sessionId = data.session_id;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return false;
      }
      let transcript: TranscriptExtract | null = null;
      if (data.transcript_path) {
        try {
          transcript = extract(data.transcript_path);
        } catch (error) {
          if (error instanceof InvalidTokenCountError) {
            deps.log(
              `sqlite lifecycle: failed to process ${hookType}: ${error.message}`
            );
            return false;
          }
          transcript = null;
        }
      }
      const now = deps.now();
      let processed = false;
      // prisma.write serializes through the shared write queue and owns the
      // $transaction; no outer queue.run — nesting a queued op inside another
      // would deadlock the single-slot queue.
      try {
        await prisma.write((client) =>
          client.$transaction(async (tx) => {
            await handleHook(tx, {
              data,
              hookType,
              harness,
              now,
              sessionId,
              staleMinutes,
              tokenUsage,
              transcript,
              detectBillingMode: deps.detectBillingMode,
              getUserIdentity: deps.getUserIdentity,
            });
          })
        );
        processed = true;
      } catch (error) {
        deps.log(
          `sqlite lifecycle: failed to process ${hookType}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (processed) {
        try {
          deps.emit?.(sessionId);
        } catch {
          /* live-update push is best-effort */
        }
      }
      return processed;
    },
  };
}

async function handleHook(
  tx: Prisma.TransactionClient,
  options: {
    data: HookData;
    hookType: string;
    harness: string;
    now: string;
    sessionId: string;
    staleMinutes: number;
    tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
    transcript: TranscriptExtract | null;
    detectBillingMode: (harness: string) => string;
    getUserIdentity?: () => {
      userId: string | null;
      organizationId: string | null;
    } | null;
  }
): Promise<void> {
  const { data, hookType, harness, now, sessionId } = options;
  const main = mainAgentId(sessionId);
  await ensureSession(
    tx,
    sessionId,
    data,
    harness,
    now,
    options.detectBillingMode,
    options.getUserIdentity
  );
  const session = await getSession(tx, sessionId);
  if (!session) {
    return;
  }
  await maybeReactivate(tx, session, hookType, now);
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );

  switch (hookType) {
    case "SessionStart":
      await setMainWaiting(tx, sessionId, now);
      await sweepStaleSessions(tx, sessionId, now, options.staleMinutes);
      await insertEvent(
        tx,
        sessionId,
        main,
        "SessionStart",
        data,
        now,
        data.source === "resume" ? "Resumed session" : "Started session"
      );
      break;
    case "UserPromptSubmit":
      await clearAwaitingInput(tx, sessionId, now);
      await promoteMain(tx, main, now);
      await insertEvent(tx, sessionId, main, "UserPromptSubmit", data, now);
      break;
    case "PreToolUse":
      await clearAwaitingInput(tx, sessionId, now);
      if (data.tool_name === "Agent" || data.tool_name === "Task") {
        const agentId = await spawnSubagent(tx, sessionId, data, now);
        await insertEvent(
          tx,
          sessionId,
          agentId,
          "PreToolUse",
          data,
          now,
          "Spawned subagent"
        );
      } else {
        await setAgentTool(tx, main, data.tool_name ?? null, now);
        await insertEvent(tx, sessionId, main, "PreToolUse", data, now);
      }
      break;
    case "PostToolUse": {
      await clearAwaitingInput(tx, sessionId, now);
      const mainAgent = await getAgent(tx, main);
      if (mainAgent && mainAgent.status === DESKTOP_AGENT_STATUS.WORKING) {
        await setAgentTool(tx, main, null, now);
      }
      await insertEvent(tx, sessionId, main, "PostToolUse", data, now);
      break;
    }
    case "Stop":
      if (data.stop_reason === "error") {
        await setAgentStatus(tx, main, DESKTOP_AGENT_STATUS.ERROR, now);
        await setSessionStatus(
          tx,
          sessionId,
          DESKTOP_SESSION_STATUS.ERROR,
          now
        );
        await clearAwaitingInput(tx, sessionId, now);
      } else {
        await setMainWaiting(tx, sessionId, now);
      }
      await insertEvent(tx, sessionId, main, "Stop", data, now);
      break;
    case "SubagentStop": {
      const agentId = await matchSubagent(tx, sessionId, data);
      if (agentId) {
        await setAgentStatus(tx, agentId, DESKTOP_AGENT_STATUS.COMPLETED, now);
      }
      await insertEvent(tx, sessionId, agentId, "SubagentStop", data, now);
      // Gap 6: Best-effort subagent transcript scan. Derive the subagent
      // transcript path from the session transcript directory and agent ID.
      // Returns empty gracefully when no separate subagent file exists.
      if (agentId && data.transcript_path) {
        const subPath = path.join(
          path.dirname(data.transcript_path),
          `${agentId}.jsonl`
        );
        try {
          const subagentResult = await scanSubagentTranscriptStream(
            subPath,
            sessionId,
            agentId
          );
          for (const tu of subagentResult.toolUses) {
            if (tu.toolName && tu.timestamp) {
              let input: unknown | undefined;
              if (tu.input) {
                try {
                  input = JSON.parse(tu.input);
                } catch {
                  input = undefined;
                }
              }
              await insertEvent(
                tx,
                sessionId,
                agentId,
                "PostToolUse",
                { tool_name: tu.toolName, input } as HookData,
                tu.timestamp,
                tu.toolName
              );
            }
          }
        } catch {
          // Non-fatal — subagent transcript may not exist
        }
      }
      break;
    }
    case "Notification": {
      const message = strOf(data.message) ?? "";
      if (COMPACTION_RE.test(message)) {
        await insertEvent(
          tx,
          sessionId,
          main,
          "Compaction",
          data,
          now,
          "Context compaction"
        );
      } else if (WAITING_INPUT_RE.test(message)) {
        await setMainWaiting(tx, sessionId, now);
        await insertEvent(
          tx,
          sessionId,
          main,
          "Notification",
          data,
          now,
          message.slice(0, 200)
        );
      } else {
        await insertEvent(
          tx,
          sessionId,
          main,
          "Notification",
          data,
          now,
          message.slice(0, 200) || undefined
        );
      }
      break;
    }
    case "SessionEnd": {
      await clearAwaitingInput(tx, sessionId, now);
      const finalStatus =
        session.status === DESKTOP_SESSION_STATUS.ERROR
          ? DESKTOP_SESSION_STATUS.ERROR
          : DESKTOP_SESSION_STATUS.COMPLETED;
      await tx.$executeRawUnsafe(
        `UPDATE agents SET status = $1, ended_at = $2, updated_at = $2 WHERE session_id = $3 AND status NOT IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`,
        finalStatus === DESKTOP_SESSION_STATUS.ERROR
          ? DESKTOP_AGENT_STATUS.ERROR
          : DESKTOP_AGENT_STATUS.COMPLETED,
        now,
        sessionId
      );
      await setSessionStatus(tx, sessionId, finalStatus, now);
      await insertEvent(tx, sessionId, main, "SessionEnd", data, now);
      break;
    }
    default:
      await insertEvent(tx, sessionId, main, hookType, data, now);
      break;
  }

  if (options.transcript) {
    if (options.transcript.latestModel) {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET model = $1, updated_at = $2 WHERE id = $3 AND COALESCE(model, '') != $1",
        options.transcript.latestModel,
        now,
        sessionId
      );
    }
    for (const [model, counts] of options.transcript.tokensByModel) {
      await options.tokenUsage.replace(sessionId, model, counts, now, tx);
    }
    // FEA-1459 (PR #1511 review): the hook transcript only appends — subagent
    // merge (the one source of earlier-timestamped records) happens on the
    // boot path only — so append records past the session's high-water mark
    // instead of delete+reinserting the full set on every hook event. A
    // 1000-turn session would otherwise pay 1000+ inserts per PostToolUse on
    // the serialized write queue. An empty extract inserts nothing and never
    // wipes rows the boot importer derived.
    let appendedTokenEvents: TokenEventRecord[] = [];
    if (options.transcript.records.length > 0) {
      appendedTokenEvents = await appendTokenEvents(
        tx,
        sessionId,
        options.transcript.records
      );
    }
    if (appendedTokenEvents.length > 0) {
      const appendedTokenUsageModels = [
        ...new Set(appendedTokenEvents.map((event) => event.model)),
      ];
      await persistImportedTokenCosts(tx, {
        sessionId,
        harness,
        tokenUsageObservedAt: now,
        tokenUsageModels: appendedTokenUsageModels,
        tokenEvents: appendedTokenEvents,
        tokenEventObservedAtFallback: now,
      });
    }
  }

  // Perf: every hook path above inserts at least one event (created_at = `now`,
  // the new MAX) or sets a session floor; refresh the denormalized cursor sort
  // key once, after all event writes, so the Sessions list orders by the indexed
  // `last_activity_at` column without recomputing MAX(events.created_at) per page.
  await recomputeSessionLastActivityAt(tx, sessionId);
}

function createSqliteImporter(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    now: () => string;
    log: (message: string) => void;
    onPostImport?: (cwd: string | null) => void;
  }
): Importer {
  const attributionCache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  return {
    async importSession(
      session: NormalizedSession,
      harness: Harness
    ): Promise<ImportResult> {
      if (
        typeof session.sessionId !== "string" ||
        session.sessionId.length === 0 ||
        !session.startedAt
      ) {
        return { skipped: true, reactivated: false };
      }
      const now = deps.now();
      // FEA-1791 / PLN-886: each record group commits in its own isolated
      // transaction (see importSessionIsolated) — there is no single
      // import-wide transaction. Per-group failures are handled and tolerated
      // inside; this outer try/catch is a backstop for the pre-transaction
      // context build (filesystem reads for launch metadata).
      try {
        const result = await importSessionIsolated(
          prisma,
          tokenUsage,
          deps,
          session,
          harness,
          now,
          attributionCache
        );
        if (!result.skipped && deps.onPostImport) {
          deps.onPostImport(session.cwd ?? null);
        }
        return result;
      } catch (error) {
        deps.log(
          `sqlite importSession failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { skipped: true, reactivated: false, failed: true };
      }
    },
  };
}

/**
 * FEA-1899: upsert the canonical artifact (by identity_key) then insert the
 * pure-join session↔artifact link. The artifact upsert NEVER touches enrichment
 * columns (lines_*, enrichment_state, …) so re-imports don't wipe LOC; it only
 * COALESCE-fills identity fields and bumps last_seen_at. The link is rebuilt on
 * every reparse (delete-then-reinsert upstream) and re-points to the surviving
 * artifact row.
 */
export async function persistArtifactLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  refs: ArtifactRefRecord[],
  now: string
): Promise<number> {
  // Resolve bare repo names (directory basenames like "symphony-alpha") to
  // canonical owner/repo ("closedloop-ai/symphony-alpha") via the repos
  // registry. Without this, identity keys split by naming convention and
  // git_dir stays NULL (blocking all git/gh enrichment).
  const repoResolver = await buildRepoResolver(tx);

  let captured = 0;
  for (const ref of refs) {
    try {
      const resolved = repoResolver(ref.repoFullName ?? null);
      const resolvedRepoFullName =
        resolved?.repoFullName ?? ref.repoFullName ?? null;
      const resolvedGitDir = resolved?.gitDir ?? null;

      const identityKey = computeIdentityKey({
        kind: ref.targetKind as ArtifactKind,
        repoFullName: resolvedRepoFullName,
        gitDir: resolvedGitDir,
        sha: ref.sha ?? null,
        branchName: ref.branchName ?? null,
        prNumber: ref.prNumber ?? null,
        slug: ref.slug ?? null,
      });
      const candidateArtifactId = artifactIdFromIdentityKey(identityKey);
      const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, git_dir, sha, branch_name,
            pr_number, slug, url, title, committed_at, created_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at,
           repo_full_name = COALESCE(artifacts.repo_full_name, EXCLUDED.repo_full_name),
           git_dir = COALESCE(artifacts.git_dir, EXCLUDED.git_dir),
           url = COALESCE(artifacts.url, EXCLUDED.url),
           branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
           sha = COALESCE(artifacts.sha, EXCLUDED.sha),
           -- PRD-486: first non-null wins; the per-commit LOC enrichment may later
           -- overwrite committed_at with the exact git committer date directly.
           title = COALESCE(artifacts.title, EXCLUDED.title),
           committed_at = COALESCE(artifacts.committed_at, EXCLUDED.committed_at)
         WHERE artifacts.identity_key = EXCLUDED.identity_key
         RETURNING id`,
        candidateArtifactId,
        identityKey,
        ref.targetKind,
        resolvedRepoFullName,
        resolvedGitDir,
        ref.sha ?? null,
        ref.branchName ?? null,
        ref.prNumber ?? null,
        ref.slug ?? null,
        ref.prUrl ?? null,
        ref.message ?? null,
        ref.committedAt ?? null,
        now
      );
      const artifactId = requireArtifactUpsertId(
        artifactRows[0]?.id,
        candidateArtifactId,
        identityKey
      );
      const linkId = artifactLinkId(
        sessionId,
        ref.targetKind,
        canonicalKeyForRef(ref),
        ref.relation
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary,
            status, extractor_version, observed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(session_id, artifact_id, relation) DO UPDATE SET
           method = EXCLUDED.method,
           evidence = EXCLUDED.evidence,
           status = EXCLUDED.status,
           observed_at = EXCLUDED.observed_at,
           extractor_version = EXCLUDED.extractor_version`,
        linkId,
        sessionId,
        artifactId,
        ref.relation,
        ref.method,
        ref.evidence,
        ref.isPrimary,
        "candidate",
        ref.extractorVersion,
        ref.observedAt,
        now
      );
      captured++;
    } catch {
      // Row-level failure: log warning, continue processing other refs
    }
  }

  // Link propagation: if this session is linked to a branch that has a known
  // PR artifact, auto-link the session to the PR. Pure DB lookup — no gh calls.
  await propagateBranchPrLinks(tx, sessionId, now);

  return captured;
}

// PRD-486: an artifact upsert must return the row id; a missing id means the
// ON CONFLICT path raced or the identity key collided, which we surface rather
// than silently linking to a candidate id that was never persisted.
function requireArtifactUpsertId(
  returnedId: string | undefined,
  candidateId: string,
  identityKey: string
): string {
  if (returnedId) {
    return returnedId;
  }
  throw new Error(`artifact id collision for ${candidateId} (${identityKey})`);
}

async function propagateBranchPrLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  // Find open PR artifacts whose head branch matches a branch this session is
  // linked to, joining through pull_requests for the correct branch↔PR mapping.
  const prArtifacts = await tx.$queryRawUnsafe<
    { pr_id: string; identity_key: string }[]
  >(
    `SELECT DISTINCT pr_art.id AS pr_id, pr_art.identity_key
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
       AND COALESCE(pr_art.pr_state, 'open') NOT IN ('merged', 'closed')
     WHERE sal.session_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM session_artifact_links ex
         WHERE ex.session_id = $1 AND ex.artifact_id = pr_art.id
           AND ex.relation = 'workspace'
       )`,
    sessionId
  );

  for (const row of prArtifacts) {
    try {
      const linkId = artifactLinkId(
        sessionId,
        "pull_request",
        row.identity_key,
        "workspace"
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary,
            status, extractor_version, observed_at, created_at)
         VALUES ($1,$2,$3,'workspace','branch_pr_association','{}',0,
                 'candidate',1,$4,$4)
         ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
        linkId,
        sessionId,
        row.pr_id,
        now
      );
    } catch {
      // Non-critical — link will be retried on next import
    }
  }
}

type ResolvedRepo = { repoFullName: string; gitDir: string };

async function buildRepoResolver(
  tx: Prisma.TransactionClient
): Promise<(bareOrFull: string | null) => ResolvedRepo | null> {
  const rows = await tx.$queryRawUnsafe<
    {
      repo_full_name: string;
      git_dir: string;
    }[]
  >(
    "SELECT repo_full_name, git_dir FROM repos WHERE repo_full_name IS NOT NULL AND git_dir != ''"
  );

  // Index by exact full name and by bare trailing component (the repo dir name).
  // Bare-name collisions are theoretically possible (two orgs, same repo name);
  // the first match wins — good enough for desktop-local resolution.
  const byFull = new Map<string, ResolvedRepo>();
  const byBare = new Map<string, ResolvedRepo>();
  for (const row of rows) {
    const entry: ResolvedRepo = {
      repoFullName: row.repo_full_name,
      gitDir: row.git_dir,
    };
    byFull.set(row.repo_full_name, entry);
    // git_dir is like "/home/user/Workspace/symphony-alpha/.git"
    const dirName = row.git_dir
      .replace(/\/\.git\/?$/, "")
      .split("/")
      .at(-1);
    if (dirName) {
      byBare.set(dirName, entry);
    }
  }

  return (bareOrFull: string | null): ResolvedRepo | null => {
    if (!bareOrFull) {
      return null;
    }
    if (bareOrFull.includes("/")) {
      return byFull.get(bareOrFull) ?? null;
    }
    if (byBare.has(bareOrFull)) {
      return byBare.get(bareOrFull)!;
    }
    // Worktree suffix heuristic: strip -<type>-<identifier> patterns
    const suffixMatch = bareOrFull.match(
      /^(.+)[-_](?:fea|feat|fix|pr|pln|prd|wg-review|AI)[-_].+$/i
    );
    if (suffixMatch?.[1] && byBare.has(suffixMatch[1])) {
      return byBare.get(suffixMatch[1])!;
    }
    return null;
  };
}

/**
 * perf: conservative cap on bound parameters per chunked multi-row INSERT in the
 * import path. SQLite/libSQL default `SQLITE_MAX_VARIABLE_NUMBER` is 999 (older)
 * / 32766 (newer); staying near ~900 keeps each statement safe on every build
 * while still collapsing thousands of per-row round-trips into a handful.
 */
const EVENT_INSERT_PARAM_CAP = 900;

/**
 * FEA-1791 / PLN-886: pure, transaction-independent state derived once per
 * import and shared across the per-record phases below. None of these values
 * touch the database (they read the parsed session and, for artifact refs, the
 * filesystem), so deriving them up front lets each phase run in its own
 * isolated transaction (normal ingest, {@link importSessionIsolated}) — or all
 * on one shared transaction (rebuild, {@link importSessionWithTx}) — without
 * recomputing or holding a write connection open while deriving.
 */
type ImportSessionContext = {
  session: NormalizedSession;
  harness: Harness;
  now: string;
  recentlyActive: boolean;
  mainId: string;
  tokenSeries: NormalizedSession["tokenSeries"];
  earliestTokenTs: string | null;
  tokenEventsRecords: TokenEventRecord[];
  artifactRefs: ArtifactRefRecord[];
  createdPrHeadBranches: Map<string, string | null>;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
  detectBillingMode: (harness: string) => string;
};

function buildImportSessionContext(
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: { detectBillingMode: (harness: string) => string },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): ImportSessionContext {
  const nowMs = Date.parse(now);
  const recentlyActive =
    session.fileModifiedAt != null &&
    Number.isFinite(session.fileModifiedAt) &&
    (Number.isNaN(nowMs) ? Date.now() : nowMs) - session.fileModifiedAt <
      RECENT_ACTIVITY_MS;
  const mainId = mainAgentId(session.sessionId);
  // FEA-1459 Fix 5: earliest token timestamp drives created_at for token rows.
  const tokenSeries = session.tokenSeries ?? [];
  const earliestTokenTs =
    tokenSeries.length > 0
      ? tokenSeries.reduce(
          (min, r) => (r.timestamp < min ? r.timestamp : min),
          tokenSeries[0].timestamp
        )
      : session.startedAt;
  // FEA-1459 Fix C: if tokenSeries is empty but tokensByModel is not, synthesize
  // one fallback record per model (all four parsers populate tokenSeries today;
  // guard for safety). Mirrors the legacy in-transaction derivation exactly.
  const tokenEventsRecords: TokenEventRecord[] =
    tokenSeries.length > 0
      ? tokenSeries
      : Object.entries(session.tokensByModel ?? {}).map(([model, counts]) => ({
          timestamp: session.startedAt ?? now,
          model,
          input: counts.input,
          output: counts.output,
          cacheRead: counts.cacheRead,
          cacheWrite: counts.cacheWrite,
        }));
  // FEA-1684: artifact refs come from the transcript plus launch metadata
  // (.closedloop-ai/work/launch-metadata.json), which lives outside the
  // transcript. Both are filesystem/in-memory derivations — resolve them here,
  // before any transaction, so no write connection is held open while reading.
  const launchAttribution = resolveSessionAttribution(
    session.cwd,
    attributionCache
  );
  const launchRefs = extractLaunchMetadataRefs(
    launchAttribution?.sourceArtifactId
      ? { sourceArtifactId: launchAttribution.sourceArtifactId }
      : null,
    now
  );
  const artifactRefs = [...extractArtifactRefs(session, now), ...launchRefs];
  // A PR's head branch is only trustworthy for PRs this session CREATED (the
  // extractor stamps the branch active at `gh pr create` time). Map those to
  // their head branch; never let a later null clobber a known branch.
  const createdPrHeadBranches = new Map<string, string | null>();
  for (const ref of artifactRefs) {
    if (
      ref.targetKind !== "pull_request" ||
      ref.relation !== "created" ||
      !ref.repoFullName ||
      ref.prNumber == null
    ) {
      continue;
    }
    const key = `${ref.repoFullName}#${ref.prNumber}`;
    const branch = ref.branchName ?? null;
    if (
      !createdPrHeadBranches.has(key) ||
      (branch && !createdPrHeadBranches.get(key))
    ) {
      createdPrHeadBranches.set(key, branch);
    }
  }
  return {
    session,
    harness,
    now,
    recentlyActive,
    mainId,
    tokenSeries,
    earliestTokenTs,
    tokenEventsRecords,
    artifactRefs,
    createdPrHeadBranches,
    tokenUsage,
    detectBillingMode: deps.detectBillingMode,
  };
}

/**
 * Record group 1 (GATING): the session row and its main agent. Every other row
 * is an FK child of these, so the isolated orchestrator aborts the import if
 * this phase fails. Idempotent: existing sessions are COALESCE-updated and the
 * main agent is ON CONFLICT DO NOTHING, so a re-import never clobbers live state.
 */
async function importPhaseSessionAndMainAgent(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ existed: boolean; reactivated: boolean }> {
  const { session, harness, now, recentlyActive, mainId, detectBillingMode } =
    ctx;
  const existing = await getImportSession(tx, session.sessionId);
  let reactivated = false;

  if (existing) {
    const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
    await tx.$executeRawUnsafe(
      `UPDATE sessions SET
        name = COALESCE(name, $1),
        model = COALESCE(model, $2),
        cwd = COALESCE(cwd, $3),
        harness = CASE WHEN COALESCE(harness, '') = '' THEN $4 ELSE harness END,
        billing_mode = CASE WHEN COALESCE(billing_mode, '') IN ('', 'unknown') THEN $5 ELSE billing_mode END,
        metadata = $6,
        data_revision = $7,
        updated_at = $8
       WHERE id = $9`,
      session.name ?? null,
      session.model ?? null,
      session.cwd ?? null,
      harness,
      billingMode,
      buildImportMetadata(session, harness),
      DATA_REVISION,
      now,
      session.sessionId
    );
    const isLive =
      existing.status === DESKTOP_SESSION_STATUS.ACTIVE &&
      existing.ended_at == null;
    if (recentlyActive && !isLive) {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET status = 'active', ended_at = NULL, updated_at = $1 WHERE id = $2",
        now,
        session.sessionId
      );
      // Gap 7: Stamp awaiting_input_since so the dashboard Kanban board
      // places the session in the Waiting column (matches SessionStart
      // behavior in the live-hook path).
      await tx.$executeRawUnsafe(
        "UPDATE agents SET status = 'waiting', ended_at = NULL, current_tool = NULL, awaiting_input_since = $1, updated_at = $1 WHERE id = $2",
        now,
        mainId
      );
      reactivated = true;
    }
    // FEA-1785: Ensure the main agent row exists unconditionally. The rebuild
    // pass deletes all agents rows before re-importing, so a previously-imported
    // session may lack its main agent. ON CONFLICT DO NOTHING is safe when the
    // agent already exists (normal non-rebuild import path).
    // Status must reflect the session's POST-reactivation state: a rebuilt
    // terminal session inside the recent-activity window was just flipped to
    // 'active' above (and the agent UPDATE no-oped on the missing row), so the
    // recreated main agent must be 'waiting', not 'completed'.
    const sessionActiveNow = isLive || reactivated;
    const mainAgentTerminal =
      !sessionActiveNow && TERMINAL_STATUS_SET.has(existing.status);
    const agentStatus = mainAgentTerminal
      ? DESKTOP_AGENT_STATUS.COMPLETED
      : DESKTOP_AGENT_STATUS.WAITING;
    const agentEndedAt = mainAgentTerminal ? (existing.ended_at ?? now) : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      mainId,
      session.sessionId,
      agentStatus,
      session.startedAt,
      now,
      agentEndedAt
    );
  } else {
    const status = recentlyActive
      ? DESKTOP_SESSION_STATUS.ACTIVE
      : DESKTOP_SESSION_STATUS.COMPLETED;
    const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, ended_at, harness, billing_mode, metadata, data_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      session.sessionId,
      session.name ?? null,
      status,
      session.cwd ?? null,
      session.model ?? null,
      session.startedAt,
      session.endedAt ?? session.startedAt,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? (session.endedAt ?? null)
        : null,
      harness,
      billingMode,
      buildImportMetadata(session, harness),
      DATA_REVISION
    );
    // Gap 7: For recently-active sessions, stamp awaiting_input_since so the
    // dashboard Kanban board places the session in the Waiting column.
    const awaitingSince =
      recentlyActive && status !== DESKTOP_SESSION_STATUS.COMPLETED
        ? now
        : null;
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, awaiting_input_since, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, $7, NULL, NULL)`,
      mainId,
      session.sessionId,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? DESKTOP_AGENT_STATUS.COMPLETED
        : DESKTOP_AGENT_STATUS.WAITING,
      awaitingSince,
      session.startedAt,
      now,
      status === DESKTOP_SESSION_STATUS.COMPLETED
        ? (session.endedAt ?? now)
        : null
    );
  }

  return { existed: existing != null, reactivated };
}

/**
 * Record group 2: events (and the subagent agent rows interleaved with them).
 * A single atomic delete-then-reinsert: the FEA-1459 purge of import-derived
 * rows, the post-purge high-water-mark read, and the buffered chunked re-insert
 * all commit together so the events table is never observed mid-rewrite. This
 * is the perf-tuned phase — events are buffered and flushed in chunked multi-row
 * INSERTs rather than one round-trip per row.
 */
async function importPhaseEvents(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ inserted: number }> {
  const { session, now, mainId } = ctx;
  // FEA-1459 (PR #1511 review): purge import-derived rows before re-deriving,
  // so a forced reimport (PERSIST_VERSION bump, subagent-mtime change) cannot
  // stack new rows next to stale residue from the v1 pipeline (idx-keyed
  // subagent ids doubling agentCount, per-content-block Stop events inflating
  // heatmaps, 14k+ duplicate tool events).
  // - agents: the `-sub-` id infix is the subagent namespace shared by this
  //   importer and the live-hook spawner. Only terminal rows are purged:
  //   a status='working' hook row must survive so matchSubagent can resolve
  //   the upcoming SubagentStop. Any transient double (working hook row +
  //   completed import row for the same logical subagent) converges on the
  //   next reimport, which the finished subagent's transcript append
  //   guarantees.
  // - events: exactly the types this importer re-derives below. Hook-only
  //   types (Notification, SessionStart/End, UserPromptSubmit, ...) are
  //   untouched. The high-water-mark query below runs AFTER the purge, so the
  //   re-derived events insert with an empty HWM for these types.
  await tx.$executeRawUnsafe(
    `DELETE FROM agents WHERE session_id = $1 AND type = 'subagent'
       AND id LIKE '%-sub-%' AND status IN ('completed', 'error')`,
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM events WHERE session_id = $1 AND event_type IN
       ('Stop', 'PreToolUse', 'PostToolUse', 'TurnDuration', 'APIError', 'ToolError', 'Compaction')`,
    session.sessionId
  );

  const highWater = new Map<string, string>();
  const hwm = await tx.$queryRawUnsafe<
    { event_type: string; hwm: string | null }[]
  >(
    "SELECT event_type, MAX(created_at) AS hwm FROM events WHERE session_id = $1 GROUP BY event_type",
    session.sessionId
  );
  for (const row of hwm) {
    if (row.hwm) {
      highWater.set(row.event_type, row.hwm);
    }
  }

  let inserted = 0;
  // FEA-1459 Fix 7: Per-import dedup set to prevent exact (type, ts, toolName)
  // duplicates within a single import run (14,520 were duplicates before fix).
  const importEventSeen = new Set<string>();
  // perf: buffer per-event rows here and flush them in chunked multi-row
  // INSERTs (see flushEventBuffer) instead of one round-trip per event. A
  // large session can carry thousands of events; one INSERT per row inside the
  // transaction was the dominant import cost. Buffering preserves ordering,
  // columns, and the ON CONFLICT (id) DO NOTHING semantics exactly — the same
  // rows are written, just in fewer statements.
  const eventRowBuffer: [
    string, // id
    string, // session_id
    string, // agent_id
    string, // event_type
    string | null, // tool_name
    string | null, // summary
    string | null, // data
    string, // created_at
  ][] = [];
  const addEvent = (
    eventType: string,
    agentId: string,
    ts: string | null,
    toolName: string | null,
    summary: string | null,
    data: string | null,
    /** FEA-1459 Fix D: Optional discriminator for tool-use dedup (e.g. toolu_* id). */
    discriminator?: string
  ): void => {
    if (!ts) {
      return;
    }
    const prev = highWater.get(eventType);
    if (prev != null && ts <= prev) {
      return;
    }
    // FEA-1459 Fix 7+D: Skip within-import duplicates. Tool-use events include
    // a discriminator (tool_use id or array index) so two same-tool calls in
    // the same ms don't collapse.
    const dedupKey = buildEventDedupKey(eventType, ts, toolName, discriminator);
    if (importEventSeen.has(dedupKey)) {
      return;
    }
    importEventSeen.add(dedupKey);
    eventRowBuffer.push([
      deterministicEventId(
        session.sessionId,
        eventType,
        ts,
        toolName,
        discriminator
      ),
      session.sessionId,
      agentId,
      eventType,
      toolName,
      summary,
      data,
      ts,
    ]);
    inserted++;
  };
  // perf: write the buffered event rows in chunked multi-row INSERTs. Each row
  // binds 8 params; cap rows per statement so the bound-parameter count stays
  // well under the SQLite/libSQL variable limit. ON CONFLICT (id) DO NOTHING is
  // preserved, so a re-import that hits existing ids is still a no-op.
  const flushEventBuffer = async (): Promise<void> => {
    if (eventRowBuffer.length === 0) {
      return;
    }
    const columnCount = 8;
    const rowsPerChunk = Math.max(
      1,
      Math.floor(EVENT_INSERT_PARAM_CAP / columnCount)
    );
    for (let i = 0; i < eventRowBuffer.length; i += rowsPerChunk) {
      const chunk = eventRowBuffer.slice(i, i + rowsPerChunk);
      const params: unknown[] = [];
      const valueGroups: string[] = [];
      for (const row of chunk) {
        const base = params.length;
        valueGroups.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
        );
        params.push(...row);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ${valueGroups.join(", ")} ON CONFLICT (id) DO NOTHING`,
        ...params
      );
    }
    eventRowBuffer.length = 0;
  };

  for (const ts of session.messageTimestamps ?? []) {
    addEvent("Stop", mainId, ts, null, null, null);
  }
  for (const [idx, tu] of (session.toolUses ?? []).entries()) {
    if (tu.name === "Agent" || tu.name === "Task") {
      // FEA-1459 Fix 8: Use tool_use id (toolu_*) for stable subagent identity;
      // fall back to array index for parsers that don't populate it.
      const subId = `${session.sessionId}-sub-${tu.id ?? idx}`;
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const prompt = strOf(input.prompt);
      // FEA-1459 Fix 8: Use tool_result timestamp for ended_at (real duration).
      const endedAt =
        tu.resultTimestamp ?? tu.timestamp ?? session.endedAt ?? now;
      await tx.$executeRawUnsafe(
        `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, ended_at, parent_agent_id)
         VALUES ($1, $2, $3, 'subagent', $4, 'completed', $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        subId,
        session.sessionId,
        subagentName(tu),
        strOf(input.subagent_type) ?? null,
        prompt ? prompt.slice(0, 500) : null,
        tu.timestamp ?? session.startedAt,
        now,
        endedAt,
        mainId
      );
      // FEA-1459 Fix D: Include tool_use id in dedup key so two same-tool
      // calls in the same ms don't collapse.
      addEvent(
        "PreToolUse",
        subId,
        tu.timestamp,
        tu.name,
        "Spawned subagent",
        importToolEventData(tu),
        tu.id ?? String(idx)
      );
    } else {
      addEvent(
        "PostToolUse",
        mainId,
        tu.timestamp,
        tu.name,
        null,
        importToolEventData(tu),
        tu.id ?? String(idx)
      );
    }
  }
  for (const td of session.turnDurations ?? []) {
    addEvent(
      "TurnDuration",
      mainId,
      td.timestamp,
      null,
      String(td.durationMs),
      null
    );
  }
  for (const err of session.apiErrors ?? []) {
    addEvent(
      "APIError",
      mainId,
      err.timestamp,
      null,
      err.message ?? err.type ?? null,
      null
    );
  }
  for (const err of session.toolResultErrors ?? []) {
    addEvent(
      "ToolError",
      mainId,
      err.timestamp,
      null,
      truncate(err.content, 200),
      null
    );
  }
  // Gap 4: Create Compaction events from session.compactions. Each compaction
  // entry from the Claude parser carries a uuid and transcript timestamp.
  // Use the compaction timestamp (not wall clock) for event ordering.
  if (session.compactions?.length) {
    const compactions = session.compactions as Array<{
      uuid: string | null;
      timestamp: string | null;
    }>;
    for (const c of compactions) {
      if (c.timestamp) {
        addEvent(
          "Compaction",
          mainId,
          c.timestamp,
          null,
          "Context compaction",
          null
        );
      }
    }
  }
  // perf: flush all buffered event rows in chunked multi-row INSERTs before any
  // downstream read of the events table (e.g. upsertSessionAnalyticsRollup).
  await flushEventBuffer();
  return { inserted };
}

/**
 * Record group 3: token usage. Delete-then-reinsert the JSONL-parser-sourced
 * token_usage rows, then backfill session.model from tokensByModel when null.
 */
async function importPhaseTokenUsage(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, tokenUsage, earliestTokenTs, tokenSeries } = ctx;
  // FEA-1459 (PR #1511 review): delete+reinsert. The boot importer derives full
  // totals from the entire transcript every run, so the new derivation is
  // authoritative — and overwrite-by-model alone would leave stale rows behind
  // when a model key disappears under the new parser.
  await tx.$executeRawUnsafe(
    "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
    session.sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  for (const [model, counts] of Object.entries(session.tokensByModel ?? {})) {
    // FEA-1459 Fix 5: Pass activity timestamp instead of now() for created_at.
    await tokenUsage.replace(
      session.sessionId,
      model,
      counts,
      now,
      tx,
      earliestTokenTs ?? undefined
    );
  }
  // FEA-1459 Fix 9: Backfill session.model from tokensByModel when null.
  const modelKeys = Object.keys(session.tokensByModel ?? {});
  if (!session.model && modelKeys.length > 0) {
    const backfilledModel =
      modelKeys.length === 1
        ? modelKeys[0]
        : (tokenSeries.at(-1)?.model ?? modelKeys[0]);
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET model = $1, updated_at = $2 WHERE id = $3 AND model IS NULL",
      backfilledModel,
      now,
      session.sessionId
    );
  }
}

/**
 * Record group 4: token_events AND their derived cost estimates, in ONE
 * transaction. `persistImportedTokenCosts` annotates the just-inserted
 * token_events rows in place (`updateTokenEventCost` issues
 * `UPDATE token_events SET cost_*`), so the insert and the cost UPDATE are
 * write-coupled and MUST commit together: if they were separate isolated
 * transactions and the insert failed, the UPDATE would silently match zero rows
 * and commit "successfully", leaving cost columns permanently unpopulated.
 * Delete+reinsert is idempotent — the boot importer derives the full record set
 * every call.
 */
async function importPhaseTokenEventsAndCosts(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, harness, now, earliestTokenTs, tokenEventsRecords } = ctx;
  await replaceTokenEvents(tx, session.sessionId, tokenEventsRecords);
  await persistImportedTokenCosts(tx, {
    sessionId: session.sessionId,
    harness,
    tokenUsageObservedAt: earliestTokenTs ?? session.startedAt ?? now,
    tokenEvents: tokenEventsRecords,
    tokenEventObservedAtFallback: session.startedAt ?? now,
  });
}

/**
 * Record group 6: artifact links. Delete-then-reinsert the session↔artifact
 * join rows for consistency with the backfill path.
 */
async function importPhaseArtifactLinks(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedArtifactLinks: number }> {
  const { session, now, artifactRefs } = ctx;
  await tx.$executeRawUnsafe(
    "DELETE FROM session_artifact_links WHERE session_id = $1",
    session.sessionId
  );
  const capturedArtifactLinks = await persistArtifactLinks(
    tx,
    session.sessionId,
    artifactRefs,
    now
  );
  return { capturedArtifactLinks };
}

/**
 * Record group 7: pull requests. MUST run after the artifact-links phase — PR
 * artifacts create their own session_artifact_links rows, which that phase's
 * DELETE would otherwise wipe. Referenced (non-created) PRs get a null branch.
 */
async function importPhasePullRequests(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedPullRequests: number }> {
  const { session, harness, now, createdPrHeadBranches } = ctx;
  const capturedPullRequests = await persistNormalizedPullRequests(
    tx,
    session,
    harness,
    now,
    createdPrHeadBranches
  );
  return { capturedPullRequests };
}

/**
 * Record group 8: derived rollups. Recompute this session's analytics rollup
 * (FEA-2038) and refresh the denormalized last_activity_at cursor key. Both read
 * the events/token rows written by the phases above, so this runs last; both are
 * recompute-from-source and therefore idempotent.
 */
async function importPhaseDerivedRollups(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now } = ctx;
  await upsertSessionAnalyticsRollup(tx, session.sessionId, now);
  await recomputeSessionLastActivityAt(tx, session.sessionId);
}

/**
 * Run every import phase on a SINGLE caller-supplied transaction. Used by the
 * data-revision rebuild ({@link rebuildSessionFromParse}), which first tears the
 * session's derived rows down and must replace them atomically: a mid-rebuild
 * failure has to roll the whole teardown back rather than leave the session with
 * deleted-but-not-rebuilt data. The normal ingest path uses
 * {@link importSessionIsolated} instead, committing each phase independently.
 */
async function importSessionWithTx(
  tx: Prisma.TransactionClient,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
  },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache
  );
  const { existed, reactivated } = await importPhaseSessionAndMainAgent(
    tx,
    ctx
  );
  const { inserted } = await importPhaseEvents(tx, ctx);
  await importPhaseTokenUsage(tx, ctx);
  await importPhaseTokenEventsAndCosts(tx, ctx);
  const { capturedArtifactLinks } = await importPhaseArtifactLinks(tx, ctx);
  const { capturedPullRequests } = await importPhasePullRequests(tx, ctx);
  await importPhaseDerivedRollups(tx, ctx);
  return {
    skipped:
      existed &&
      inserted === 0 &&
      capturedPullRequests === 0 &&
      capturedArtifactLinks === 0 &&
      !reactivated,
    reactivated,
  };
}

/**
 * FEA-1791 / FEA-2027: validate every token counter the import would persist
 * BEFORE any record group commits, reusing the exact write-path normalizers so
 * the check can never drift from what the token groups enforce. Returns the
 * first {@link InvalidTokenCountError} found, or null when all counts are safe.
 *
 * Under the old single-transaction import, an unsafe counter (negative,
 * fractional, JS-unsafe) threw mid-import and rolled the WHOLE import back, so
 * nothing — not even a corrupt token_events row — was ever written. With
 * per-group commits a mid-import throw would instead leave the session and its
 * events committed while a corrupt count could still reach token_events. So the
 * isolated path detects the unsafe count up front and skips the whole session
 * (writing nothing), while the rest of the source still imports.
 */
function findUnsafeImportTokenCount(
  ctx: ImportSessionContext
): InvalidTokenCountError | null {
  try {
    for (const counts of Object.values(ctx.session.tokensByModel ?? {})) {
      normalizeTokenUsageCounts(counts, "token_usage");
    }
    for (const rec of ctx.tokenEventsRecords) {
      normalizeTokenEventRecord(rec, "token_events");
    }
    return null;
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      return error;
    }
    throw error;
  }
}

/**
 * FEA-1791 / PLN-886: run each import record group in its OWN isolated
 * transaction (through the shared write queue) instead of wrapping the whole
 * import in one transaction. This means: the import never holds a single write
 * connection open for its full duration; each group's rows become visible to the
 * dashboard as soon as that group commits; and one group failing (e.g. a
 * malformed PR) no longer discards the entire import.
 *
 * The session+main-agent group GATES the import — it is the FK parent for every
 * other row, so if it fails there is nothing to attach to and the import is
 * reported failed. Every later group is tolerant: its failure is logged and
 * skipped, and re-import converges because each group is an idempotent
 * delete-then-reinsert (or ON CONFLICT) unit.
 *
 * NOTE: each `prisma.write` below is a separate write-queue task, so this must
 * never be called from inside an outer `prisma.write`/`$transaction` (that would
 * deadlock the queue). The atomic, single-transaction rebuild path uses
 * {@link importSessionWithTx} instead.
 */
async function importSessionIsolated(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: {
    detectBillingMode: (harness: string) => string;
    log: (message: string) => void;
  },
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache
  );

  // FEA-2027: a session carrying a token counter that cannot be represented
  // exactly is skipped WHOLE — before any group commits — so no corrupt row
  // lands in token_usage OR token_events. Not a failure: the rest of the source
  // keeps importing (the old single-transaction import marked this failed,
  // which halted the source).
  const unsafeTokenCount = findUnsafeImportTokenCount(ctx);
  if (unsafeTokenCount) {
    deps.log(
      `sqlite import: skipping ${session.sessionId} — unsafe token count (${unsafeTokenCount.message}); nothing written`
    );
    return { skipped: true, reactivated: false };
  }

  // Gating group: the FK parent. If it fails, abort — there is nothing the later
  // groups could attach rows to.
  let gate: { existed: boolean; reactivated: boolean };
  try {
    gate = await prisma.write((client) =>
      client.$transaction((tx) => importPhaseSessionAndMainAgent(tx, ctx))
    );
  } catch (error) {
    deps.log(
      `sqlite import session/main-agent failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { skipped: true, reactivated: false, failed: true };
  }

  // Tolerant groups: each commits independently; a failure is logged and the
  // import continues. Returns the group's result, or null when it failed. A
  // failure flips `incomplete` so the caller re-imports the source next pass
  // (see the ImportResult.incomplete contract) rather than marking it seen and
  // permanently losing the failed group's rows.
  let incomplete = false;
  const runGroup = async <T>(
    label: string,
    group: (
      tx: Prisma.TransactionClient,
      ctx: ImportSessionContext
    ) => Promise<T>
  ): Promise<T | null> => {
    try {
      return await prisma.write((client) =>
        client.$transaction((tx) => group(tx, ctx))
      );
    } catch (error) {
      deps.log(
        `sqlite import ${label} failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      incomplete = true;
      return null;
    }
  };

  const events = await runGroup("events", importPhaseEvents);
  await runGroup("token_usage", importPhaseTokenUsage);
  // token_events + their cost annotations commit together (the cost UPDATE
  // mutates the just-inserted rows — see importPhaseTokenEventsAndCosts).
  await runGroup("token_events", importPhaseTokenEventsAndCosts);
  const links = await runGroup("artifact_links", importPhaseArtifactLinks);
  const prs = await runGroup("pull_requests", importPhasePullRequests);
  await runGroup("analytics_rollup", importPhaseDerivedRollups);

  const inserted = events?.inserted ?? 0;
  const capturedArtifactLinks = links?.capturedArtifactLinks ?? 0;
  const capturedPullRequests = prs?.capturedPullRequests ?? 0;
  return {
    skipped:
      gate.existed &&
      inserted === 0 &&
      capturedPullRequests === 0 &&
      capturedArtifactLinks === 0 &&
      !gate.reactivated,
    reactivated: gate.reactivated,
    // A tolerated group failure leaves the import partial: signal the collector
    // to re-import next pass (idempotent — committed groups converge) instead of
    // marking the source seen.
    incomplete: incomplete || undefined,
  };
}

/** Human-turn threshold for the session human/agent classification (mirrors
 * local-insights `HUMAN_TURN_THRESHOLD`). A session is "human" when it has >= this
 * many human (user/prompt) turns, else falls back to the transcript-metadata
 * `"human"` marker count. Kept in sync with local-insights by a guard test. */
const SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD = 2;

/**
 * FEA-2038: (re)compute the per-session analytics rollup for one session from its
 * events / token_usage rows and upsert it into `session_analytics` +
 * `session_tool_analytics`. All classification (human/agent turns, is_human,
 * error events) happens HERE, once, at ingest — mirroring the predicates the
 * dashboard insights used to run on every read. SQLite dialect.
 */
export async function upsertSessionAnalyticsRollup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  // The single-session rollup is the one-element case of the set-based batch.
  // Delegate so the (large) aggregate/classification SQL lives in ONE place and
  // the import-time path and the boot backfill can never drift apart.
  await upsertSessionAnalyticsRollupBatch(tx, [sessionId], now);
}

/** Max session ids per backfill transaction. Bounds the placeholder/parameter
 * count of the set-based upsert and keeps each commit (one fsync) modest while
 * still collapsing N per-session transactions into ⌈N/CHUNK⌉. */
const SESSION_ANALYTICS_BACKFILL_CHUNK = 500;

/**
 * FEA-2038: set-based (re)compute of the analytics rollups for an explicit set
 * of session ids, in ONE transaction. Mirrors `upsertSessionAnalyticsRollup`
 * exactly — same SELECT/aggregate/classification SQL — but scopes the outer
 * `sessions` scan and the inner aggregate sub-selects to `s.id IN (…)` (the
 * inner sub-selects already `GROUP BY session_id`, so restricting them to the
 * chunk just bounds the scan; the `JOIN`/`GROUP BY` then yield one rollup row
 * per session). Behavior-preserving: identical rollup rows/values, far fewer
 * commits.
 */
export async function upsertSessionAnalyticsRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const dayExpr = (col: string) =>
    `CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${col}, 1, 10) ELSE NULL END`;
  const t = SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD;
  // session_analytics upsert: $1 = now; the session ids occupy $2..$(N+1). The
  // IN list is repeated for the outer scan and each inner aggregate sub-select
  // so SQLite bounds every scan to the chunk; reusing the same numbered params
  // keeps a single bound array.
  const analyticsIdPlaceholders = sessionIds
    .map((_, i) => `$${i + 2}`)
    .join(", ");
  const analyticsParams: unknown[] = [now, ...sessionIds];
  // The tool-analytics DELETE + INSERT bind `sessionIds` alone, so their IN list
  // starts at $1 (no `now` param).
  const toolIdPlaceholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `INSERT OR REPLACE INTO session_analytics (
       session_id, started_at, started_day, status, harness,
       human_turns, agent_turns, is_human, event_count, tool_invocations, error_events,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost,
       runtime_ms, updated_at
     )
     SELECT
       s.id,
       s.started_at,
       ${dayExpr("s.started_at")},
       s.status,
       s.harness,
       COALESCE(ht.human_turns, 0),
       COALESCE(ev.agent_turns, 0),
       CASE
         WHEN COALESCE(ht.human_turns, 0) > 0
           THEN (CASE WHEN COALESCE(ht.human_turns, 0) >= ${t} THEN 1 ELSE 0 END)
         ELSE (CASE WHEN COALESCE(
                 (LENGTH(s.metadata) - LENGTH(REPLACE(LOWER(s.metadata), '"human"', ''))) / 7,
                 0) >= ${t} THEN 1 ELSE 0 END)
       END,
       COALESCE(ev.event_count, 0),
       COALESCE(ev.tool_invocations, 0),
       COALESCE(ev.error_events, 0),
       COALESCE(tok.input_tokens, 0),
       COALESCE(tok.output_tokens, 0),
       COALESCE(tok.cache_read_tokens, 0),
       COALESCE(tok.cache_write_tokens, 0),
       COALESCE(tok.est_cost, 0),
       CASE
         WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL AND s.ended_at > s.started_at
           THEN CAST((unixepoch(s.ended_at, 'subsec') - unixepoch(s.started_at, 'subsec')) * 1000 AS INTEGER)
         ELSE NULL
       END,
       $1
     FROM sessions s
     LEFT JOIN (
       SELECT session_id,
         COUNT(*) AS event_count,
         SUM(CASE WHEN tool_name IS NOT NULL THEN 1 ELSE 0 END) AS tool_invocations,
         SUM(CASE WHEN lower(event_type) LIKE '%assistant%' THEN 1 ELSE 0 END) AS agent_turns,
         SUM(CASE WHEN (lower(event_type) LIKE '%error%' OR lower(event_type) LIKE '%fail%') THEN 1 ELSE 0 END) AS error_events
       FROM events WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) ev ON ev.session_id = s.id
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS human_turns
       FROM events
       WHERE session_id IN (${analyticsIdPlaceholders})
         AND (lower(event_type) LIKE '%user%' OR lower(event_type) LIKE '%prompt%')
       GROUP BY session_id
     ) ht ON ht.session_id = s.id
     LEFT JOIN (
       SELECT session_id,
         SUM(COALESCE(input_tokens, 0)) AS input_tokens,
         SUM(COALESCE(output_tokens, 0)) AS output_tokens,
         SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
         SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
         SUM(COALESCE(cost_usd_estimated, 0)) AS est_cost
       FROM token_usage WHERE session_id IN (${analyticsIdPlaceholders}) GROUP BY session_id
     ) tok ON tok.session_id = s.id
     WHERE s.id IN (${analyticsIdPlaceholders})`,
    ...analyticsParams
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM session_tool_analytics WHERE session_id IN (${toolIdPlaceholders})`,
    ...sessionIds
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO session_tool_analytics (session_id, tool_name, invocations, started_day)
     SELECT e.session_id, e.tool_name, COUNT(*),
       (SELECT ${dayExpr("s.started_at")} FROM sessions s WHERE s.id = e.session_id)
     FROM events e
     WHERE e.session_id IN (${toolIdPlaceholders}) AND e.tool_name IS NOT NULL
     GROUP BY e.session_id, e.tool_name`,
    ...sessionIds
  );
}

/**
 * FEA-2038: one-time/idempotent backfill of the analytics rollups for every
 * session that lacks a `session_analytics` row (e.g. existing stores upgrading to
 * 0004, or any session imported before this code). Runs after migrations at db
 * open. Set-based: collapses the former N per-session transactions into
 * ⌈missing/CHUNK⌉ chunked transactions via `upsertSessionAnalyticsRollupBatch`,
 * which mirrors the per-session rollup SQL exactly. A failed chunk is logged and
 * skipped; remaining chunks still run.
 */
export async function backfillSessionAnalytics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = SESSION_ANALYTICS_BACKFILL_CHUNK
): Promise<void> {
  // Anti-join (sessions without a session_analytics row) — raw read on the one
  // client.
  const missing = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT s.id FROM sessions s
     LEFT JOIN session_analytics sa ON sa.session_id = s.id
     WHERE sa.session_id IS NULL`
  );
  if (missing.length === 0) {
    return;
  }
  const ids = missing.map((row) => row.id);
  const now = new Date().toISOString();
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  let done = 0;
  for (let start = 0; start < ids.length; start += safeChunkSize) {
    const chunk = ids.slice(start, start + safeChunkSize);
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollupBatch(tx, chunk, now)
        )
      );
      done += chunk.length;
    } catch (error) {
      log(
        `session-analytics backfill failed for chunk [${start}, ${start + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`session-analytics backfill complete: ${done}/${ids.length}`);
}

function createSqliteSessionSyncSource(
  db: SqliteClient,
  prisma: DesktopPrisma
): AgentSessionSyncSource {
  return {
    async listAllSessionCursorRows(): Promise<SessionCursorRow[]> {
      const result = await db.query<SessionCursorRow>(`
        SELECT id, updated_at
        FROM sessions
        ORDER BY updated_at DESC, id DESC
      `);
      return result.rows;
    },
    async listSessionCursorPage(
      request: SessionListCursorPageRequest
    ): Promise<SessionListCursorPage> {
      // FEA-2036 (SQLite): the PGlite-era storage-corruption recovery wrapper was
      // dropped in the SQLite migration; libSQL surfaces its own errors and the
      // db-host auto-restarts, so the read runs directly.
      return listSqliteSessionCursorPage(db, request);
    },
    async listTopSessionCursorRows(): Promise<SessionCursorRow[]> {
      const result = await db.query<SessionCursorRow>(`
        WITH top_cursor AS (
          SELECT updated_at
          FROM sessions
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        )
        SELECT id, updated_at
        FROM sessions
        WHERE updated_at = (SELECT updated_at FROM top_cursor)
        ORDER BY updated_at DESC, id DESC
      `);
      return result.rows;
    },
    async listUpdatedSessionCursorRows(
      sinceUpdatedAt: string
    ): Promise<SessionCursorRow[]> {
      const result = await db.query<SessionCursorRow>(
        `
          SELECT id, updated_at
          FROM sessions
          WHERE updated_at >= $1
          ORDER BY updated_at DESC, id DESC
        `,
        [sinceUpdatedAt]
      );
      return result.rows;
    },
    async loadSyncedSessions(
      ids: string[],
      cache: SessionAttributionResolverCache,
      options?: { omitEventData?: boolean }
    ): Promise<SyncedAgentSession[]> {
      return loadSqliteSyncedSessions(db, ids, cache, options);
    },
    async findLocallyOversizedSessions(
      ids: string[],
      maxBytes: number
    ): Promise<{ id: string; payloadBytes: number }[]> {
      return findSqliteLocallyOversizedSessions(db, ids, maxBytes);
    },
    async findLocallyUnhydratableSessions(
      ids: string[],
      maxBytes: number
    ): Promise<{ id: string; payloadBytes: number }[]> {
      return findSqliteUnhydratableSessions(db, ids, maxBytes);
    },
    /**
     * FEA-1834: lightweight load for the usage summary — session metadata +
     * tokenUsageByModel only (no agents/events/token_events/artifact_links/
     * attribution). Folds identically in `buildUsageSummary`; far cheaper to
     * re-run on the live cadence as the corpus grows.
     */
    async loadUsageSessions(ids: string[]): Promise<SyncedAgentSession[]> {
      return loadSqliteUsageSessions(db, ids);
    },
    /**
     * FEA-1834 / PLN-941 §4: O(grouped) usage aggregation. Two grouped queries
     * (token SUM/COUNT by billing_mode/harness/model + per-harness session
     * counts) replace hydrating every session, so the summary stays cheap on the
     * live cadence as the corpus grows. The fold lives in
     * `getSharedAgentSessionUsage`.
     */
    aggregateUsage(
      filters: AgentSessionUsageAggregateFilters
    ): Promise<AgentSessionUsageAggregate> {
      return aggregateSqliteUsage(db, filters);
    },
    /**
     * FEA-2038: O(grouped) analytics aggregation. Three grouped reads in one
     * transaction (byTool over events, byAgentType over agents, byRepository
     * over per-cwd token/error rollups) replace hydrating the whole filtered
     * corpus into JS — the db-host OOM (exit code 5). The cwd→repositoryFullName
     * resolution and final fold live in `getSharedAgentSessionAnalytics`; the
     * shared `cache` keeps attribution lookups consistent with the read request.
     */
    async aggregateAnalytics(
      filters: AgentSessionUsageAggregateFilters,
      cache: SessionAttributionResolverCache
    ): Promise<AgentSessionAnalyticsAggregate> {
      try {
        return await aggregateSqliteAnalytics(db, filters, cache);
      } catch {
        // Degrade to the empty aggregate rather than failing the analytics read
        // (e.g. transient storage corruption recovered on the next refresh).
        return emptyAgentSessionAnalyticsAggregate();
      }
    },
    /**
     * FEA-1962: load the durable cursor for `sourceKey` via the typed
     * `SyncState` delegate (FEA-1791 single-client pattern). The `Json` ids
     * column comes back pre-parsed; a malformed value degrades to `[]` (full
     * re-discovery) rather than throwing. Absent row → `null` (full backfill).
     * A cursor stamped under a DIFFERENT `DATA_REVISION` is also treated as
     * absent: the local rows have since been re-derived, so the cloud must
     * receive the rebuilt rows — one full re-backfill, then the new revision is
     * stamped. This preserves the pre-FEA-1962 behavior where a revision bump
     * pushed re-derived rows to the cloud (but once, not on every restart).
     */
    async loadSyncState(sourceKey: string): Promise<PersistedSyncState | null> {
      const row = await prisma.client.syncState.findUnique({
        where: { sourceKey },
      });
      if (!row || row.dataRevision !== DATA_REVISION) {
        return null;
      }
      return {
        observedTopUpdatedAt: row.observedTopUpdatedAt ?? null,
        observedIdsAtTopUpdatedAt: parsePersistedObservedIds(
          row.observedIdsAtTopUpdatedAt
        ),
      };
    },
    /**
     * FEA-1962: upsert the durable cursor via the typed `SyncState` delegate,
     * stamping the current DATA_REVISION. Routed through `prisma.write` so the
     * write serializes on the same single-connection queue as every other
     * SQLite write (FEA-1791); the `Json` ids column takes the JS array
     * directly — the delegate serializes it.
     */
    async advanceSyncState(
      sourceKey: string,
      state: PersistedSyncState
    ): Promise<void> {
      const updatedAt = new Date().toISOString();
      await prisma.write((client) =>
        client.syncState.upsert({
          where: { sourceKey },
          create: {
            sourceKey,
            observedTopUpdatedAt: state.observedTopUpdatedAt,
            observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
            dataRevision: DATA_REVISION,
            updatedAt,
          },
          update: {
            observedTopUpdatedAt: state.observedTopUpdatedAt,
            observedIdsAtTopUpdatedAt: state.observedIdsAtTopUpdatedAt,
            dataRevision: DATA_REVISION,
            updatedAt,
          },
        })
      );
    },
  };
}

const HIGH_CONFIDENCE_BRANCH_METHOD_VALUES = [
  "git_worktree_add",
  "git_checkout",
  "git_push",
  "git_commit",
  "gh_pr_create",
] as const;

/**
 * Lightweight page cursor for the renderer Sessions list. The default desktop
 * list sort is genuine activity, which is derivable from `events.created_at`
 * plus the session start floor; computing that in SQL lets the list hydrate
 * only the visible page instead of every local session.
 */
async function listSqliteSessionCursorPage(
  db: SqliteClient,
  request: SessionListCursorPageRequest
): Promise<SessionListCursorPage> {
  const direction = request.sortDir === "asc" ? "ASC" : "DESC";
  const tieDirection = request.sortDir === "asc" ? "ASC" : "DESC";
  const { clause, params } = buildListCursorFilterClause(request);
  // Perf: the last-activity sort reads the denormalized `last_activity_at`
  // column (maintained at ingest by `recomputeSessionLastActivityAt` / the
  // migration backfill) instead of recomputing `MAX(events.created_at)` via a
  // whole-table LEFT JOIN + GROUP BY on every page. The stored value IS exactly
  // the old `COALESCE(MAX(<guarded events.created_at>), <guarded started_at
  // floor>)`, so the ordering and rows are identical. The column is NOT NULL
  // (epoch-floor default, see migration 0005), so the read can ORDER BY the bare
  // column directly — letting `idx_sessions_last_activity` satisfy the sort
  // instead of forcing a temp-b-tree filesort, which a COALESCE wrapper would.
  // The `Started` sort uses the inline started-at floor (sessions-only, no
  // events join either way).
  const sortExpression =
    request.sortBy === SessionListCursorSortKey.Started
      ? "sort_started_at"
      : "sort_last_activity_at";
  const pageParams = [...params, request.limit, request.offset];
  const limitPlaceholder = `$${params.length + 1}`;
  const offsetPlaceholder = `$${params.length + 2}`;
  const [countResult, pageResult] = await Promise.all([
    db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sessions s ${clause}`,
      params
    ),
    db.query<SessionCursorRow>(
      `
        WITH activity AS (
          SELECT
            s.id,
            s.updated_at,
            ${SESSION_STARTED_AT_SORT_EXPRESSION} AS sort_started_at,
            s.last_activity_at AS sort_last_activity_at
          FROM sessions s
          ${clause}
        )
        SELECT id, updated_at
        FROM activity
        ORDER BY ${sortExpression} ${direction}, id ${tieDirection}
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `,
      pageParams
    ),
  ]);
  return {
    rows: pageResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/**
 * SQL-side mirror of the cheap Sessions-list filters. This keeps the default
 * 7-day view and sidebar search on the cursor-page path, so only visible rows
 * are hydrated after SQLite has found the matching IDs.
 */
function buildListCursorFilterClause(request: SessionListCursorPageRequest): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;
  const startedAtTs = SESSION_STARTED_AT_TS_EXPR;

  if (request.startDate) {
    conditions.push(`${startedAtTs} >= ${placeholder()}`);
    params.push(request.startDate.toISOString());
  }
  if (request.endDate) {
    conditions.push(`${startedAtTs} <= ${placeholder()}`);
    params.push(request.endDate.toISOString());
  }
  if (request.search) {
    const searchPlaceholder = placeholder();
    params.push(`%${escapeSqliteLikePattern(request.search.toLowerCase())}%`);
    const branchMethodPlaceholders = HIGH_CONFIDENCE_BRANCH_METHOD_VALUES.map(
      (method) => {
        const methodPlaceholder = placeholder();
        params.push(method);
        return methodPlaceholder;
      }
    );

    conditions.push(`
      (
        LOWER(COALESCE(s.name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(s.id) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.harness, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(s.cwd, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR LOWER(COALESCE(
          CASE
            WHEN s.metadata IS NOT NULL AND json_valid(s.metadata)
              THEN json_extract(s.metadata, '$.gitBranch')
            ELSE NULL
          END,
          ''
        )) LIKE ${searchPlaceholder} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM session_artifact_links sal
          JOIN artifacts a ON a.id = sal.artifact_id
          WHERE sal.session_id = s.id
            AND (
              LOWER(COALESCE(a.repo_full_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              OR (
                a.kind = 'branch'
                AND sal.method IN (${branchMethodPlaceholders.join(", ")})
                AND LOWER(COALESCE(a.branch_name, '')) LIKE ${searchPlaceholder} ESCAPE '\\'
              )
            )
        )
      )
    `);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function escapeSqliteLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Build the shared `WHERE` clause for the usage aggregation, mirroring
 * `matchesQuery`/`matchesStatusFilter`/`canonicalSharedStatus` exactly so the
 * SQL-filtered corpus matches the JS hydrate path:
 * - `harness` — equality on the raw column.
 * - `startDate`/`endDate` — inclusive range on `started_at` (cast to timestamptz
 *   to match `parseSessionDate`'s `new Date(...)` ordering; `>=` / `<=` mirror
 *   the strict `<` / `>` exclusions in `matchesQuery`).
 * - `status` — canonicalize (`error→failed`, `running→active`, else lowercase),
 *   then `waiting` = awaiting-input, `active` = canonical active and not
 *   awaiting, anything else = canonical equality. "Awaiting" is a non-terminal
 *   canonical status with a non-null `awaiting_input_since` (mirrors the
 *   `Boolean(session.awaitingInputSince)` + `TERMINAL_SHARED_STATUSES` check).
 * The clause references `sessions s`, so it is reused verbatim by both queries.
 */
// Mirror `parseSessionDate`'s `new Date(value)` → epoch-on-NaN fallback: NULL,
// empty, and otherwise-unparseable `started_at` all coerce to 1970-01-01 here,
// exactly as the hydrate path treats them. A raw `::timestamptz` cast would
// instead drop NULL rows from an `endDate` bound (parity drift — the hydrate
// path keeps them at epoch, which is `<= endDate`) and, worse, THROW on an
// empty or malformed legacy value, failing the whole usage query. The app only
// ever persists `toISOString()`, so the date-prefix guard admits every real
// value and routes the rest to epoch. Used by the `WHERE` filter clause only.
const SESSION_STARTED_AT_TS_EXPR =
  "(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN s.started_at ELSE '1970-01-01T00:00:00.000Z' END)";
// FEA-2036: started-at floor expression for the cursor pagination sort. SQLite
// dialect — the GLOB date-prefix guard mirrors SESSION_STARTED_AT_TS_EXPR. The
// per-event MAX(created_at) that used to be computed here now lives denormalized
// in `sessions.last_activity_at` (see recomputeSessionLastActivityAt); this floor
// remains the `Started` sort key and the COALESCE fallback for un-ingested rows.
const SESSION_STARTED_AT_SORT_EXPRESSION = SESSION_STARTED_AT_TS_EXPR;

// Bounds variant: same date-prefix guard, but NULL (not epoch) for
// NULL/empty/malformed `started_at`. MIN/MAX ignore NULL, so a legacy row with
// no real start cannot drag earliestSessionAt back to 1970 — matching the API's
// Prisma `_min`/`_max` (a non-nullable column, so no such rows) and the
// hydrate fold's `parseBoundsStartMs` skip. Bounds must NOT use the epoch
// fallback above, or desktop would show "Jan 1, 1970 – …" where web does not.
const SESSION_STARTED_AT_BOUNDS_EXPR =
  "(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN s.started_at ELSE NULL END)";

/**
 * Perf: (re)compute and persist `sessions.last_activity_at` for one session from
 * its current `events` / `started_at` rows. This is the denormalized cursor sort
 * key the Sessions list orders by; recomputing it from source on every ingest
 * write keeps it correct on re-import and on each live hook event. The value is
 * BYTE-FOR-BYTE the old per-page cursor expression:
 *   COALESCE(MAX(<events.created_at GLOB-guarded, else NULL>),
 *            <started_at GLOB-guarded, else 1970 epoch>)
 * so the read path that now ORDER BYs this column produces an identical page.
 * Scoped to one session_id — cheap (uses idx_events_session_id).
 *
 * Exported as the single source of truth for the denormalized-key SQL: test
 * fixtures that write events directly (bypassing the importer/hook ingest paths)
 * call this instead of re-implementing the UPDATE, so the expression can never
 * drift between production and tests.
 */
export async function recomputeSessionLastActivityAt(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE sessions
       SET last_activity_at = COALESCE(
         (
           SELECT MAX(
             CASE
               WHEN e.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
                 THEN e.created_at
               ELSE NULL
             END
           )
           FROM events e
           WHERE e.session_id = sessions.id
         ),
         CASE
           WHEN started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
             THEN started_at
           ELSE '1970-01-01T00:00:00.000Z'
         END
       )
     WHERE id = $1`,
    sessionId
  );
}

function buildUsageFilterClause(filters: AgentSessionUsageAggregateFilters): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const placeholder = () => `$${params.length + 1}`;

  const startedAtTs = SESSION_STARTED_AT_TS_EXPR;

  if (filters.harness) {
    conditions.push(`s.harness = ${placeholder()}`);
    params.push(filters.harness);
  }
  if (filters.startDate) {
    conditions.push(`${startedAtTs} >= ${placeholder()}`);
    params.push(filters.startDate.toISOString());
  }
  if (filters.endDate) {
    conditions.push(`${startedAtTs} <= ${placeholder()}`);
    params.push(filters.endDate.toISOString());
  }
  if (filters.status) {
    const canonical =
      "CASE WHEN lower(s.status) = 'error' THEN 'failed' WHEN lower(s.status) = 'running' THEN 'active' ELSE lower(s.status) END";
    const awaiting = `(${canonical} NOT IN ('abandoned', 'completed', 'failed') AND s.awaiting_input_since IS NOT NULL)`;
    const status = canonicalUsageStatus(filters.status);
    if (status === "waiting") {
      conditions.push(awaiting);
    } else if (status === "active") {
      // Parenthesized so each conditions[] entry stays a self-contained
      // predicate (the array is joined with " AND "); guards against a future
      // join change silently mis-associating this compound condition.
      conditions.push(`(${canonical} = 'active' AND NOT ${awaiting})`);
    } else {
      conditions.push(`${canonical} = ${placeholder()}`);
      params.push(status);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function canonicalUsageStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "error") {
    return "failed";
  }
  if (normalized === "running") {
    return "active";
  }
  return normalized;
}

async function aggregateSqliteUsage(
  db: SqliteClient,
  filters: AgentSessionUsageAggregateFilters
): Promise<AgentSessionUsageAggregate> {
  const { clause, params } = buildUsageFilterClause(filters);

  // Run both reads inside one transaction so a sync-cycle write cannot interleave
  // between them (the event loop yields at each await). Without the shared
  // snapshot, a session inserted in the gap would appear in the harness count but
  // not the token groups — or, on a delete, the inverse — transiently miscounting
  // totalSessions until the next refresh.
  const { tokenRows, harnessRows, boundsRow } = await db.transaction(
    async (tx) => {
      const tokenResult = await tx.query<{
        billing_mode: string | null;
        harness: string | null;
        model: string | null;
        input_tokens: string | null;
        output_tokens: string | null;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        session_count: number | null;
        estimated_cost_usd: number | null;
        unpriced_input_tokens: string | null;
        unpriced_output_tokens: string | null;
        unpriced_cache_read_tokens: string | null;
        unpriced_cache_write_tokens: string | null;
      }>(
        `
        SELECT
          s.billing_mode AS billing_mode,
          s.harness AS harness,
          t.model AS model,
          SUM(COALESCE(t.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(t.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(t.cache_read_tokens, 0)) AS cache_read_tokens,
          SUM(COALESCE(t.cache_write_tokens, 0)) AS cache_write_tokens,
          COUNT(DISTINCT t.session_id) AS session_count,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
        FROM token_usage t
        JOIN sessions s ON s.id = t.session_id
        ${clause}
        GROUP BY s.billing_mode, s.harness, t.model
        ORDER BY s.harness, t.model, s.billing_mode
      `,
        params
      );

      const harnessResult = await tx.query<{
        harness: string | null;
        session_count: number | null;
      }>(
        `
        SELECT s.harness AS harness, COUNT(*) AS session_count
        FROM sessions s
        ${clause}
        GROUP BY s.harness
        ORDER BY s.harness
      `,
        params
      );

      // Earliest/latest session start across the same filtered corpus. Uses the
      // NULL-fallback bounds expr (not the epoch-fallback filter expr) so legacy
      // rows with no real start are ignored by MIN/MAX rather than pinning the
      // earliest bound to 1970. Returned as ISO-8601 UTC strings so the JS side
      // never re-parses an ambiguous format; MIN/MAX over zero contributing rows
      // yield NULL → null bounds (graceful empty state).
      const boundsResult = await tx.query<{
        earliest_session_at: string | null;
        latest_session_at: string | null;
      }>(
        `
        SELECT
          MIN(${SESSION_STARTED_AT_BOUNDS_EXPR}) AS earliest_session_at,
          MAX(${SESSION_STARTED_AT_BOUNDS_EXPR}) AS latest_session_at
        FROM sessions s
        ${clause}
      `,
        params
      );

      return {
        tokenRows: tokenResult.rows,
        harnessRows: harnessResult.rows,
        boundsRow: boundsResult.rows[0] ?? null,
      };
    }
  );

  const tokenGroups = tokenRows.map((row) => ({
    billingMode: row.billing_mode,
    harness: row.harness,
    model: row.model,
    inputTokens: tokenCountValue(row.input_tokens, "insights.input"),
    outputTokens: tokenCountValue(row.output_tokens, "insights.output"),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "insights.cache_read"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "insights.cache_write"
    ),
    sessionCount: Number(row.session_count ?? 0),
    estimatedCostUsd:
      (nullableNumber(row.estimated_cost_usd) ?? 0) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "insights.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "insights.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "insights.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "insights.unpriced_cache_write"
        ),
        cost_usd_estimated: null,
      }) ?? 0),
  }));

  const harnessSessionCounts = harnessRows.map((row) => ({
    harness: row.harness,
    sessionCount: Number(row.session_count ?? 0),
  }));

  const totalSessions = harnessSessionCounts.reduce(
    (sum, entry) => sum + entry.sessionCount,
    0
  );

  return {
    totalSessions,
    earliestSessionAt: boundsRow?.earliest_session_at ?? null,
    latestSessionAt: boundsRow?.latest_session_at ?? null,
    tokenGroups,
    harnessSessionCounts,
  };
}

/**
 * FEA-2038: the empty analytics aggregate. Used as the graceful fallback /
 * base when the filtered corpus contributes no rows.
 */
function emptyAgentSessionAnalyticsAggregate(): AgentSessionAnalyticsAggregate {
  return { byTool: [], byAgentType: [], byRepository: [] };
}

// FEA-2038: the error/fail predicate over an event's `event_type`, mirroring
// `ERROR_EVENT_PATTERN = /error|fail/i` in shared-agent-sessions-api.ts. SQLite
// has no case-insensitive regex, so lower() + LIKE substring matches the
// `/i` substring test exactly (the pattern has no anchors/metacharacters).
const ANALYTICS_EVENT_ERROR_PREDICATE =
  "(lower({col}) LIKE '%error%' OR lower({col}) LIKE '%fail%')";

// FEA-2038: integer-ms-since-epoch for a canonical `toISOString()` value
// (`YYYY-MM-DDTHH:MM:SS.mmmZ`), else 0 — matching `new Date(iso).getTime()` and
// `parseSessionDate`'s NaN→epoch(0) fallback. NOT julianday (it drifts and
// fails the golden parity test). `{col}` is substituted with the column ref.
function analyticsIsoMsExpr(col: string): string {
  return (
    `(CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' ` +
    `THEN CAST(strftime('%s', ${col}) AS INTEGER) * 1000 + CAST(substr(${col}, 21, 3) AS INTEGER) ` +
    "ELSE 0 END)"
  );
}

/**
 * FEA-2038: O(grouped) analytics aggregation. Runs three grouped reads in ONE
 * transaction over the SAME filtered session set that `buildUsageFilterClause`
 * selects (reused verbatim so the corpus matches the hydrate filter), then
 * resolves each distinct `cwd` to its attribution via the shared `cache` and
 * merges per-cwd repository rows into their resolved `repositoryFullName` —
 * mirroring `buildToolBreakdowns` / `buildAgentTypeBreakdowns` /
 * `buildRepositoryBreakdowns` exactly. No session/event/agent/token rows are
 * hydrated into JS, eliminating the db-host OOM (exit code 5).
 */
async function aggregateSqliteAnalytics(
  db: SqliteClient,
  filters: AgentSessionUsageAggregateFilters,
  cache: SessionAttributionResolverCache
): Promise<AgentSessionAnalyticsAggregate> {
  const { clause, params } = buildUsageFilterClause(filters);

  const durStart = analyticsIsoMsExpr("a.started_at");
  const durEnd = analyticsIsoMsExpr("a.ended_at");
  // durMs: NULL when started_at/ended_at is NULL or empty-string, else the
  // integer-ms difference. Mirrors `durationBetween`'s `!(startedAt && endedAt)`
  // null guard, then `end.getTime() - start.getTime()`.
  const durMs =
    "(CASE WHEN a.started_at IS NULL OR a.started_at = '' OR a.ended_at IS NULL OR a.ended_at = '' " +
    `THEN NULL ELSE ${durEnd} - ${durStart} END)`;
  const eventErrorPredicate = ANALYTICS_EVENT_ERROR_PREDICATE.replaceAll(
    "{col}",
    "e.event_type"
  );

  const { toolRows, agentRows, repoRows, repoCostRows } = await db.transaction(
    async (tx) => {
      // byTool — events joined to the filtered sessions, WHERE tool_name IS NOT NULL.
      const toolResult = await tx.query<{
        tool_name: string;
        invocation_count: number | string | null;
        error_count: number | string | null;
        session_count: number | string | null;
      }>(
        `
        SELECT
          e.tool_name AS tool_name,
          COUNT(*) AS invocation_count,
          SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count,
          COUNT(DISTINCT e.session_id) AS session_count
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        ${clause}
        ${clause ? "AND" : "WHERE"} e.tool_name IS NOT NULL
        GROUP BY e.tool_name
      `,
        params
      );

      // byAgentType — agents joined to the filtered sessions, grouped by the
      // COALESCE(subagent_type, type, 'unknown') identity.
      const agentResult = await tx.query<{
        agent_type: string;
        count: number | string | null;
        success_count: number | string | null;
        failed_count: number | string | null;
        duration_total_ms: number | string | null;
        duration_count: number | string | null;
      }>(
        `
        SELECT
          COALESCE(a.subagent_type, a.type, 'unknown') AS agent_type,
          COUNT(*) AS count,
          SUM(CASE WHEN (lower(a.status) LIKE '%success%' OR lower(a.status) LIKE '%complete%' OR lower(a.status) LIKE '%done%') THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN (lower(a.status) LIKE '%error%' OR lower(a.status) LIKE '%fail%') THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN ${durMs} IS NOT NULL AND ${durMs} >= 0 THEN ${durMs} ELSE 0 END) AS duration_total_ms,
          SUM(CASE WHEN ${durMs} IS NOT NULL AND ${durMs} >= 0 THEN 1 ELSE 0 END) AS duration_count
        FROM agents a
        JOIN sessions s ON s.id = a.session_id
        ${clause}
        GROUP BY COALESCE(a.subagent_type, a.type, 'unknown')
      `,
        params
      );

      // byRepository — per-cwd rollup. Token sums are summed PER SESSION first
      // (a CTE) to avoid the token_usage join fanning out the per-session error
      // count, mirroring how `aggregateSqliteUsage` sums tokens; the error count
      // is likewise a per-session sub-aggregate. Grouped by the RAW cwd; JS
      // resolves+merges to repositoryFullName below.
      const repoResult = await tx.query<{
        cwd: string | null;
        session_count: number | string | null;
        input_tokens: string | null;
        output_tokens: string | null;
        error_count: number | string | null;
      }>(
        `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd
          FROM sessions s
          ${clause}
        ),
        per_session_tokens AS (
          SELECT t.session_id AS session_id,
            SUM(COALESCE(t.input_tokens, 0)) AS input_tokens,
            SUM(COALESCE(t.output_tokens, 0)) AS output_tokens
          FROM token_usage t
          JOIN filtered f ON f.id = t.session_id
          GROUP BY t.session_id
        ),
        per_session_errors AS (
          SELECT e.session_id AS session_id,
            SUM(CASE WHEN ${eventErrorPredicate} THEN 1 ELSE 0 END) AS error_count
          FROM events e
          JOIN filtered f ON f.id = e.session_id
          GROUP BY e.session_id
        )
        SELECT
          f.cwd AS cwd,
          COUNT(*) AS session_count,
          SUM(COALESCE(pt.input_tokens, 0)) AS input_tokens,
          SUM(COALESCE(pt.output_tokens, 0)) AS output_tokens,
          SUM(COALESCE(pe.error_count, 0)) AS error_count
        FROM filtered f
        LEFT JOIN per_session_tokens pt ON pt.session_id = f.id
        LEFT JOIN per_session_errors pe ON pe.session_id = f.id
        GROUP BY f.cwd
      `,
        params
      );

      // Per-(cwd, model) cost rollup. Mirrors `aggregateSqliteUsage`'s cost
      // handling EXACTLY: stored `cost_usd_estimated` sums for priced rows, and
      // the unpriced token sums per model so the JS fold can apply
      // `resolveTokenUsageCostUsd` once per (cwd, model) group — equal to pricing
      // each row then summing (linear in tokens) — matching the hydrate loader's
      // per-row `resolveTokenUsageCostUsd(...) ?? 0` accumulated by `sumTokenUsage`.
      const repoCostResult = await tx.query<{
        cwd: string | null;
        model: string | null;
        estimated_cost_usd: number | null;
        unpriced_input_tokens: string | null;
        unpriced_output_tokens: string | null;
        unpriced_cache_read_tokens: string | null;
        unpriced_cache_write_tokens: string | null;
      }>(
        `
        WITH filtered AS (
          SELECT s.id AS id, s.cwd AS cwd
          FROM sessions s
          ${clause}
        )
        SELECT
          f.cwd AS cwd,
          t.model AS model,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
        FROM token_usage t
        JOIN filtered f ON f.id = t.session_id
        GROUP BY f.cwd, t.model
      `,
        params
      );

      return {
        toolRows: toolResult.rows,
        agentRows: agentResult.rows,
        repoRows: repoResult.rows,
        repoCostRows: repoCostResult.rows,
      };
    }
  );

  const byTool: AgentSessionAnalyticsToolGroup[] = toolRows.map((row) => ({
    toolName: row.tool_name,
    invocationCount: Number(row.invocation_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
  }));

  const byAgentType: AgentSessionAnalyticsAgentTypeGroup[] = agentRows.map(
    (row) => ({
      agentType: row.agent_type,
      count: Number(row.count ?? 0),
      successCount: Number(row.success_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      durationTotalMs: Number(row.duration_total_ms ?? 0),
      durationCount: Number(row.duration_count ?? 0),
    })
  );

  const byRepository = await resolveAnalyticsRepositoryGroups(
    repoRows,
    repoCostRows,
    cache
  );

  return { byTool, byAgentType, byRepository };
}

/**
 * FEA-2038: resolve a cwd to its repository identity using the SAME resolver the
 * hydrate/sync path uses (`resolveSessionAttributionAsync` over the shared
 * `cache`), applying the `attribution?.repositoryFullName ??
 * attribution?.worktreePath ?? cwd ?? "unknown"` chain from
 * `buildRepositoryBreakdowns`. Cached per cwd by the resolver cache.
 */
async function resolveCwdRepositoryFullName(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<string> {
  const attribution = await resolveSessionAttributionAsync(cwd, cache);
  return (
    attribution?.repositoryFullName ??
    attribution?.worktreePath ??
    cwd ??
    "unknown"
  );
}

/**
 * FEA-2038: resolve each per-cwd repository row to its `repositoryFullName`,
 * then merge cwds that resolve to one identity — summing the same fields the JS
 * `buildRepositoryBreakdowns` fold accumulates. Cost is folded from the
 * per-(cwd, model) cost rollup exactly as `aggregateSqliteUsage` does (stored
 * priced cost + `resolveTokenUsageCostUsd` over the unpriced token sums per
 * model), so a row with a null `cost_usd_estimated` is priced via model pricing
 * identically to the hydrate loader's per-row `resolveTokenUsageCostUsd`.
 */
async function resolveAnalyticsRepositoryGroups(
  repoRows: {
    cwd: string | null;
    session_count: number | string | null;
    input_tokens: string | null;
    output_tokens: string | null;
    error_count: number | string | null;
  }[],
  repoCostRows: {
    cwd: string | null;
    model: string | null;
    estimated_cost_usd: number | null;
    unpriced_input_tokens: string | null;
    unpriced_output_tokens: string | null;
    unpriced_cache_read_tokens: string | null;
    unpriced_cache_write_tokens: string | null;
  }[],
  cache: SessionAttributionResolverCache
): Promise<AgentSessionAnalyticsRepositoryGroup[]> {
  const groups = new Map<string, AgentSessionAnalyticsRepositoryGroup>();
  const ensureGroup = (
    repositoryFullName: string
  ): AgentSessionAnalyticsRepositoryGroup => {
    const existing = groups.get(repositoryFullName);
    if (existing) {
      return existing;
    }
    const created: AgentSessionAnalyticsRepositoryGroup = {
      repositoryFullName,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    };
    groups.set(repositoryFullName, created);
    return created;
  };

  for (const row of repoRows) {
    const repositoryFullName = await resolveCwdRepositoryFullName(
      row.cwd,
      cache
    );
    const group = ensureGroup(repositoryFullName);
    group.sessionCount += Number(row.session_count ?? 0);
    group.inputTokens += tokenCountValue(
      row.input_tokens,
      "analytics.repo.input"
    );
    group.outputTokens += tokenCountValue(
      row.output_tokens,
      "analytics.repo.output"
    );
    group.errorCount += Number(row.error_count ?? 0);
  }

  for (const row of repoCostRows) {
    const repositoryFullName = await resolveCwdRepositoryFullName(
      row.cwd,
      cache
    );
    const group = ensureGroup(repositoryFullName);
    group.estimatedCost +=
      (nullableNumber(row.estimated_cost_usd) ?? 0) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "analytics.repo.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "analytics.repo.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "analytics.repo.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "analytics.repo.unpriced_cache_write"
        ),
        cost_usd_estimated: null,
      }) ?? 0);
  }
  return [...groups.values()];
}

type SqliteSessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
  metadata: string | null;
  harness: string | null;
  billing_mode: string | null;
  user_id: string | null;
  organization_id: string | null;
  cost_usd_estimated: number | null;
  cost_currency: string | null;
  cost_source: string | null;
  data_revision: number;
};

type SqliteAgentRow = {
  id: string;
  session_id: string;
  name: string;
  type: string;
  subagent_type: string | null;
  status: string;
  task: string | null;
  current_tool: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
  parent_agent_id: string | null;
  metadata: string | null;
};

type SqliteEventRow = {
  id: string;
  session_id: string;
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  data: string | null;
  created_at: string;
};

type SqliteTokenUsageRow = {
  session_id: string;
  model: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  created_at: string | null;
  cost_usd_estimated: number | null;
};

type SqliteTokenEventRow = {
  session_id: string;
  model: string;
  created_at: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  cost_usd_estimated: number | null;
  input_cost_usd_estimated: number | null;
  output_cost_usd_estimated: number | null;
  cache_read_cost_usd_estimated: number | null;
  cache_creation_cost_usd_estimated: number | null;
};

type SqliteArtifactLinkRow = {
  session_id: string;
  target_kind: string;
  slug: string | null;
  is_primary: boolean;
  method: string;
  repo_full_name: string | null;
  pr_number: number | null;
  url: string | null;
  relation: string | null;
  sha: string | null;
  title: string | null;
  branch_name: string | null;
  link_observed_at: string | null;
  artifact_committed_at: string | null;
  artifact_observed_at: string | null;
  artifact_last_seen_at: string | null;
};

type SqlitePullRequestRow = {
  session_id: string;
  pr_number: number | null;
  repo_full_name: string | null;
  title: string | null;
  state: string | null;
  closed_at: string | null;
  merged_at: string | null;
  observed_at: string | null;
};

type SqliteGitLocRow = {
  session_id: string;
  total_added: number;
  total_removed: number;
  total_files: number;
};

type SessionPrWithIdentity = SessionPR & {
  repositoryFullName?: string | null;
};

/** The two row sets both the full and usage loads need. */
function selectSessionRows(
  db: SqliteClient,
  ids: string[]
): Promise<SqliteSessionRow[]> {
  return selectRowsByIds<SqliteSessionRow>(
    db,
    `
      SELECT
        id,
        name,
        status,
        cwd,
        model,
        started_at,
        updated_at,
        ended_at,
        awaiting_input_since,
        metadata,
        harness,
        billing_mode,
        user_id,
        organization_id,
        cost_usd_estimated,
        cost_currency,
        cost_source,
        data_revision
      FROM sessions
      WHERE id IN (__IDS__)
    `,
    ids
  );
}

function selectTokenUsageRows(
  db: SqliteClient,
  ids: string[]
): Promise<SqliteTokenUsageRow[]> {
  return selectRowsByIds<SqliteTokenUsageRow>(
    db,
    `
      SELECT
        session_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        created_at,
        cost_usd_estimated
      FROM token_usage
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, model ASC
    `,
    ids
  );
}

/**
 * Prove locally that a session cannot fit in the existing sync payload cap using
 * only the base session row. This is intentionally a lower-bound check: when
 * the minimal no-events/no-relations object is already oversized, the old full
 * hydrate path would also dead-letter after loading far more data. Borderline
 * sessions are omitted so they still take the exact full hydrate path.
 */
/**
 * FEA-2038: total stored event `data` bytes per session — the RAW hydration cost
 * we pay to load a session for cloud sync. A few enormous agent transcripts (tens
 * of MB of tool I/O in event `data`) fatally crash the db-host (exit code 5) when
 * hydrated, so the sync layer dead-letters any session over `maxBytes` BEFORE the
 * heavy `loadSyncedSessions`. Distinct from findSqliteLocallyOversizedSessions,
 * which measures the post-sanitize payload with event content stripped.
 * `length(data)` is a native SQLite scan — it never materializes the blobs in JS.
 */
async function findSqliteUnhydratableSessions(
  db: SqliteClient,
  ids: string[],
  maxBytes: number
): Promise<{ id: string; payloadBytes: number }[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await selectRowsByIds<{
    session_id: string;
    bytes: number | string | null;
  }>(
    db,
    `
      SELECT session_id, COALESCE(SUM(length(data)), 0) AS bytes
      FROM events
      WHERE session_id IN (__IDS__)
      GROUP BY session_id
    `,
    ids
  );
  return rows.flatMap((row) => {
    const payloadBytes = Number(row.bytes ?? 0);
    return payloadBytes > maxBytes
      ? [{ id: row.session_id, payloadBytes }]
      : [];
  });
}

async function findSqliteLocallyOversizedSessions(
  db: SqliteClient,
  ids: string[],
  maxBytes: number
): Promise<{ id: string; payloadBytes: number }[]> {
  if (ids.length === 0) {
    return [];
  }

  const sessionRows = await selectSessionRows(db, ids);
  const sessionsById = new Map(sessionRows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = sessionsById.get(id);
    if (!row) {
      return [];
    }
    const payloadBytes = estimateSessionPayloadBytes(
      buildMinimalSyncSession(row)
    );
    return payloadBytes > maxBytes ? [{ id, payloadBytes }] : [];
  });
}

// Max session ids hydrated per database round. The full load fetches EVERY
// event row (with its full `data` JSON) for the requested sessions at once, so
// an unbounded id list (e.g. the analytics / search-usage path passing the
// entire corpus) materializes the whole event table in memory inside a single
// libSQL `execute()` + its POJO copy — multi-GB on a large real dataset, which
// OOMs the db-host utilityProcess. Chunking caps peak memory at one batch's
// worth of rows regardless of corpus size; assembled sessions are per-id
// (`assembleSyncedSessions`'s `ids.flatMap`) so concatenating chunk results is
// identical to a single load, and each chunk's raw rows are freed between
// rounds. Sized to stay well under SQLite's bound-parameter ceiling (the git
// LOC query repeats the IN list 3x → ~3x ids placeholders per statement).
const SYNCED_SESSION_HYDRATE_CHUNK_SIZE = 200;

function chunkIds(ids: string[], size: number): string[][] {
  if (ids.length <= size) {
    return [ids];
  }
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Full load: session metadata plus every hydrated relation (agents, events,
 * token_events, artifact_links) and resolved attribution. Used by detail/list
 * reads. Shares the per-session assembly with the usage load via
 * `assembleSyncedSessions`, so the two can never project a session differently.
 *
 * Hydrates in bounded id chunks so peak memory stays flat as the corpus grows
 * (see `SYNCED_SESSION_HYDRATE_CHUNK_SIZE`). The attribution `cache` is shared
 * across chunks so cross-chunk cwd resolution is still de-duplicated.
 *
 * FEA-2038 OOM fix: `options.omitEventData` drops the per-event `data` JSON blob
 * (it is still SELECTed for `tool_name`/`event_type`, but the multi-KB parsed
 * `data` object is NOT retained). The full-corpus read callers — the sessions
 * LIST and ANALYTICS paths — only read `event.toolName`/`event.eventType` (never
 * `event.data`), yet they hydrate the ENTIRE corpus at once, so retaining every
 * event's `data` blob across the whole corpus was the dominant peak-memory term
 * that OOM-killed the db-host child during the first-launch backfill. Callers
 * that DO read `event.data` (the single-session detail path, the per-branch
 * trace, and the cloud-sync payload builder) leave this off and keep full data;
 * those are bounded to one session / one branch / one sync batch, not the corpus.
 */
async function loadSqliteSyncedSessions(
  db: SqliteClient,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: { omitEventData?: boolean }
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length <= SYNCED_SESSION_HYDRATE_CHUNK_SIZE) {
    return loadSqliteSyncedSessionsChunk(db, ids, cache, options);
  }
  const out: SyncedAgentSession[] = [];
  for (const chunk of chunkIds(ids, SYNCED_SESSION_HYDRATE_CHUNK_SIZE)) {
    const loaded = await loadSqliteSyncedSessionsChunk(
      db,
      chunk,
      cache,
      options
    );
    for (const session of loaded) {
      out.push(session);
    }
  }
  return out;
}

async function loadSqliteSyncedSessionsChunk(
  db: SqliteClient,
  ids: string[],
  cache: SessionAttributionResolverCache,
  options?: { omitEventData?: boolean }
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  const sessionRows = await selectSessionRows(db, ids);
  const tokenRows = await selectTokenUsageRows(db, ids);
  const agentRows = await selectRowsByIds<SqliteAgentRow>(
    db,
    `
      SELECT
        id,
        session_id,
        name,
        type,
        subagent_type,
        status,
        task,
        current_tool,
        started_at,
        updated_at,
        ended_at,
        awaiting_input_since,
        parent_agent_id,
        metadata
      FROM agents
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, started_at ASC, id ASC
    `,
    ids
  );
  // FEA-2038 OOM fix (DBA pass): when the caller won't read `event.data`, omit
  // the column from the SELECT entirely rather than SELECTing it and dropping the
  // parsed object after the fact. The libSQL driver materializes the full result
  // set (`result.rows`) in memory before the JS-side omit runs, so SELECTing the
  // multi-KB `data` text for every event of the WHOLE corpus (the list/analytics
  // full-hydration path) was still the dominant peak-memory term that OOM-killed
  // the db-host child during a large first-launch backfill — even though the
  // parsed object was never retained. On a 20k-session / 2M-event corpus this is
  // the difference between ~1.3 GB and ~0.1 GB of materialized event text. The
  // omitted column is aliased back to `data` (as SQL NULL) so the row shape is
  // unchanged; the omit branch in `assembleSyncedSessions` never reads it. Detail/
  // trace/sync callers keep `omitEventData` off and still get the full blob.
  const eventDataColumn = options?.omitEventData ? "NULL AS data" : "data";
  const eventRows = await selectRowsByIds<SqliteEventRow>(
    db,
    `
      SELECT
        id,
        session_id,
        agent_id,
        event_type,
        tool_name,
        summary,
        ${eventDataColumn},
        created_at
      FROM events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, id ASC
    `,
    ids
  );
  const tokenEventRows = await selectRowsByIds<SqliteTokenEventRow>(
    db,
    `
      SELECT
        session_id,
        model,
        created_at,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd_estimated,
        input_cost_usd_estimated,
        output_cost_usd_estimated,
        cache_read_cost_usd_estimated,
        cache_creation_cost_usd_estimated
      FROM token_events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, model ASC
    `,
    ids
  );
  const artifactLinkRows = await selectRowsByIds<SqliteArtifactLinkRow>(
    db,
    `
      SELECT
        sal.session_id,
        a.kind AS target_kind,
        a.slug,
        sal.is_primary,
        sal.method,
        a.repo_full_name,
        a.pr_number,
        a.url,
        sal.relation,
        a.sha,
        a.title,
        a.branch_name,
        sal.observed_at AS link_observed_at,
        a.committed_at AS artifact_committed_at,
        a.observed_at AS artifact_observed_at,
        a.last_seen_at AS artifact_last_seen_at
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id IN (__IDS__)
      ORDER BY sal.session_id ASC, sal.created_at ASC
    `,
    ids
  );
  const pullRequestRows = await selectRowsByIds<SqlitePullRequestRow>(
    db,
    `
      SELECT session_id, pr_number, repo_full_name, title, state,
        closed_at, merged_at, observed_at
      FROM (
        SELECT
          sal.session_id AS session_id,
          a.pr_number AS pr_number,
          a.repo_full_name AS repo_full_name,
          a.title AS title,
          UPPER(a.pr_state) AS state,
          NULL AS closed_at,
          NULL AS merged_at,
          a.last_seen_at AS observed_at,
          ROW_NUMBER() OVER (
            PARTITION BY sal.session_id, a.pr_number, a.repo_full_name
            ORDER BY a.last_seen_at DESC
          ) AS rn
        FROM session_artifact_links sal
        JOIN artifacts a ON a.id = sal.artifact_id
        WHERE sal.session_id IN (__IDS__)
          AND a.kind = 'pull_request'
          AND a.pr_number IS NOT NULL
          AND sal.relation IN ('created', 'workspace')
      ) ranked
      WHERE rn = 1
      ORDER BY session_id, pr_number, repo_full_name
    `,
    ids
  );
  // FEA-1899: git LOC rollup. Only sessions that actually committed code
  // (have 'created' commit links) get LOC attributed. Review-only sessions
  // get 0. Prefers per-commit stats when enriched; falls back to branch/PR
  // stats when commit SHAs are invalid (RTK strips them). The gate is
  // "has_created_commits" — a session must have at least one 'created'
  // commit link to qualify, even if the commits themselves aren't enriched.
  const gitLocRows = await selectRowsByIds<SqliteGitLocRow>(
    db,
    `
      WITH authored_sessions AS (
        SELECT DISTINCT session_id
        FROM session_artifact_links
        WHERE session_id IN (__IDS__)
          AND relation = 'created'
          AND artifact_id IN (SELECT id FROM artifacts WHERE kind = 'commit')
      )
      SELECT session_id, total_added, total_removed, total_files
      FROM (
        SELECT session_id, total_added, total_removed, total_files,
          ROW_NUMBER() OVER (
            PARTITION BY session_id ORDER BY priority
          ) AS rn
        FROM (
          SELECT
            sal.session_id AS session_id,
            COALESCE(SUM(a.lines_added), 0) AS total_added,
            COALESCE(SUM(a.lines_removed), 0) AS total_removed,
            COALESCE(SUM(a.files_changed), 0) AS total_files,
            1 AS priority
          FROM session_artifact_links sal
          JOIN artifacts a ON sal.artifact_id = a.id
          WHERE sal.session_id IN (__IDS__)
            AND sal.relation = 'created'
            AND a.kind = 'commit'
            AND a.enrichment_state IN ('provisional', 'final')
            AND a.lines_added IS NOT NULL
          GROUP BY sal.session_id
          HAVING SUM(a.lines_added) > 0 OR SUM(a.lines_removed) > 0
          UNION ALL
          SELECT
            sal.session_id,
            COALESCE(a.lines_added, 0),
            COALESCE(a.lines_removed, 0),
            COALESCE(a.files_changed, 0),
            CASE a.kind WHEN 'branch' THEN 2 ELSE 3 END AS priority
          FROM session_artifact_links sal
          JOIN artifacts a ON sal.artifact_id = a.id
          JOIN authored_sessions auth ON auth.session_id = sal.session_id
          WHERE sal.session_id IN (__IDS__)
            AND a.kind IN ('branch', 'pull_request')
            AND sal.relation IN ('created', 'workspace')
            AND a.lines_added IS NOT NULL
        ) sources
      ) ranked
      WHERE rn = 1
      ORDER BY session_id
    `,
    ids
  );
  // Branch/PR LOC for all sessions on the branch (ungated — review sessions
  // see the branch total for context, even though their authored LOC is 0).
  const branchLocRows = await selectRowsByIds<SqliteGitLocRow>(
    db,
    `
      SELECT session_id, total_added, total_removed, total_files
      FROM (
        SELECT
          sal.session_id AS session_id,
          COALESCE(a.lines_added, 0) AS total_added,
          COALESCE(a.lines_removed, 0) AS total_removed,
          COALESCE(a.files_changed, 0) AS total_files,
          ROW_NUMBER() OVER (
            PARTITION BY sal.session_id
            ORDER BY CASE a.kind WHEN 'branch' THEN 1 ELSE 2 END
          ) AS rn
        FROM session_artifact_links sal
        JOIN artifacts a ON sal.artifact_id = a.id
        WHERE sal.session_id IN (__IDS__)
          AND a.kind IN ('branch', 'pull_request')
          AND sal.relation IN ('created', 'workspace')
          AND a.lines_added IS NOT NULL
      ) ranked
      WHERE rn = 1
      ORDER BY session_id
    `,
    ids
  );
  const attributionByCwd = await resolveSyncAttributions(sessionRows, cache);
  return assembleSyncedSessions(ids, {
    sessionRows,
    agentRows,
    eventRows,
    tokenRows,
    tokenEventRows,
    artifactLinkRows,
    pullRequestRows,
    gitLocRows,
    branchLocRows,
    omitEventData: options?.omitEventData ?? false,
    resolveAttribution: (cwd) =>
      cwd ? (attributionByCwd.get(cwd) ?? undefined) : undefined,
  });
}

/**
 * FEA-1834: lightweight load for the usage summary. Fetches only the `sessions`
 * and `token_usage` rows; the agents/events/token_events/artifact_links queries
 * and attribution resolution the full load performs are skipped because
 * `buildUsageSummary`/`matchesQuery` never read them. The skipped inputs simply
 * arrive empty at `assembleSyncedSessions`, so the usage projection cannot drift
 * from the full one — it is far cheaper to re-run on the live cadence as the
 * corpus grows.
 */
async function loadSqliteUsageSessions(
  db: SqliteClient,
  ids: string[]
): Promise<SyncedAgentSession[]> {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > SYNCED_SESSION_HYDRATE_CHUNK_SIZE) {
    const out: SyncedAgentSession[] = [];
    for (const chunk of chunkIds(ids, SYNCED_SESSION_HYDRATE_CHUNK_SIZE)) {
      const loaded = await loadSqliteUsageSessions(db, chunk);
      for (const session of loaded) {
        out.push(session);
      }
    }
    return out;
  }
  const sessionRows = await selectSessionRows(db, ids);
  const tokenRows = await selectTokenUsageRows(db, ids);
  return assembleSyncedSessions(ids, {
    sessionRows,
    agentRows: [],
    eventRows: [],
    tokenRows,
    tokenEventRows: [],
    artifactLinkRows: [],
    pullRequestRows: [],
    gitLocRows: [],
    branchLocRows: [],
    resolveAttribution: () => undefined,
  });
}

async function resolveSyncAttributions(
  sessionRows: SqliteSessionRow[],
  cache: SessionAttributionResolverCache
): Promise<Map<string, ResolvedSyncAttribution | null>> {
  const uniqueCwds = [
    ...new Set(
      sessionRows.flatMap((row) => (row.cwd === null ? [] : [row.cwd]))
    ),
  ];
  const entries = await Promise.all(
    uniqueCwds.map(
      async (cwd): Promise<[string, ResolvedSyncAttribution | null]> => [
        cwd,
        (await resolveSessionAttributionAsync(cwd, cache)) ?? null,
      ]
    )
  );
  return new Map(entries);
}

type ResolvedSyncAttribution = NonNullable<
  ReturnType<typeof resolveSessionAttribution>
>;

function buildMinimalSyncSession(row: SqliteSessionRow): SyncedAgentSession {
  const metadata = parseJsonObjectText(row.metadata);
  return {
    externalSessionId: row.id,
    name: row.name,
    status: row.status,
    harness: row.harness,
    billingMode: resolveBillingModeForRow(row),
    cwd: row.cwd,
    model: row.model,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    awaitingInputSince: row.awaiting_input_since,
    metadata,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    deviceTimeZone: localTimeZone(),
    dataRevision: row.data_revision,
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

/**
 * Pure per-session fold shared by both loads: it never touches the database, so
 * the full and usage paths differ only in which row sets (and attribution) they
 * hand in. Empty relation rows naturally yield `agents: []` / `events: []` and
 * no artifact/PR refs.
 */
function assembleSyncedSessions(
  ids: string[],
  rows: {
    sessionRows: SqliteSessionRow[];
    agentRows: SqliteAgentRow[];
    eventRows: SqliteEventRow[];
    tokenRows: SqliteTokenUsageRow[];
    tokenEventRows: SqliteTokenEventRow[];
    artifactLinkRows: SqliteArtifactLinkRow[];
    pullRequestRows: SqlitePullRequestRow[];
    gitLocRows: SqliteGitLocRow[];
    branchLocRows: SqliteGitLocRow[];
    // When true, skip parsing/retaining each event's `data` JSON blob (the
    // dominant per-event memory cost). Callers that never read `event.data`
    // (full-corpus list/analytics reads) set this to bound peak memory; callers
    // that do (detail/branch-trace/sync payload) leave it false. Defaults to
    // false so the usage path — which passes no event rows — is unaffected.
    omitEventData?: boolean;
    resolveAttribution: (
      cwd: string | null
    ) => ReturnType<typeof resolveSessionAttribution>;
  }
): SyncedAgentSession[] {
  const artifactLinksBySessionId = groupRowsBySessionId(rows.artifactLinkRows);
  const pullRequestsBySessionId = groupRowsBySessionId(rows.pullRequestRows);
  const gitLocBySessionId = new Map(
    rows.gitLocRows.map((r) => [r.session_id, r])
  );
  const branchLocBySessionId = new Map(
    rows.branchLocRows.map((r) => [r.session_id, r])
  );

  const sessionsById = new Map(rows.sessionRows.map((row) => [row.id, row]));
  const agentsBySessionId = groupRowsBySessionId(rows.agentRows);
  const eventsBySessionId = groupRowsBySessionId(rows.eventRows);
  const tokenUsageBySessionId = groupRowsBySessionId(rows.tokenRows);
  const tokenEventsBySessionId = groupRowsBySessionId(rows.tokenEventRows);

  return ids.flatMap((id) => {
    const row = sessionsById.get(id);
    if (!row) {
      return [];
    }
    const attribution = rows.resolveAttribution(row.cwd);
    const metadata = parseJsonObjectText(row.metadata);

    const linkRows = artifactLinksBySessionId.get(id) ?? [];
    const artifactRefs: SyncedArtifactRef[] = [];
    const prRefs: SyncedSessionPrRef[] = [];
    for (const link of linkRows) {
      if (link.target_kind === "closedloop_artifact" && link.slug) {
        artifactRefs.push({
          slug: link.slug,
          isPrimary: link.is_primary,
          method: link.method,
        });
      } else if (
        link.target_kind === "pull_request" &&
        link.repo_full_name &&
        link.pr_number != null &&
        link.url
      ) {
        prRefs.push({
          repositoryFullName: link.repo_full_name,
          prNumber: link.pr_number,
          prUrl: link.url,
          relationType: (link.relation === "created"
            ? "CREATED"
            : "REFERENCED") satisfies SessionPrRelationType,
        });
      }
    }

    const tokenUsageByModel: SyncedAgentSessionTokenUsage[] = (
      tokenUsageBySessionId.get(id) ?? []
    ).map((tokenRow) => {
      const inputTokens = tokenCountValue(tokenRow.input_tokens, "sync.input");
      const outputTokens = tokenCountValue(
        tokenRow.output_tokens,
        "sync.output"
      );
      const cacheReadTokens = tokenCountValue(
        tokenRow.cache_read_tokens,
        "sync.cache_read"
      );
      const cacheWriteTokens = tokenCountValue(
        tokenRow.cache_write_tokens,
        "sync.cache_write"
      );
      const estimatedCostUsd = resolveTokenUsageCostUsd({
        ...tokenRow,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
      });
      return {
        model: tokenRow.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      };
    });
    const sessionEventRows = eventsBySessionId.get(id) ?? [];
    const timelineRows = buildTraceTimelineRows(metadata, sessionEventRows);
    const traceFields = buildSessionTraceSyncFields({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      metadata,
      attribution,
      artifactLinkBranch: resolveArtifactLinkBranch(linkRows),
      events: sessionEventRows,
      timelineRows,
      tokenEvents: (tokenEventsBySessionId.get(id) ?? []).map(
        normalizeTraceTokenEvent
      ),
      localPullRequests: pullRequestsBySessionId.get(id) ?? [],
    });
    const { markers: traceMarkers, ...traceFieldsWithoutMarkers } = traceFields;

    const artifactMarkers = buildArtifactSessionMarkers({
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      links: linkRows,
      timelineRows: timelineRows.map((timelineRow) => ({
        createdAt: timelineRow.createdAt,
      })),
    });
    const markers = mergeSessionMarkers(traceMarkers ?? [], artifactMarkers);
    // PLN-1034: genuine activity = the latest agent event, floored at the
    // session start. Derived from the same local events the desktop syncs, so
    // the desktop list and the cloud-derived value agree. Deliberately NOT
    // row.updated_at (bumped by OTEL ingest / enrichment / sync writes).
    const lastActivityAt = sessionEventRows.reduce<string | null>(
      (latest, eventRow) => {
        if (!eventRow.created_at) {
          return latest;
        }
        if (
          latest === null ||
          new Date(eventRow.created_at).getTime() > new Date(latest).getTime()
        ) {
          return eventRow.created_at;
        }
        return latest;
      },
      row.started_at ?? null
    );

    return [
      {
        externalSessionId: row.id,
        name: row.name,
        status: row.status,
        harness: row.harness,
        billingMode: resolveBillingModeForRow(row),
        cwd: row.cwd,
        model: row.model,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        lastActivityAt,
        endedAt: row.ended_at,
        awaitingInputSince: row.awaiting_input_since,
        metadata,
        ...(row.user_id ? { userId: row.user_id } : {}),
        ...(row.organization_id ? { organizationId: row.organization_id } : {}),
        deviceTimeZone: localTimeZone(),
        dataRevision: row.data_revision,
        ...(attribution ? { attribution } : {}),
        ...traceFieldsWithoutMarkers,
        ...(markers.length > 0 ? { markers } : {}),
        ...buildGitDiffStats(gitLocBySessionId.get(id)),
        ...buildBranchDiffStats(branchLocBySessionId.get(id)),
        ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
        prRefs,
        agents: (agentsBySessionId.get(id) ?? []).map((agentRow) => ({
          externalAgentId: agentRow.id,
          name: agentRow.name,
          type: agentRow.type,
          subagentType: agentRow.subagent_type,
          status: agentRow.status,
          task: agentRow.task,
          currentTool: agentRow.current_tool,
          startedAt: agentRow.started_at,
          updatedAt: agentRow.updated_at,
          endedAt: agentRow.ended_at,
          awaitingInputSince: agentRow.awaiting_input_since,
          parentExternalAgentId: agentRow.parent_agent_id,
          metadata: parseJsonObjectText(agentRow.metadata),
        })),
        events: sessionEventRows.map((eventRow) => ({
          externalEventId: String(eventRow.id),
          agentExternalId: eventRow.agent_id,
          eventType: eventRow.event_type,
          toolName: eventRow.tool_name,
          summary: eventRow.summary,
          // Omit the heavy `data` blob entirely when the caller won't read it,
          // so the parsed object is never allocated/retained for the corpus.
          ...(rows.omitEventData
            ? {}
            : { data: parseJsonValueText(eventRow.data) }),
          createdAt: eventRow.created_at,
        })),
        tokenUsageByModel,
      },
    ];
  });
}

type SessionTraceSyncInput = {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown> | null;
  attribution:
    | { baseBranch?: string | null; issueId?: string | null }
    | null
    | undefined;
  artifactLinkBranch: string | null;
  events: readonly {
    event_type: string;
    tool_name: string | null;
    created_at: string;
    summary?: string | null;
    data?: string | null;
  }[];
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: readonly {
    model: string;
    created_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd_estimated: number | null;
    input_cost_usd_estimated: number | null;
    output_cost_usd_estimated: number | null;
    cache_read_cost_usd_estimated: number | null;
    cache_creation_cost_usd_estimated: number | null;
  }[];
  localPullRequests: readonly SqlitePullRequestRow[];
};

type TraceTimelineRow = {
  eventType: string;
  toolName: string | null;
  createdAt: string;
  label: string;
};

function buildGitDiffStats(
  row: SqliteGitLocRow | undefined
): Partial<SyncedAgentSession> {
  if (!row) {
    return {};
  }
  const added = Number(row.total_added);
  const removed = Number(row.total_removed);
  const files = Number(row.total_files);
  if (added === 0 && removed === 0 && files === 0) {
    return {};
  }
  return {
    gitDiffStats: {
      linesAdded: added,
      linesRemoved: removed,
      filesChanged: files,
      source: "git",
    },
  };
}

function buildBranchDiffStats(
  row: SqliteGitLocRow | undefined
): Partial<SyncedAgentSession> {
  if (!row) {
    return {};
  }
  const added = Number(row.total_added);
  const removed = Number(row.total_removed);
  const files = Number(row.total_files);
  if (added === 0 && removed === 0 && files === 0) {
    return {};
  }
  return {
    branchDiffStats: {
      linesAdded: added,
      linesRemoved: removed,
      filesChanged: files,
      source: "git",
    },
  };
}

const HIGH_CONFIDENCE_BRANCH_METHODS: ReadonlySet<string> = new Set(
  HIGH_CONFIDENCE_BRANCH_METHOD_VALUES
);

function resolveArtifactLinkBranch(
  linkRows: SqliteArtifactLinkRow[]
): string | null {
  let best: SqliteArtifactLinkRow | null = null;
  for (const link of linkRows) {
    if (link.target_kind !== "branch" || !link.branch_name) {
      continue;
    }
    if (!HIGH_CONFIDENCE_BRANCH_METHODS.has(link.method)) {
      continue;
    }
    if (
      !best ||
      (link.link_observed_at ?? "") > (best.link_observed_at ?? "")
    ) {
      best = link;
    }
  }
  return best?.branch_name ?? null;
}

function buildSessionTraceSyncFields(
  input: SessionTraceSyncInput
): Partial<SyncedAgentSession> {
  const {
    startedAt,
    updatedAt,
    endedAt,
    metadata,
    attribution,
    artifactLinkBranch,
    events,
    timelineRows,
    tokenEvents,
    localPullRequests,
  } = input;
  const artifacts = asSyncRecord(metadata?.artifacts);
  const diffStats = asSyncRecord(metadata?.diffStats);
  const issues = uniqueNonEmptyStrings([
    attribution?.issueId,
    ...extractArtifactIssueKeys(artifacts?.issues),
  ]);
  // FEA-1899: PRs come exclusively from artifact links (relation-aware).
  // The legacy metadata.artifacts.prs path is intentionally removed — it
  // carries "referenced" PRs (e.g. URLs in Read output) that aren't the
  // session's own work. Only 'created' and 'workspace' relations surface.
  const prs = mergeSessionPullRequests([
    ...localPullRequests.flatMap(localPullRequestToSessionPr),
  ]);
  const turns =
    numberFromMetadata(metadata?.userMessages) +
    numberFromMetadata(metadata?.assistantMessages);
  const durationFields = buildTraceDurationFields({
    startedAt,
    updatedAt,
    endedAt,
    timelineRows,
  });
  const activityFields = buildTraceActivityFields({
    startedAt,
    updatedAt,
    endedAt,
    timelineRows,
    tokenEvents,
  });
  const promptTimestamps = timelineRows
    .filter((row) => row.eventType === "UserMessage")
    .map((row) => row.createdAt);
  const activityTimestamps = [
    ...timelineRows.map((row) => row.createdAt),
    ...tokenEvents.map((event) => event.created_at),
  ];
  const sourceFields = fitSessionTraceSourcesToAggregateLimit({
    tracePhaseSources: extractTracePhaseSources(events),
    throttleSources: extractThrottleSources(events),
    correctionSources: extractCorrectionSources(events),
  });
  const presentation = deriveSessionTracePresentation({
    startedAt,
    updatedAt,
    endedAt,
    promptTimestamps,
    activityTimestamps,
    phaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
  });
  const markers = [
    ...(activityFields.markers ?? []),
    ...presentation.correctionMarkers,
  ];

  return {
    ...(artifactLinkBranch || metadata?.gitBranch || attribution?.baseBranch
      ? {
          branch:
            artifactLinkBranch ??
            stringFromMetadata(metadata?.gitBranch) ??
            attribution?.baseBranch ??
            null,
        }
      : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(prs.length > 0 ? { prs } : {}),
    ...durationFields,
    ...activityFields,
    ...(diffStats?.linesAdded === undefined
      ? {}
      : { linesAdded: numberFromMetadata(diffStats.linesAdded) }),
    ...(diffStats?.linesRemoved === undefined
      ? {}
      : { linesRemoved: numberFromMetadata(diffStats.linesRemoved) }),
    ...(diffStats?.filesChanged === undefined
      ? {}
      : { filesChanged: numberFromMetadata(diffStats.filesChanged) }),
    ...(turns > 0 ? { turns } : {}),
    steeringEpisodes: presentation.steeringEpisodes,
    autonomy: presentation.autonomy,
    tracePhaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
    phases: presentation.phases,
    phaseIterations: presentation.phaseIterations,
    phaseLoopbacks: presentation.phaseLoopbacks,
    throttles: presentation.throttles,
    markers,
  };
}

function buildTraceTimelineRows(
  metadata: Record<string, unknown> | null,
  events: SessionTraceSyncInput["events"]
): TraceTimelineRow[] {
  const rows: TraceTimelineRow[] = [];
  const rawMessages = Array.isArray(metadata?.messages)
    ? metadata.messages
    : [];
  for (const rawMessage of rawMessages) {
    const message = asSyncRecord(rawMessage);
    const timestamp = stringFromMetadata(message?.timestamp);
    const role = stringFromMetadata(message?.role);
    if (!(timestamp && role)) {
      continue;
    }
    rows.push({
      eventType: traceMessageEventType(role),
      toolName: null,
      createdAt: timestamp,
      label:
        role === "human"
          ? "Prompt"
          : (stringFromMetadata(message?.model) ?? role),
    });
  }
  for (const event of events) {
    rows.push({
      eventType: event.event_type,
      toolName: event.tool_name,
      createdAt: event.created_at,
      label: event.tool_name ?? event.summary ?? event.event_type,
    });
  }
  return rows.sort((left, right) => {
    const byTime = parseIsoMs(left.createdAt) - parseIsoMs(right.createdAt);
    if (byTime !== 0) {
      return byTime;
    }
    return traceRowOrder(left) - traceRowOrder(right);
  });
}

function traceMessageEventType(role: string): string {
  if (role === "human") {
    return "UserMessage";
  }
  if (role === "assistant") {
    return "AssistantMessage";
  }
  return "SystemMessage";
}

function extractTracePhaseSources(
  events: SessionTraceSyncInput["events"]
): SessionTracePhaseSource[] {
  return events
    .flatMap((event): SessionTracePhaseSource[] => {
      const data = asSyncRecord(parseJsonValueText(event.data ?? null));
      const eventType = event.event_type.toLowerCase();
      if (!SESSION_TRACE_PHASE_EVENT_RE.test(eventType)) {
        return [];
      }
      const phaseKey =
        sourceTextFromMetadata(data?.phaseKey) ??
        sourceTextFromMetadata(data?.phase) ??
        sourceTextFromMetadata(data?.name);
      const label = sourceTextFromMetadata(data?.label) ?? phaseKey;
      const startedAt = validSourceDate(
        stringFromMetadata(data?.startedAt) ?? event.created_at
      );
      const endedAt = optionalValidSourceDate(data?.endedAt);
      if (!(phaseKey && label && startedAt) || endedAt === undefined) {
        return [];
      }
      return [
        {
          sourceType: eventType.includes("loop.perf")
            ? SessionTracePhaseSourceType.LoopPerf
            : SessionTracePhaseSourceType.Explicit,
          phaseKey,
          label,
          startedAt,
          endedAt,
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.phaseSources);
}

function extractThrottleSources(
  events: SessionTraceSyncInput["events"]
): SessionTraceThrottleSource[] {
  return events
    .flatMap((event): SessionTraceThrottleSource[] => {
      const data = asSyncRecord(parseJsonValueText(event.data ?? null));
      const eventType = event.event_type.toLowerCase();
      if (!SESSION_TRACE_THROTTLE_EVENT_RE.test(eventType)) {
        return [];
      }
      const statusCode = optionalNumberFromMetadata(data?.statusCode);
      const provider =
        sourceTextFromMetadata(data?.provider) ??
        sourceTextFromMetadata(data?.service) ??
        "unknown";
      const observedAt = validSourceDate(
        stringFromMetadata(data?.observedAt) ?? event.created_at
      );
      const resetAt = optionalValidSourceDate(data?.resetAt);
      if (!(provider && observedAt) || resetAt === undefined) {
        return [];
      }
      return [
        {
          sourceType: throttleSourceType(eventType, statusCode, data),
          provider,
          observedAt,
          limitKind: sourceTextFromMetadata(data?.limitKind ?? data?.type),
          statusCode: statusCode ?? null,
          errorCode: sourceTextFromMetadata(data?.errorCode ?? data?.code),
          resetAt,
          retryAfterSeconds: optionalNumberFromMetadata(
            data?.retryAfterSeconds
          ),
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.throttleSources);
}

function throttleSourceType(
  eventType: string,
  statusCode: number | null,
  data: Record<string, unknown> | null
): SessionTraceThrottleSource["sourceType"] {
  if (eventType.includes("usage_limit")) {
    return SessionTraceThrottleSourceType.UsageLimit;
  }
  if (statusCode === 429) {
    return SessionTraceThrottleSourceType.ApiError;
  }
  if (data?.rate_limits) {
    return SessionTraceThrottleSourceType.TokenSnapshot;
  }
  return SessionTraceThrottleSourceType.ProviderRateLimit;
}

function extractCorrectionSources(
  events: SessionTraceSyncInput["events"]
): SessionTraceCorrectionSource[] {
  return events
    .flatMap((event): SessionTraceCorrectionSource[] => {
      const data = asSyncRecord(parseJsonValueText(event.data ?? null));
      const kind = correctionKind(event.event_type, data);
      const observedAt = validSourceDate(
        stringFromMetadata(data?.observedAt) ?? event.created_at
      );
      const sourceType = sourceTextFromMetadata(event.event_type);
      if (!kind) {
        return [];
      }
      if (!(observedAt && sourceType)) {
        return [];
      }
      return [
        {
          kind,
          observedAt,
          label:
            sourceTextFromMetadata(event.summary) ??
            sourceTextFromMetadata(data?.label) ??
            kind,
          sourceType,
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.correctionSources);
}

function correctionKind(
  eventType: string,
  data: Record<string, unknown> | null | undefined
): SessionTraceCorrectionSource["kind"] | null {
  const normalized = eventType.toLowerCase();
  if (!SESSION_TRACE_CORRECTION_EVENT_RE.test(normalized)) {
    return null;
  }
  const rawKind = stringFromMetadata(data?.kind)?.toLowerCase();
  if (
    normalized.includes("manual_regression") ||
    rawKind === "manual_regression"
  ) {
    return SessionTraceCorrectionKind.ManualRegression;
  }
  if (
    normalized.includes("change_request") ||
    normalized.includes("review_requested_changes") ||
    rawKind === "review_change_request"
  ) {
    return SessionTraceCorrectionKind.ReviewChangeRequest;
  }
  if (normalized.includes("approval_denied") || rawKind === "approval_denied") {
    return SessionTraceCorrectionKind.ApprovalDenied;
  }
  if (
    normalized.includes("negative_feedback") ||
    rawKind === "negative_feedback"
  ) {
    return SessionTraceCorrectionKind.NegativeFeedback;
  }
  if (normalized.includes("correction") || rawKind === "explicit_correction") {
    return SessionTraceCorrectionKind.ExplicitCorrection;
  }
  return null;
}

function sourceTextFromMetadata(value: unknown): string | null {
  const text = stringFromMetadata(value);
  if (!text) {
    return null;
  }
  return text.slice(0, SESSION_TRACE_SOURCE_LIMITS.sourceText);
}

function validSourceDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function optionalValidSourceDate(value: unknown): string | null | undefined {
  const text = stringFromMetadata(value);
  if (!text) {
    return null;
  }
  return validSourceDate(text) ?? undefined;
}

function fitSessionTraceSourcesToAggregateLimit(input: {
  tracePhaseSources: SessionTracePhaseSource[];
  throttleSources: SessionTraceThrottleSource[];
  correctionSources: SessionTraceCorrectionSource[];
}): {
  tracePhaseSources: SessionTracePhaseSource[];
  throttleSources: SessionTraceThrottleSource[];
  correctionSources: SessionTraceCorrectionSource[];
} {
  const output = {
    tracePhaseSources: [...input.tracePhaseSources],
    throttleSources: [...input.throttleSources],
    correctionSources: [...input.correctionSources],
  };
  while (
    Buffer.byteLength(JSON.stringify(output)) >
    SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes
  ) {
    if (output.correctionSources.pop()) {
      continue;
    }
    if (output.throttleSources.pop()) {
      continue;
    }
    if (output.tracePhaseSources.pop()) {
      continue;
    }
    break;
  }
  return output;
}

function buildTraceDurationFields(input: {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  timelineRows: readonly TraceTimelineRow[];
}): Pick<SyncedAgentSession, "activeAgent" | "waitingUser" | "wallClock"> {
  const startMs = parseIsoMs(input.startedAt);
  const endMs = parseIsoMs(input.endedAt ?? input.updatedAt);
  const fields: Pick<
    SyncedAgentSession,
    "activeAgent" | "waitingUser" | "wallClock"
  > = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    fields.wallClock = formatTraceDuration(endMs - startMs);
  }
  const timingRows = input.timelineRows.map((row) => ({
    eventType: row.eventType,
    createdAt: row.createdAt,
  }));
  const timing = computeSessionTiming(timingRows);
  if (timing.activeAgentMs > 0) {
    fields.activeAgent = formatTraceDuration(timing.activeAgentMs);
  }
  if (timing.waitingUserMs > 0) {
    fields.waitingUser = `${formatTraceDuration(timing.waitingUserMs)} idle`;
  }
  return fields;
}

function buildTraceActivityFields(input: {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: SessionTraceSyncInput["tokenEvents"];
}): Pick<SyncedAgentSession, "activityBuckets" | "markers" | "span"> {
  const startMs = parseIsoMs(input.startedAt);
  const endMs = parseIsoMs(input.endedAt ?? input.updatedAt);
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return {};
  }
  const durationMs = Math.max(1, endMs - startMs);
  const bucketCount = Math.max(
    1,
    Math.min(
      SESSION_TRACE_BUCKET_TARGET,
      Math.ceil(durationMs / (5 * 60 * 1000))
    )
  );
  const bucketMs = durationMs / bucketCount;
  const buckets: ActivityBucket[] = Array.from(
    { length: bucketCount },
    (_, index) => ({
      label: formatTraceClockOffset(Math.round(index * bucketMs)),
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {},
    })
  );

  input.timelineRows.forEach((row, index) => {
    const bucket =
      buckets[bucketIndex(row.createdAt, startMs, bucketMs, bucketCount)];
    if (!bucket) {
      return;
    }
    bucket.total += 1;
    if (row.toolName) {
      bucket.toolStart += 1;
    }
    bucket.tl0 ??= index;
  });

  for (const tokenEvent of input.tokenEvents) {
    const bucket =
      buckets[
        bucketIndex(tokenEvent.created_at, startMs, bucketMs, bucketCount)
      ];
    if (!bucket) {
      continue;
    }
    const storedInputCost = nullableNumber(tokenEvent.input_cost_usd_estimated);
    const storedOutputCost = nullableNumber(
      tokenEvent.output_cost_usd_estimated
    );
    const storedCacheReadCost = nullableNumber(
      tokenEvent.cache_read_cost_usd_estimated
    );
    const storedCacheCreationCost = nullableNumber(
      tokenEvent.cache_creation_cost_usd_estimated
    );
    const inputTokens = tokenCountValue(
      tokenEvent.input_tokens,
      "timeline.input"
    );
    const outputTokens = tokenCountValue(
      tokenEvent.output_tokens,
      "timeline.output"
    );
    const cacheReadTokens = tokenCountValue(
      tokenEvent.cache_read_tokens,
      "timeline.cache_read"
    );
    const cacheWriteTokens = tokenCountValue(
      tokenEvent.cache_write_tokens,
      "timeline.cache_write"
    );
    const fallbackInput =
      storedInputCost == null &&
      storedOutputCost == null &&
      storedCacheReadCost == null &&
      storedCacheCreationCost == null
        ? {
            model: tokenEvent.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            observedAt: tokenEvent.created_at,
          }
        : undefined;
    const fallbackCost = fallbackInput
      ? estimateTokenCost(fallbackInput)
      : undefined;
    if (fallbackInput && !fallbackCost) {
      reportTokenCostPricingMiss(fallbackInput, "trace_activity");
    }
    const inputCost = storedInputCost ?? fallbackCost?.inputCostUsd ?? 0;
    const outputCost = storedOutputCost ?? fallbackCost?.outputCostUsd ?? 0;
    const cacheCost =
      (storedCacheReadCost ?? 0) +
      (storedCacheCreationCost ?? 0) +
      (fallbackCost?.cacheCostUsd ?? 0);
    bucket.cIn += inputCost;
    bucket.cOut += outputCost;
    bucket.cCache += cacheCost;
    const byModel = bucket.byModel[tokenEvent.model] ?? {
      cIn: 0,
      cOut: 0,
      cCache: 0,
    };
    byModel.cIn += inputCost;
    byModel.cOut += outputCost;
    byModel.cCache += cacheCost;
    bucket.byModel[tokenEvent.model] = byModel;
  }

  const markers = buildTraceMarkers(input.timelineRows, startMs, durationMs);
  return {
    activityBuckets: buckets.map(roundActivityBucket),
    span: {
      first: formatTraceClockOffset(0),
      last: formatTraceClockOffset(durationMs),
    },
    ...(markers.length > 0 ? { markers } : {}),
  };
}

function buildTraceMarkers(
  rows: readonly TraceTimelineRow[],
  startMs: number,
  durationMs: number
): SessionMarker[] {
  return rows.flatMap((row, index): SessionMarker[] => {
    const kind = traceMarkerKind(row);
    if (!kind) {
      return [];
    }
    const rowMs = parseIsoMs(row.createdAt);
    const x = Number.isFinite(rowMs)
      ? Math.max(0, Math.min(100, ((rowMs - startMs) / durationMs) * 100))
      : 0;
    return [
      {
        kind,
        x: roundNumber(x),
        t: Number.isFinite(rowMs)
          ? formatTraceClockOffset(rowMs - startMs)
          : row.createdAt,
        label: row.label,
        tl: index,
      },
    ];
  });
}

function traceMarkerKind(row: TraceTimelineRow): SessionMarker["kind"] | null {
  const eventType = row.eventType.toLowerCase();
  const label = row.label.toLowerCase();
  if (eventType.includes("user") || eventType.includes("prompt")) {
    return "prompt";
  }
  if (eventType.includes("error") || eventType.includes("fail")) {
    return "fail";
  }
  if (eventType.includes("git") || label.includes("commit")) {
    return "commit";
  }
  if (label.includes("pull request") || label.includes("/pull/")) {
    return "pr";
  }
  return null;
}

function traceRowOrder(row: TraceTimelineRow): number {
  if (row.eventType === "UserMessage") {
    return 0;
  }
  if (row.eventType === "AssistantMessage") {
    return 1;
  }
  if (row.toolName) {
    return 2;
  }
  return 3;
}

function formatTraceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatTraceClockOffset(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function bucketIndex(
  createdAt: string,
  startMs: number,
  bucketMs: number,
  bucketCount: number
): number {
  const eventMs = parseIsoMs(createdAt);
  if (!Number.isFinite(eventMs)) {
    return 0;
  }
  const index = Math.floor((eventMs - startMs) / bucketMs);
  return Math.max(0, Math.min(bucketCount - 1, index));
}

function roundActivityBucket(bucket: ActivityBucket): ActivityBucket {
  const byModel = Object.fromEntries(
    Object.entries(bucket.byModel).map(([model, costs]) => [
      model,
      {
        cIn: roundCostNumber(costs.cIn),
        cOut: roundCostNumber(costs.cOut),
        cCache: roundCostNumber(costs.cCache),
      },
    ])
  );
  return {
    ...bucket,
    cIn: roundCostNumber(bucket.cIn),
    cOut: roundCostNumber(bucket.cOut),
    cCache: roundCostNumber(bucket.cCache),
    byModel,
  };
}

function roundCostNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function nullableNumber(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asSyncRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFromMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberFromMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  return [
    ...new Set(values.map(stringFromMetadata).filter(Boolean)),
  ] as string[];
}

function extractArtifactIssueKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const issue = asSyncRecord(item);
        const key = issue ? stringFromMetadata(issue.key) : null;
        return key ? [key] : [];
      })
    : [];
}

function localPullRequestToSessionPr(
  row: SqlitePullRequestRow
): SessionPrWithIdentity[] {
  if (row.pr_number == null) {
    return [];
  }
  return [
    {
      ...sessionPrWithLifecycle({
        num: row.pr_number,
        title: row.title,
        status: null,
        prState: row.state,
        closedAt: row.closed_at,
        mergedAt: row.merged_at,
      }),
      repositoryFullName: row.repo_full_name,
    },
  ];
}

function mergeSessionPullRequests(prs: SessionPrWithIdentity[]): SessionPR[] {
  const byIdentity = new Map<string, SessionPrWithIdentity>();
  for (const pr of prs) {
    const normalizedNumber = String(pr.num).trim();
    const identityKey = sessionPullRequestIdentityKey(
      pr.repositoryFullName,
      normalizedNumber
    );
    const legacyKey = sessionPullRequestIdentityKey(null, normalizedNumber);
    if (stringFromMetadata(pr.repositoryFullName)) {
      byIdentity.delete(legacyKey);
    } else if (hasRepositoryScopedSessionPr(byIdentity, normalizedNumber)) {
      continue;
    }
    byIdentity.set(identityKey, pr);
  }
  return [...byIdentity.values()].map(stripSessionPrIdentity);
}

function sessionPullRequestIdentityKey(
  repositoryFullName: string | null | undefined,
  prNumber: number | string
): string {
  const normalizedRepository =
    stringFromMetadata(repositoryFullName)?.toLowerCase();
  const normalizedNumber = String(prNumber).trim();
  return normalizedRepository
    ? `${normalizedRepository}#${normalizedNumber}`
    : `legacy#${normalizedNumber}`;
}

function hasRepositoryScopedSessionPr(
  prs: Map<string, SessionPrWithIdentity>,
  normalizedNumber: string
): boolean {
  for (const key of prs.keys()) {
    if (
      key !== `legacy#${normalizedNumber}` &&
      key.endsWith(`#${normalizedNumber}`)
    ) {
      return true;
    }
  }
  return false;
}

function stripSessionPrIdentity(pr: SessionPrWithIdentity): SessionPR {
  const { repositoryFullName: _repositoryFullName, ...sessionPr } = pr;
  return sessionPr;
}

async function selectRowsByIds<T extends Record<string, unknown>>(
  db: SqliteExecutor,
  sql: string,
  ids: string[]
): Promise<T[]> {
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  const result = await db.query<T>(
    sql.replaceAll("__IDS__", placeholders),
    ids
  );
  return result.rows;
}

function groupRowsBySessionId<T extends { session_id: string }>(
  rows: T[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.session_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.session_id, [row]);
    }
  }
  return grouped;
}

/**
 * FEA-1684: Query local SQLite for per-artifact session usage (token totals,
 * session count, estimated cost). Returns zero-valued entries for slugs with
 * no linked sessions so callers always get a result for every input slug.
 *
 * Cost is summed from persisted token_usage estimates; missing estimates
 * contribute zero at this numeric summary boundary.
 */
export async function getArtifactSessionUsage(
  prisma: DesktopPrisma,
  slugs: string[]
): Promise<LocalArtifactSessionUsage[]> {
  if (slugs.length === 0) {
    return [];
  }
  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(", ");

  // Session counts per slug (COUNT DISTINCT session_id).
  const countRows = await prisma.client.$queryRawUnsafe<
    {
      slug: string;
      session_count: string;
    }[]
  >(
    `
      SELECT a.slug, COUNT(DISTINCT sal.session_id) AS session_count
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      WHERE a.kind = 'closedloop_artifact'
        AND a.slug IN (${placeholders})
      GROUP BY a.slug
    `,
    ...slugs
  );

  // Token totals per (slug, model) — needed for per-model cost computation.
  const modelRows = await prisma.client.$queryRawUnsafe<
    {
      slug: string;
      model: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_usd_estimated: string | null;
      unpriced_input_tokens: string | null;
      unpriced_output_tokens: string | null;
      unpriced_cache_read_tokens: string | null;
      unpriced_cache_write_tokens: string | null;
    }[]
  >(
    `
      SELECT
        a.slug,
        tu.model,
        COALESCE(SUM(tu.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tu.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(tu.cache_write_tokens), 0) AS cache_write_tokens,
        SUM(tu.cost_usd_estimated) AS cost_usd_estimated,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.input_tokens, 0) ELSE 0 END) AS unpriced_input_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.output_tokens, 0) ELSE 0 END) AS unpriced_output_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_read_tokens, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
        SUM(CASE WHEN tu.cost_usd_estimated IS NULL THEN COALESCE(tu.cache_write_tokens, 0) ELSE 0 END) AS unpriced_cache_write_tokens
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      JOIN token_usage tu ON tu.session_id = sal.session_id
      WHERE a.kind = 'closedloop_artifact'
        AND a.slug IN (${placeholders})
      GROUP BY a.slug, tu.model
    `,
    ...slugs
  );

  const sessionCountBySlug = new Map(
    countRows.map((r) => [r.slug, Number(r.session_count)])
  );

  // Group model rows by slug, aggregate tokens + cost.
  const modelRowsBySlug = new Map<string, typeof modelRows>();
  for (const row of modelRows) {
    const existing = modelRowsBySlug.get(row.slug);
    if (existing) {
      existing.push(row);
    } else {
      modelRowsBySlug.set(row.slug, [row]);
    }
  }

  return slugs.map((slug) => {
    const sessionCount = sessionCountBySlug.get(slug) ?? 0;
    const rows = modelRowsBySlug.get(slug);
    if (!rows || rows.length === 0) {
      return {
        artifactSlug: slug,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      };
    }
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCostUsd = 0;
    for (const r of rows) {
      const input = tokenCountValue(r.input_tokens, "artifact.input");
      const output = tokenCountValue(r.output_tokens, "artifact.output");
      const cacheRead = tokenCountValue(
        r.cache_read_tokens,
        "artifact.cache_read"
      );
      const cacheWrite = tokenCountValue(
        r.cache_write_tokens,
        "artifact.cache_write"
      );
      totalInput = addStorageTokenCounts(totalInput, input, "artifact.input");
      totalOutput = addStorageTokenCounts(
        totalOutput,
        output,
        "artifact.output"
      );
      totalCacheRead = addStorageTokenCounts(
        totalCacheRead,
        cacheRead,
        "artifact.cache_read"
      );
      totalCacheWrite = addStorageTokenCounts(
        totalCacheWrite,
        cacheWrite,
        "artifact.cache_write"
      );
      totalCostUsd +=
        Number(r.cost_usd_estimated ?? 0) +
        (resolveTokenUsageCostUsd({
          session_id: "",
          model: r.model,
          input_tokens: tokenCountValue(
            r.unpriced_input_tokens,
            "artifact.unpriced_input"
          ),
          output_tokens: tokenCountValue(
            r.unpriced_output_tokens,
            "artifact.unpriced_output"
          ),
          cache_read_tokens: tokenCountValue(
            r.unpriced_cache_read_tokens,
            "artifact.unpriced_cache_read"
          ),
          cache_write_tokens: tokenCountValue(
            r.unpriced_cache_write_tokens,
            "artifact.unpriced_cache_write"
          ),
          cost_usd_estimated: null,
        }) ?? 0);
    }
    return {
      artifactSlug: slug,
      sessionCount,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      estimatedCostUsd: totalCostUsd,
    };
  });
}

async function loadSqliteMeteredUsageRows(
  db: SqliteClient,
  cutoffIso: string
): Promise<MeteredUsageRow[]> {
  const result = await db.query<{
    session_id: string;
    started_at: string;
    billing_mode: string | null;
    harness: string | null;
    model: string;
    input_tokens: unknown;
    output_tokens: unknown;
    cache_read_tokens: unknown;
    cache_write_tokens: unknown;
  }>(
    `
      SELECT
        s.id AS session_id,
        s.started_at AS started_at,
        s.billing_mode AS billing_mode,
        s.harness AS harness,
        tu.model AS model,
        tu.input_tokens AS input_tokens,
        tu.output_tokens AS output_tokens,
        tu.cache_read_tokens AS cache_read_tokens,
        tu.cache_write_tokens AS cache_write_tokens
      FROM token_usage tu
      JOIN sessions s ON s.id = tu.session_id
      WHERE s.started_at >= $1
      ORDER BY s.started_at ASC, tu.model ASC
    `,
    [cutoffIso]
  );
  const out: MeteredUsageRow[] = [];
  for (const row of result.rows) {
    const billingMode = resolveBillingMode({
      billingMode: row.billing_mode,
      harness: row.harness,
    });
    if (!isMeteredApi(billingMode)) {
      continue;
    }
    out.push({
      sessionId: row.session_id,
      model: row.model,
      startedAt: row.started_at,
      billingMode,
      inputTokens: tokenCountValue(row.input_tokens, "metered.input"),
      outputTokens: tokenCountValue(row.output_tokens, "metered.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "metered.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "metered.cache_write"
      ),
    });
  }
  return out;
}

// Per-session aggregate CTEs (agent/event counts + token totals) the detail
// reads LEFT-JOIN onto the filtered/paginated session set in a single query.
function sessionDetailsCtes(): string {
  return `
    WITH agent_counts AS (
      SELECT session_id, COUNT(*) as agent_count
      FROM agents
      GROUP BY session_id
    ),
    event_counts AS (
      SELECT session_id, COUNT(*) as event_count
      FROM events
      GROUP BY session_id
    ),
    token_totals AS (
      SELECT
        session_id,
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens
      FROM token_usage
      GROUP BY session_id
    )
  `;
}

function toSessionRow(
  raw: Record<string, unknown> | undefined
): SessionRow | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? null,
    status: raw.status as string,
    cwd: (raw.cwd as string) ?? null,
    model: (raw.model as string) ?? null,
    startedAt: (raw.started_at as string) ?? null,
    updatedAt: (raw.updated_at as string) ?? null,
    endedAt: (raw.ended_at as string) ?? null,
    awaitingInputSince: (raw.awaiting_input_since as string) ?? null,
    metadata: (raw.metadata as string) ?? null,
    harness: (raw.harness as string) ?? null,
    billingMode: (raw.billing_mode as string) ?? null,
    userId: (raw.user_id as string) ?? null,
    organizationId: (raw.organization_id as string) ?? null,
  };
}

function toTokenUsageRow(raw: Record<string, unknown>): TokenUsageRow {
  const inputTokens = tokenCountValue(
    raw.input_tokens,
    "token_usage.input_tokens"
  );
  const outputTokens = tokenCountValue(
    raw.output_tokens,
    "token_usage.output_tokens"
  );
  const cacheReadTokens = tokenCountValue(
    raw.cache_read_tokens,
    "token_usage.cache_read_tokens"
  );
  const cacheWriteTokens = tokenCountValue(
    raw.cache_write_tokens,
    "token_usage.cache_write_tokens"
  );
  const estimatedCostUsd = resolveTokenUsageCostUsd({
    session_id: raw.session_id as string,
    model: raw.model as string,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    created_at: (raw.created_at as string) ?? null,
    cost_usd_estimated: (raw.cost_usd_estimated as number) ?? null,
  });
  return {
    sessionId: raw.session_id as string,
    model: raw.model as string,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

// Maps the detail-read CTE rows (session columns + aggregate counts) to
// SessionWithAgents, coercing the COUNT/SUM columns (the raw path may surface
// them as bigint) at the Number()/token() boundary.
function detailRowsToList(
  raws: Record<string, unknown>[]
): SessionWithAgents[] {
  return raws.map((raw) => {
    const base = toSessionRow(raw)!;
    return {
      ...base,
      agentCount: Number(raw.agent_count ?? 0),
      eventCount: Number(raw.event_count ?? 0),
      totalTokens: tokenCountValue(raw.total_tokens, "session.total_tokens"),
    };
  });
}

function mainAgentId(sessionId: string): string {
  return `${sessionId}-main`;
}

async function getSession(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<SessionRowRaw | undefined> {
  const rows = await tx.$queryRawUnsafe<SessionRowRaw[]>(
    "SELECT id, status, harness, billing_mode, model FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0];
}

async function getImportSession(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<
  { id: string; status: string; ended_at: string | null } | undefined
> {
  const rows = await tx.$queryRawUnsafe<
    {
      id: string;
      status: string;
      ended_at: string | null;
    }[]
  >("SELECT id, status, ended_at FROM sessions WHERE id = $1", sessionId);
  return rows[0];
}

async function getAgent(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<AgentRowRaw | undefined> {
  const rows = await tx.$queryRawUnsafe<AgentRowRaw[]>(
    "SELECT id, status, type, parent_agent_id FROM agents WHERE id = $1",
    agentId
  );
  return rows[0];
}

async function ensureSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData,
  harness: string,
  now: string,
  detectBillingMode: (harness: string) => string,
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null
): Promise<void> {
  if (await getSession(tx, sessionId)) {
    return;
  }
  const billingMode = safe(() => detectBillingMode(harness)) ?? "unknown";
  const identity = safe(() => getUserIdentity?.()) ?? null;
  await tx.$executeRawUnsafe(
    `INSERT INTO sessions (
       id, name, status, cwd, model, started_at, updated_at, harness,
       billing_mode, user_id, organization_id, data_revision
     )
     VALUES ($1, $2, 'active', $3, $4, $5, $5, $6, $7, $8, $9, $10)`,
    sessionId,
    data.session_name ?? null,
    data.cwd ?? null,
    data.model ?? null,
    now,
    harness,
    billingMode,
    identity?.userId ?? null,
    identity?.organizationId ?? null,
    DATA_REVISION
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, parent_agent_id, metadata)
     VALUES ($1, $2, 'main', 'main', NULL, 'working', NULL, NULL, $3, $3, NULL, NULL)`,
    mainAgentId(sessionId),
    sessionId,
    now
  );
}

async function clearAwaitingInput(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET awaiting_input_since = NULL, updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );
  await tx.$executeRawUnsafe(
    "UPDATE agents SET awaiting_input_since = NULL, updated_at = $1 WHERE session_id = $2 AND awaiting_input_since IS NOT NULL",
    now,
    sessionId
  );
}

async function setMainWaiting(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET awaiting_input_since = $1, updated_at = $1 WHERE id = $2",
    now,
    sessionId
  );
  await tx.$executeRawUnsafe(
    "UPDATE agents SET awaiting_input_since = $1, status = 'waiting', updated_at = $1 WHERE id = $2",
    now,
    mainAgentId(sessionId)
  );
}

async function promoteMain(
  tx: Prisma.TransactionClient,
  main: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET status = 'working', awaiting_input_since = NULL, updated_at = $1 WHERE id = $2 AND status != 'working'",
    now,
    main
  );
}

async function setAgentTool(
  tx: Prisma.TransactionClient,
  agentId: string,
  toolName: string | null,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET current_tool = $1, status = 'working', updated_at = $2 WHERE id = $3",
    toolName,
    now,
    agentId
  );
}

async function setAgentStatus(
  tx: Prisma.TransactionClient,
  agentId: string,
  status: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE agents SET status = $1, updated_at = $2, ended_at = $2 WHERE id = $3",
    status,
    now,
    agentId
  );
}

async function setSessionStatus(
  tx: Prisma.TransactionClient,
  sessionId: string,
  status: string,
  now: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET status = $1, updated_at = $2, ended_at = $2 WHERE id = $3",
    status,
    now,
    sessionId
  );
}

async function insertEvent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  agentId: string | null,
  eventType: string,
  data: HookData,
  now: string,
  summary?: string
): Promise<void> {
  const toolName = data.tool_name ?? null;
  const discriminator =
    typeof data.tool_use_id === "string" ? data.tool_use_id : null;
  await tx.$executeRawUnsafe(
    "INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
    deterministicEventId(sessionId, eventType, now, toolName, discriminator),
    sessionId,
    agentId,
    eventType,
    toolName,
    summary ?? null,
    importEventData(data),
    now
  );
}

async function maybeReactivate(
  tx: Prisma.TransactionClient,
  session: SessionRowRaw,
  hookType: string,
  now: string
): Promise<void> {
  if (
    session.status === DESKTOP_SESSION_STATUS.ACTIVE ||
    hookType === "SessionEnd"
  ) {
    return;
  }
  const isUserActivity =
    hookType === "UserPromptSubmit" || hookType === "PreToolUse";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const reactivate =
    isUserActivity ||
    (!isStopLike && session.status !== DESKTOP_SESSION_STATUS.ERROR) ||
    (isStopLike &&
      (session.status === DESKTOP_SESSION_STATUS.COMPLETED ||
        session.status === DESKTOP_SESSION_STATUS.ABANDONED));
  if (reactivate) {
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET status = 'active', updated_at = $1, ended_at = NULL WHERE id = $2",
      now,
      session.id
    );
    await promoteMain(tx, mainAgentId(session.id), now);
    session.status = DESKTOP_SESSION_STATUS.ACTIVE;
  }
}

async function spawnSubagent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData,
  now: string
): Promise<string> {
  const input = (data.tool_input as Record<string, unknown> | undefined) ?? {};
  const description = strOf(input.description) ?? strOf(data.description);
  const subagentType = strOf(input.subagent_type) ?? strOf(data.subagent_type);
  const prompt = strOf(input.prompt) ?? strOf(data.prompt);
  const name =
    description ??
    subagentType ??
    (prompt ? prompt.split("\n")[0].slice(0, 60) : undefined) ??
    "Subagent";
  let parentId = mainAgentId(sessionId);
  const main = await getAgent(tx, parentId);
  if (main?.status !== DESKTOP_AGENT_STATUS.WORKING) {
    // RAW (named blocker: recursive CTE) — find the deepest working subagent.
    const deepest = await tx.$queryRawUnsafe<{ id: string }[]>(
      `
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM agents WHERE session_id = $1 AND parent_agent_id IS NULL
        UNION ALL
        SELECT a.id, c.depth + 1 FROM agents a JOIN chain c ON a.parent_agent_id = c.id
      )
      SELECT a.id AS id FROM chain c JOIN agents a ON a.id = c.id
      WHERE a.status = 'working' AND a.type = 'subagent'
      ORDER BY c.depth DESC, a.started_at DESC LIMIT 1
    `,
      sessionId
    );
    if (deepest[0]) {
      parentId = deepest[0].id;
    }
  }
  const agentId = `${sessionId}-sub-${randomUUID().slice(0, 8)}`;
  await tx.$executeRawUnsafe(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, parent_agent_id, metadata)
     VALUES ($1, $2, $3, 'subagent', $4, 'working', $5, NULL, $6, $6, $7, NULL)`,
    agentId,
    sessionId,
    name,
    subagentType ?? null,
    prompt ? prompt.slice(0, 500) : null,
    now,
    parentId
  );
  return agentId;
}

async function matchSubagent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  data: HookData
): Promise<string | null> {
  const candidates = await tx.$queryRawUnsafe<
    {
      id: string;
      name: string | null;
      subagent_type: string | null;
      task: string | null;
    }[]
  >(
    "SELECT id, name, subagent_type, task FROM agents WHERE session_id = $1 AND type = 'subagent' AND status = 'working' ORDER BY started_at DESC",
    sessionId
  );
  if (candidates.length === 0) {
    return null;
  }
  const prefix =
    strOf(data.description) ??
    strOf(data.agent_type) ??
    strOf(data.subagent_type);
  if (prefix) {
    const byName = candidates.find((a) => a.name?.startsWith(prefix));
    if (byName) {
      return byName.id;
    }
  }
  if (data.agent_type) {
    const byType = candidates.find((a) => a.subagent_type === data.agent_type);
    if (byType) {
      return byType.id;
    }
  }
  if (data.prompt) {
    const task = String(data.prompt).slice(0, 500);
    const byTask = candidates.find((a) => a.task === task);
    if (byTask) {
      return byTask.id;
    }
  }
  return candidates[0].id;
}

async function sweepStaleSessions(
  tx: Prisma.TransactionClient,
  currentSessionId: string,
  now: string,
  staleMinutes: number
): Promise<void> {
  const cutoff = new Date(
    new Date(now).valueOf() - staleMinutes * 60_000
  ).toISOString();
  const stale = await tx.$queryRawUnsafe<{ id: string }[]>(
    "SELECT id FROM sessions WHERE status = 'active' AND id != $1 AND updated_at < $2",
    currentSessionId,
    cutoff
  );
  for (const { id } of stale) {
    await tx.$executeRawUnsafe(
      "UPDATE agents SET status = 'completed', ended_at = $1, updated_at = $1 WHERE session_id = $2 AND status NOT IN ('completed', 'error')",
      now,
      id
    );
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET status = 'abandoned', ended_at = $1, updated_at = $1 WHERE id = $2",
      now,
      id
    );
  }
}

function buildImportMetadata(
  session: NormalizedSession,
  harness: Harness
): string {
  return JSON.stringify({
    version: session.version ?? null,
    slug: session.slug ?? null,
    gitBranch: session.gitBranch ?? null,
    userMessages: session.userMessages ?? 0,
    assistantMessages: session.assistantMessages ?? 0,
    entrypoint: session.entrypoint ?? harness,
    permissionMode: session.permissionMode ?? null,
    thinkingBlockCount: session.thinkingBlockCount ?? 0,
    teams: session.teams ?? [],
    plans: session.plans ?? [],
    usageExtras: session.usageExtras ?? {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
    },
    compactions: session.compactions ?? [],
    messages: session.messages ?? [],
    tokenSeries: session.tokenSeries ?? [],
    diffStats: session.diffStats ?? null,
    slashCommands: session.slashCommands ?? [],
    artifacts: session.artifacts ?? { prs: [], issues: [], repo: null },
  });
}

async function persistNormalizedPullRequests(
  tx: Prisma.TransactionClient,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  // `repo#number` → head branch, for PRs this session CREATED (per the artifact-
  // ref extractor, which records the branch active at `gh pr create` time). A PR
  // absent from this map was merely referenced and carries no head ref.
  createdPrHeadBranches: ReadonlyMap<string, string | null>
): Promise<number> {
  const artifacts = session.artifacts;
  const prs = Array.isArray(artifacts?.prs) ? artifacts.prs : [];
  if (prs.length === 0) {
    return 0;
  }

  let captured = 0;
  const defaultRepo = normalizeRepoFullName(artifacts?.repo);
  const observedAt = session.endedAt ?? session.startedAt ?? now;
  for (const pr of prs) {
    const fromUrl =
      typeof pr.url === "string" ? parseGitHubPrUrl(pr.url) : null;
    const prNumber = fromUrl?.number ?? numberFromUnknown(pr.number);
    const repoFullName =
      fromUrl?.repoFullName ?? normalizeRepoFullName(pr.repo) ?? defaultRepo;
    if (!(prNumber && repoFullName)) {
      continue;
    }
    const prUrl =
      pr.url ?? `https://github.com/${repoFullName}/pull/${prNumber}`;
    // Only a PR this session CREATED has a head branch we can trust — the branch
    // the user was on at `gh pr create` time, captured by the extractor. A merely-
    // referenced PR (someone else's, or one inspected via `gh pr view`) is absent
    // from the map and must NOT inherit this session's branch, or it is mis-filed
    // onto this branch in the Branches view and the branch↔PR link propagation
    // (both match on `pull_requests.branch_name`).
    const headBranch =
      createdPrHeadBranches.get(`${repoFullName}#${prNumber}`) ?? null;
    // Dual-write: PR detail goes into pull_requests (lifecycle store, feeds
    // FEA-1869 status observer); attribution goes into artifacts below.
    await upsertPullRequest(tx, {
      externalSessionId: session.sessionId,
      harness,
      prUrl,
      prNumber,
      repoFullName,
      branchName: headBranch,
      headSha: null,
      title: null,
    });

    // FEA-1899: PRs are canonical kind='pull_request' artifacts keyed by
    // identity_key. COALESCE-fill the descriptive fields and bump last_seen_at;
    // never touch enrichment columns. SQLite has no `xmax`, so distinguish a
    // fresh insert (counts as captured) from an ON CONFLICT update by probing
    // for the row first: absence ⇒ this upsert will insert ⇒ captured.
    const identityKey = computeIdentityKey({
      kind: "pull_request",
      repoFullName,
      prNumber,
    });
    const artifactId = artifactIdFromIdentityKey(identityKey);
    const existingArtifact = await tx.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM artifacts WHERE identity_key = $1",
      identityKey
    );
    const wasInserted = existingArtifact.length === 0;
    const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, branch_name,
          title, harness, url, observed_at, created_at, last_seen_at)
       VALUES ($1,$2,'pull_request',$3,$4,$5,$6,$7,$8,$9,$9,$9)
       ON CONFLICT(identity_key) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
         title = COALESCE(artifacts.title, EXCLUDED.title),
         harness = COALESCE(artifacts.harness, EXCLUDED.harness),
         url = COALESCE(artifacts.url, EXCLUDED.url),
         observed_at = COALESCE(artifacts.observed_at, EXCLUDED.observed_at)
       RETURNING id`,
      artifactId,
      identityKey,
      repoFullName,
      prNumber,
      headBranch,
      null,
      harness,
      prUrl,
      observedAt
    );
    const resolvedArtifactId = artifactRows[0]?.id ?? artifactId;
    // session.artifacts.prs is populated by collectArtifacts for ANY PR URL the
    // session touched (created OR merely referenced), so we cannot assert
    // 'created' here without corrupting attribution. The artifact-ref extractor
    // owns the created-vs-referenced distinction via tool-call evidence and runs
    // first (persistArtifactLinks above). Only add a conservative 'referenced'
    // link when the extractor did not already link this PR to the session.
    const linkId = artifactLinkId(
      session.sessionId,
      "pull_request",
      `${repoFullName}#${prNumber}`,
      "referenced"
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary,
          status, extractor_version, observed_at, created_at)
       SELECT $1,$2,$3,'referenced','normalized_pr','{}',0,'candidate',1,$4,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM session_artifact_links
         WHERE session_id = $2 AND artifact_id = $3
       )
       ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
      linkId,
      session.sessionId,
      resolvedArtifactId,
      observedAt
    );
    if (wasInserted) {
      captured++;
    }
  }
  return captured;
}

function importEventData(input: unknown): string | null {
  if (input == null) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return null;
  }
  if (text.length > MAX_EVENT_DATA_BYTES) {
    return JSON.stringify({ truncated: true, bytes: text.length });
  }
  return text;
}

function importToolEventData(toolUse: NormalizedToolUse): string | null {
  const input = asRecord(toolUse.input);
  const payload: Record<string, unknown> = input ? { ...input } : {};
  if (toolUse.skillName && !payload.skillName) {
    payload.skillName = toolUse.skillName;
  }
  if (toolUse.mcpServer && !payload.mcpServer) {
    payload.mcpServer = toolUse.mcpServer;
  }
  if (toolUse.mcpMethod && !payload.mcpMethod) {
    payload.mcpMethod = toolUse.mcpMethod;
  }
  if (toolUse.diffDelta && !payload.diffDelta) {
    payload.diffDelta = toolUse.diffDelta;
  }
  return Object.keys(payload).length > 0 ? importEventData(payload) : null;
}

function subagentName(tu: NormalizedToolUse): string {
  const input = (tu.input ?? {}) as Record<string, unknown>;
  const description = strOf(input.description);
  const subagentType = strOf(input.subagent_type);
  const prompt = strOf(input.prompt);
  return (
    description ??
    subagentType ??
    (prompt ? prompt.split("\n")[0].slice(0, 60) : undefined) ??
    "Subagent"
  );
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseGitHubPrUrl(
  value: string
): { repoFullName: string; number: number } | null {
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const [owner, repo, type, rawNumber] = parsed.pathname
      .split("/")
      .filter(Boolean);
    if (!(owner && repo && type === "pull")) {
      return null;
    }
    const number = numberFromUnknown(rawNumber);
    return number ? { repoFullName: `${owner}/${repo}`, number } : null;
  } catch {
    return null;
  }
}

function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return GITHUB_REPO_FULL_NAME_RE.test(normalized) ? normalized : null;
}

function packIdFromSkillName(name: string): string | null {
  const normalized = name.trim();
  const separatorIndex = normalized.search(/[/:]/);
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

function titleFromId(id: string): string {
  return (
    id
      .split(/[-_\s/]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || id
  );
}

function titleFromPlan(content: string): string {
  const firstLine =
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "Untitled plan";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function compareIsoDesc(a: string | null, b: string | null): number {
  const left = a ? Date.parse(a) : 0;
  const right = b ? Date.parse(b) : 0;
  return (
    (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0)
  );
}

function maxIso(a: string | null, b: string | null): string | null {
  return compareIsoDesc(a, b) <= 0 ? a : b;
}

function compareLastUsedThenName<
  T extends { name: string; lastUsedAt: string | null },
>(a: T, b: T): number {
  const byDate = compareIsoDesc(a.lastUsedAt, b.lastUsedAt);
  return byDate === 0 ? a.name.localeCompare(b.name) : byDate;
}

function truncate(
  value: string | null | undefined,
  max: number
): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function attachEstimatedCosts(
  prisma: DesktopPrisma,
  sessions: SessionWithAgents[]
): Promise<void> {
  if (sessions.length === 0) {
    return;
  }
  const ids = sessions.map((s) => s.id);
  // Typed reads on the single client: the per-session authoritative cost and the
  // token rows the cost-resolution helpers fold over. `tokenUsage.findMany` is the
  // typed form of the old selectTokenUsageRows; its BigInt columns map to the
  // snake_case SqliteTokenUsageRow shape and token()-coerce below.
  const costRows = await prisma.client.session.findMany({
    where: { id: { in: ids } },
    select: { id: true, costUsdEstimated: true },
  });
  const costBySession = new Map(
    costRows
      .filter((row) => row.costUsdEstimated != null)
      .map((row) => [row.id, Number(row.costUsdEstimated)])
  );
  const tokenRows = await prisma.client.tokenUsage.findMany({
    where: { sessionId: { in: ids } },
    select: {
      sessionId: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      createdAt: true,
      costUsdEstimated: true,
    },
    orderBy: [{ sessionId: "asc" }, { model: "asc" }],
  });
  const tokenRowsBySessionId = groupRowsBySessionId(
    tokenRows.map((r) => ({
      session_id: r.sessionId,
      model: r.model,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_write_tokens: r.cacheWriteTokens,
      created_at: r.createdAt,
      cost_usd_estimated: r.costUsdEstimated,
    }))
  );
  for (const session of sessions) {
    const estimatedCostUsd =
      costBySession.get(session.id) ??
      sumResolvedTokenUsageCosts(tokenRowsBySessionId.get(session.id) ?? []);
    if (estimatedCostUsd !== undefined) {
      session.estimatedCostUsd = estimatedCostUsd;
    }
  }
}

function sumResolvedTokenUsageCosts(
  tokenRows: readonly SqliteTokenUsageRow[]
): number | undefined {
  let total = 0;
  let hasCost = false;
  for (const tokenRow of tokenRows) {
    const estimatedCostUsd = resolveTokenUsageCostUsd({
      ...tokenRow,
      input_tokens: tokenCountValue(tokenRow.input_tokens, "cost.input"),
      output_tokens: tokenCountValue(tokenRow.output_tokens, "cost.output"),
      cache_read_tokens: tokenCountValue(
        tokenRow.cache_read_tokens,
        "cost.cache_read"
      ),
      cache_write_tokens: tokenCountValue(
        tokenRow.cache_write_tokens,
        "cost.cache_write"
      ),
    });
    if (estimatedCostUsd === undefined) {
      continue;
    }
    total += estimatedCostUsd;
    hasCost = true;
  }
  return hasCost ? total : undefined;
}

async function persistImportedTokenCosts(
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    harness: string;
    tokenUsageObservedAt: string;
    tokenUsageModels?: string[];
    tokenEvents: TokenEventRecord[];
    tokenEventObservedAtFallback: string;
  }
): Promise<void> {
  const usageRows = await selectTokenUsagePricingRows(
    tx,
    input.sessionId,
    input.tokenUsageModels
  );
  for (const row of usageRows) {
    const observedAt = row.created_at ?? input.tokenUsageObservedAt;
    const costInput = {
      model: row.model,
      inputTokens: tokenCountValue(row.input_tokens, "pricing.input"),
      outputTokens: tokenCountValue(row.output_tokens, "pricing.output"),
      cacheReadTokens: tokenCountValue(
        row.cache_read_tokens,
        "pricing.cache_read"
      ),
      cacheWriteTokens: tokenCountValue(
        row.cache_write_tokens,
        "pricing.cache_write"
      ),
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    await updateTokenUsageCost(
      tx,
      input.sessionId,
      row.model,
      estimate,
      observedAt
    );
  }

  for (const event of input.tokenEvents) {
    const observedAt = event.timestamp || input.tokenEventObservedAtFallback;
    const costInput = {
      model: event.model,
      inputTokens: event.input,
      outputTokens: event.output,
      cacheReadTokens: event.cacheRead,
      cacheWriteTokens: event.cacheWrite,
      observedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate) {
      reportTokenCostPricingMiss(
        costInput,
        "imported_token_costs",
        input.sessionId
      );
    }
    await updateTokenEventCost(
      tx,
      input.sessionId,
      event,
      estimate,
      observedAt
    );
  }

  await updateSessionCostRollup(tx, input.sessionId);
}

async function selectTokenUsagePricingRows(
  tx: Prisma.TransactionClient,
  sessionId: string,
  models?: string[]
): Promise<TokenUsagePricingRow[]> {
  const uniqueModels =
    models === undefined
      ? null
      : [...new Set(models.filter((model) => model.length > 0))].sort();
  if (uniqueModels?.length === 0) {
    return [];
  }
  const modelFilter =
    uniqueModels === null
      ? ""
      : ` AND model IN (${uniqueModels.map((_, index) => `$${index + 2}`).join(", ")})`;
  return tx.$queryRawUnsafe<TokenUsagePricingRow[]>(
    `SELECT
       model,
       input_tokens,
       output_tokens,
       cache_read_tokens,
       cache_write_tokens,
       created_at
     FROM token_usage
     WHERE session_id = $1${modelFilter}
     ORDER BY model ASC`,
    ...(uniqueModels === null ? [sessionId] : [sessionId, ...uniqueModels])
  );
}

async function updateTokenUsageCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  model: string,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE token_usage SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3,
       cost_observed_at = $4
     WHERE session_id = $5 AND model = $6`,
    estimate?.costUsd ?? null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    sessionId,
    model
  );
}

async function updateTokenEventCost(
  tx: Prisma.TransactionClient,
  sessionId: string,
  event: TokenEventRecord,
  estimate: EstimateTokenCostResult | undefined,
  observedAt: string
): Promise<void> {
  // token_events is @@ignore'd (no PK → no generated delegate), so this stays
  // raw on the prisma tx client.
  await tx.$executeRawUnsafe(
    `UPDATE token_events SET
       cost_usd_estimated = $1,
       input_cost_usd_estimated = $2,
       output_cost_usd_estimated = $3,
       cache_read_cost_usd_estimated = $4,
       cache_creation_cost_usd_estimated = $5,
       cost_currency = $6,
       cost_source = $7,
       cost_observed_at = $8
     WHERE session_id = $9
       AND model = $10
       AND created_at = $11
       AND input_tokens = $12
       AND output_tokens = $13
       AND cache_read_tokens = $14
       AND cache_write_tokens = $15`,
    estimate?.costUsd ?? null,
    estimate?.inputCostUsd ?? null,
    estimate?.outputCostUsd ?? null,
    estimate?.cacheCostUsd ?? null,
    null,
    estimate ? ModelPricingCurrency.Usd : null,
    estimate ? ModelPricingSource.GenaiPricesV1 : null,
    estimate ? observedAt : null,
    sessionId,
    event.model,
    event.timestamp,
    event.input,
    event.output,
    event.cacheRead,
    event.cacheWrite
  );
}

async function updateSessionCostRollup(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<
    {
      cost_usd: number | null;
      priced_rows: number;
      cost_source: string | null;
    }[]
  >(
    `SELECT
       COALESCE(SUM(cost_usd_estimated), 0) AS cost_usd,
       COUNT(cost_usd_estimated) AS priced_rows,
       CASE
         WHEN SUM(CASE WHEN cost_source = $2 THEN 1 ELSE 0 END) > 0 THEN $2
         WHEN SUM(CASE WHEN cost_source = $3 THEN 1 ELSE 0 END) > 0 THEN $3
         ELSE NULL
       END AS cost_source
     FROM token_usage
     WHERE session_id = $1`,
    sessionId,
    ModelPricingSource.GenaiPricesV1,
    ModelPricingSource.PricingTableV1
  );
  const costUsd = Number(rows[0]?.cost_usd ?? 0);
  const pricedRows = Number(rows[0]?.priced_rows ?? 0);
  const costSource = rows[0]?.cost_source ?? null;
  await tx.$executeRawUnsafe(
    `UPDATE sessions SET
       cost_usd_estimated = $1,
       cost_currency = $2,
       cost_source = $3
     WHERE id = $4`,
    pricedRows > 0 ? costUsd : null,
    pricedRows > 0 ? ModelPricingCurrency.Usd : null,
    pricedRows > 0 ? costSource : null,
    sessionId
  );
}

/**
 * FEA-1459 Fix C: Replace token_events for a session via delete+reinsert.
 * Both the live-hook path and the boot-import path derive the FULL record set
 * from the whole transcript on every call, so delete+reinsert is correct and
 * inherently idempotent. This replaces the old high-water mark approach which
 * permanently dropped subagent token records discovered later with
 * interleaved-earlier timestamps.
 */
type TokenEventRecord = {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type TokenUsagePricingRow = {
  model: string;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  created_at: string | null;
};

// token_events is @@ignore'd (no PK → no generated delegate), so this whole
// family stays raw on the prisma tx client.
async function insertTokenEvent(
  tx: Prisma.TransactionClient,
  sessionId: string,
  rec: TokenEventRecord
): Promise<void> {
  const storageCounts = normalizeTokenEventRecord(rec, "token_events");
  await tx.$executeRawUnsafe(
    `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    sessionId,
    rec.model,
    rec.timestamp,
    storageCounts.input,
    storageCounts.output,
    storageCounts.cacheRead,
    storageCounts.cacheWrite
  );
}

/** Boot path: full re-derivation from the entire transcript (including merged
 * subagents, which can carry timestamps EARLIER than existing rows), so
 * delete+reinsert is the correct idempotent operation. */
async function replaceTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<void> {
  await tx.$executeRawUnsafe(
    "DELETE FROM token_events WHERE session_id = $1",
    sessionId
  );
  await insertTokenEventsBatched(tx, sessionId, records);
}

/**
 * perf: write token_events rows in chunked multi-row INSERTs instead of one
 * INSERT per record. Same columns, same normalization, same skip-on-missing-
 * timestamp behavior as {@link insertTokenEvent}; just fewer round-trips. Each
 * row binds 7 params; rows-per-chunk stays under EVENT_INSERT_PARAM_CAP.
 */
async function insertTokenEventsBatched(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<void> {
  const columnCount = 7;
  const rowsPerChunk = Math.max(
    1,
    Math.floor(EVENT_INSERT_PARAM_CAP / columnCount)
  );
  const rows: unknown[][] = [];
  for (const rec of records) {
    if (!rec.timestamp) {
      continue;
    }
    const storageCounts = normalizeTokenEventRecord(rec, "token_events");
    rows.push([
      sessionId,
      rec.model,
      rec.timestamp,
      storageCounts.input,
      storageCounts.output,
      storageCounts.cacheRead,
      storageCounts.cacheWrite,
    ]);
  }
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const params: unknown[] = [];
    const valueGroups: string[] = [];
    for (const row of chunk) {
      const base = params.length;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
      );
      params.push(...row);
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ${valueGroups.join(", ")}`,
      ...params
    );
  }
}

/** Live-hook path: the transcript only appends, so insert only records newer
 * than the session's high-water mark (created_at is TEXT ISO — lexicographic
 * compare, same convention as the events HWM). Cost per hook event is one
 * SELECT plus inserts for the new turn(s) instead of a full table rewrite. */
async function appendTokenEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  records: TokenEventRecord[]
): Promise<TokenEventRecord[]> {
  const hwmResult = await tx.$queryRawUnsafe<{ hwm: string | null }[]>(
    "SELECT MAX(created_at) AS hwm FROM token_events WHERE session_id = $1",
    sessionId
  );
  const hwm = hwmResult[0]?.hwm ?? null;
  const insertedRecords: TokenEventRecord[] = [];
  for (const rec of records) {
    if (!rec.timestamp || (hwm != null && rec.timestamp <= hwm)) {
      continue;
    }
    await insertTokenEvent(tx, sessionId, rec);
    insertedRecords.push(rec);
  }
  return insertedRecords;
}

async function deleteClaudeCodeOtelSessionRows(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await tx.claudeCodeCostEvent.deleteMany({ where: { sessionId } });
  await tx.claudeCodePermissionEvent.deleteMany({ where: { sessionId } });
  await tx.claudeCodeApiRequest.deleteMany({ where: { sessionId } });
}

function normalizeTokenUsageCounts(
  counts: TokenUsageCounts,
  context: string
): TokenUsageCounts {
  return {
    input: tokenCountValue(counts.input, `${context}.input_tokens`),
    output: tokenCountValue(counts.output, `${context}.output_tokens`),
    cacheRead: tokenCountValue(
      counts.cacheRead,
      `${context}.cache_read_tokens`
    ),
    cacheWrite: tokenCountValue(
      counts.cacheWrite,
      `${context}.cache_write_tokens`
    ),
  };
}

function normalizeTokenEventRecord(
  rec: TokenEventRecord,
  context: string
): TokenUsageCounts {
  return {
    input: tokenCountValue(rec.input, `${context}.input_tokens`),
    output: tokenCountValue(rec.output, `${context}.output_tokens`),
    cacheRead: tokenCountValue(rec.cacheRead, `${context}.cache_read_tokens`),
    cacheWrite: tokenCountValue(
      rec.cacheWrite,
      `${context}.cache_write_tokens`
    ),
  };
}

function normalizeTraceTokenEvent(
  row: SqliteTokenEventRow
): SessionTraceSyncInput["tokenEvents"][number] {
  return {
    model: row.model,
    created_at: row.created_at,
    input_tokens: tokenCountValue(row.input_tokens, "trace.input"),
    output_tokens: tokenCountValue(row.output_tokens, "trace.output"),
    cache_read_tokens: tokenCountValue(
      row.cache_read_tokens,
      "trace.cache_read"
    ),
    cache_write_tokens: tokenCountValue(
      row.cache_write_tokens,
      "trace.cache_write"
    ),
    cost_usd_estimated: row.cost_usd_estimated,
    input_cost_usd_estimated: row.input_cost_usd_estimated,
    output_cost_usd_estimated: row.output_cost_usd_estimated,
    cache_read_cost_usd_estimated: row.cache_read_cost_usd_estimated,
    cache_creation_cost_usd_estimated: row.cache_creation_cost_usd_estimated,
  };
}

function tokenCountValue(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, `sqlite.${fieldName}`);
}
