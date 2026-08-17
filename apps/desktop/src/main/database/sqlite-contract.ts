/**
 * @file sqlite-contract.ts
 * @description The desktop local store's PUBLIC TYPE CONTRACT — the
 * `SqliteAgentDatabase` facade, its main-process proxy view
 * `DbHostAgentDatabase`, and the `openSqliteAgentDatabase` options.
 *
 * Extracted verbatim from `sqlite.ts` (ISS-5400) to bring that file back under
 * the 1,000 logical-line ceiling. Types only — no runtime behavior moved, and
 * `sqlite.ts` re-exports all three so the ~120 existing consumers are unchanged.
 *
 * The one value import is `createWriteQueue`, used solely as
 * `ReturnType<typeof createWriteQueue>`.
 */

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  InsightsSection,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import type { TaskUpsert } from "@repo/crewd";
import type { RunRecord, ScheduledTask } from "@repo/crewd/model";
import type {
  AgentHierarchyNode,
  AgentRow,
  AnalyticsData,
  DashboardCoreFeatures,
  DashboardListWindow,
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
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type { MeteredUsageRow } from "../cost/reconciliation-worker.js";
import type {
  HookData,
  HookHarness,
  Importer,
  TokenUsageCounts,
  TokenUsageRow,
} from "../dashboard/agent-dashboard-db-types.js";
import type {
  PackInstallRunEndInput,
  PackInstallRunStartInput,
} from "../packs/catalog-store.js";
import type { ScheduledReviewRunner } from "../scheduler/scheduled-review-dispatch.js";
import type { AnalyticsRollupRecomputeResult } from "./analytics-recompute.js";
import type { BranchReadFacadeMethods } from "./branch-read-facades.js";
import type { DiagnosticsMethods } from "./diagnostics-methods.js";
import type { Prisma } from "./generated/client.js";
import type { openMigrationDatabase } from "./migration/migration-executor.js";
import type { DbHostPrisma, DesktopPrisma } from "./prisma-client.js";
import type {
  SessionIdentity,
  SessionIdentityProvider,
  SessionOwnerClaimResult,
} from "./session-owner-identity.js";
import type { StoreHealthMethods } from "./store-health-methods.js";
import type { TranscriptExtract } from "./transcript.js";
import type { TranscriptSyncStore } from "./transcript-sync-store.js";
import type { createWriteQueue } from "./write-queue.js";

/* The clone-safe STORE-HEALTH reads the FEA-1999 probe consumes are intersected
   in from `store-health-methods.ts` rather than restated here — they share one
   contract, and this file is on the shrink-only grandfather list. */
/* ISS-5957 — a NEW named Branch read facade goes into `branch-read-facades.ts`,
   NOT into this intersection. Only what enters `BranchReadFacadeMethods` is
   exhausted by `BRANCH_READ_OP_LANES`; a facade added as a fourth top-level
   bundle here is callable by name through the db-host proxy with no declared
   lane, and `tsc` stays green. The two bundles already intersected here
   (`StoreHealthMethods`, `DiagnosticsMethods`) predate that guard and are
   themselves outside it — see the "What the guard does NOT cover" header of
   `db-host/db-host-op-lane-registry.ts`. */
export type SqliteAgentDatabase = StoreHealthMethods &
  BranchReadFacadeMethods &
  DiagnosticsMethods & {
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
      getBySessionWithChildren(
        sessionId: string
      ): Promise<AgentHierarchyNode[]>;
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
      getTokenAnalytics(
        now?: Date,
        // FEA-3722: rolling-window size in days for the token facet. undefined
        // keeps the 30-day default; `null` means all-time (unbounded).
        lookbackDays?: number | null
      ): Promise<TokenAnalytics>;
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
      getAnalytics(
        now?: Date,
        // FEA-3722: rolling-window size in days for the token/tool-usage facets.
        // undefined keeps the 30-day default; `null` means all-time (unbounded).
        lookbackDays?: number | null
      ): Promise<AnalyticsData>;
      getWorkflowData(now?: Date): Promise<WorkflowQueryData>;
      getCoreFeatures(): Promise<DashboardCoreFeatures>;
      getPacks(): Promise<DashboardPackSummary[]>;
      getSkills(): Promise<DashboardSkillSummary[]>;
      getTools(): Promise<DashboardToolSummary[]>;
      getSubAgents(): Promise<DashboardSubAgentSummary[]>;
      // ISS-5631 / ISS-6451: both paged, like the `desktop:db:get-plans-list`
      // sibling — the default IS the ceiling, so an omitted window is still
      // bounded.
      getPlans(opts?: DashboardListWindow): Promise<DashboardPlanSummary[]>;
      getPullRequests(
        opts?: DashboardListWindow
      ): Promise<DashboardPullRequestSummary[]>;
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
      // FEA-3659: `contentChanged` mirrors the impl (and the
      // DataRevisionRebuildDatabase declaration) — true when the re-derived
      // payload actually bumped the session's `updated_at` sync watermark, so the
      // data-revision rebuild enqueues ONLY genuinely-changed rows for cloud sync.
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      contentChanged?: boolean;
    }>;
    rebuildComponentInvocationsFromStoredRows(
      sessionId: string,
      currentRevision: number
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      contentChanged?: boolean;
    }>;
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
    recomputeAnalyticsRollups(
      sessionIds: string[]
    ): Promise<AnalyticsRollupRecomputeResult>;
    captureRepoIdentity(
      gitPath: string,
      cwd: string
    ): Promise<{ repoFullName: string | null }>;
    runHistoricalBackfill(gitPath: string, batchSize: number): Promise<number>;
    /**
     * FEA-1899 post-backfill link propagation: auto-link branch sessions to their
     * PR artifacts. Runs in the db host (its `prisma.write` can't cross the method
     * proxy); returns the number of sessions linked. See pr-link-maintenance.ts.
     */
    propagateAllBranchPrLinks(): Promise<number>;
    /**
     * FEA-4379 post-backfill content correlation: mint a `created` session→PR link
     * when a commit SHA the session authored is byte-identical to a PR's head or
     * merge-commit SHA (attributes out-of-band-created PRs). Runs in the db host
     * (its `prisma.write` can't cross the method proxy); returns the number of
     * links minted. See pr-link-maintenance.ts.
     */
    correlateCommitShaPrLinks(): Promise<number>;
    /**
     * FEA-4377 upgrade remediation: delete `branch_pr_association` workspace links
     * minted before the authoring-evidence gate for sessions with no `created`
     * branch link to the PR. Runs in the db host (its `prisma.write` can't cross
     * the method proxy); returns the number of stale links removed. See
     * branch-pr-attribution.ts.
     */
    removeUnauthoredBranchPrLinks(): Promise<number>;
    /**
     * FEA-3743 post-backfill heal: rewrite session/usage/span timestamp columns
     * stored in a non-canonical text form (timezone-offset forms) into the
     * canonical ISO-8601 UTC 'Z' form the write path now produces. Runs in the db
     * host (its `prisma.write` can't cross the method proxy); returns the number of
     * values rewritten. See timestamp-format-maintenance.ts.
     */
    normalizeStoredTimestampFormats(): Promise<number>;
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
    /**
     * FEA-3813 (PRD-553 M1): the local crewd scheduler host. Clone-safe control
     * methods so the main process can start/stop the daemon across the db-host
     * boundary (the daemon + its SQLite-mirrored `SqliteTaskStore` own a
     * `prisma.write` writer connection that can't cross the method proxy, so they
     * live entirely in the child). `start()` is gated by the caller on the
     * `scheduledTasks` Labs flag; `stop()` is called at shutdown and is disposed
     * with the db in `close()`. `tickOnce()` fires a single scheduler pass (tests /
     * a future run-now). All idempotent; safe to call `stop()`/`tickOnce()` before
     * `start()`.
     */
    scheduler: {
      start(): Promise<void>;
      stop(): Promise<void>;
      tickOnce(): Promise<void>;
      isRunning(): Promise<boolean>;
      /**
       * FEA-3814 (PRD-553 M2): the current task list, for the read-only Scheduled
       * Tasks UI. Clone-safe (plain `ScheduledTask[]`) so it crosses the db-host
       * method proxy. Empty before `start()`.
       */
      list(): Promise<ScheduledTask[]>;
      /**
       * FEA-3814 (PRD-553 M2): recent run history for the run-history drawer,
       * optionally scoped to one task (each run's `attempts` is the cascade trail).
       * Clone-safe (plain `RunRecord[]`). Empty before `start()`.
       */
      runs(taskId?: string, limit?: number): Promise<RunRecord[]>;
      /**
       * FEA-3853 (PRD-553 M3): create a task or replace one in place (by id) from
       * the create/edit modal's already-validated save payload. Returns the stored
       * task (clone-safe). Rejects when the daemon is not running.
       */
      upsert(input: TaskUpsert): Promise<ScheduledTask>;
      /**
       * FEA-3853 (PRD-553 M3): delete a task by id (its runs cascade). Resolves to
       * whether a task was removed. Rejects when the daemon is not running.
       */
      remove(id: string): Promise<boolean>;
      /**
       * FEA-3853 (PRD-553 M3): flip a task's `enabled` flag (the list-row toggle).
       * Resolves to the updated task, or null for an unknown id. Rejects when the
       * daemon is not running.
       */
      setEnabled(id: string, enabled: boolean): Promise<ScheduledTask | null>;
      /**
       * FEA-3853 (PRD-553 M3): fire one task once off-schedule ("Run now"). Resolves
       * to whether the run was launched (false for an unknown id / already-in-flight
       * task). Rejects when the daemon is not running.
       */
      runNow(id: string): Promise<boolean>;
      /**
       * FEA-3853 (PRD-553 M3): validate a cron and preview its next `count` fire
       * times for the create/edit modal. Pure over the crewd cron primitive — works
       * before `start()`. Clone-safe (ISO strings). Never rejects on a bad cron.
       */
      previewSchedule(
        cron: string,
        timezone: string,
        count?: number
      ): Promise<{ valid: boolean; error: string | null; nextRuns: string[] }>;
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
    /**
     * ISS-6168: re-run the identity-scoped owner claim for `identity`.
     *
     * The boot pass reads the identity ONCE, at db open, and on a cold start that
     * value is routinely still `null` — the main-process resolver returns null on
     * its first call and warms `/me` in the background. This is the seam that lets
     * an identity arriving AFTER open still repair the corpus, without waiting for
     * the next app restart. Clone-safe (a plain identity object in, a plain result
     * out), so it is callable through the db-host proxy — unlike `prisma.write`,
     * which takes a callback and cannot cross the process boundary.
     *
     * Idempotent and self-limiting: it claims nothing when there is nothing
     * unowned, when nobody is signed in, or when the store holds another
     * account's sessions.
     */
    claimSessionOwnerIdentity(
      identity: SessionIdentity | null
    ): Promise<SessionOwnerClaimResult>;
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
  detectBillingMode: (harness: string, model?: string | null) => string;
  emit?: (sessionId: string) => void;
  /** Fired once when a live SessionEnd hook drives a session terminal. */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  extractTranscript?: (path: string) => TranscriptExtract | null;
  getUserIdentity?: SessionIdentityProvider;
  resolveGitPath?: () => string;
  log?: (message: string) => void;
  now?: () => string;
  staleMinutes?: number;
  // Data-governance retention window (days). Terminal sessions older than this
  // are purged by the boot retention sweep; omit to use the module default.
  retentionDays?: number;
  /**
   * FEA-3814 (PRD-553 M2): fired after any crewd scheduler task/run mutation
   * (a tick firing a run, a run finishing, an enable/upsert/remove). The db-host
   * worker wires this to post a `SchedulerChanged` notification, which main
   * forwards to the renderer as `desktop:scheduled-tasks:changed`. Payload-free.
   */
  onSchedulerChanged?: () => void;
  /**
   * FEA-4143: the child→main proxy the crewd scheduler's review dispatch uses to
   * run a scheduled review through the main-process `AuditService` (throwaway
   * workspace + main-side credentials). The db-host worker wires this to a
   * `ScheduledReviewRun` request/reply round-trip. Omitted ⇒ no review runner
   * wired, so a fired review task degrades to a recorded skip (fires + persists,
   * spawns nothing) — the pre-FEA-4143 behavior.
   */
  runScheduledReview?: ScheduledReviewRunner;
  /**
   * ISS-5400 test seam: opens the boot-time migration handle. Production omits
   * it and gets `openMigrationDatabase`.
   *
   * It exists because the migration-refusal `catch` in `sqlite.ts` closes that
   * handle with `.catch(() => undefined)` so a secondary `close()` failure can
   * never replace the refusal the boot path surfaces to the user — and the only
   * way to prove that is to hand `openSqliteAgentDatabase` a handle whose
   * `close()` actually rejects. Nothing else in the boot path is overridden, so
   * the refusal itself still comes from the real runner against a real store.
   */
  openMigrationDatabase?: typeof openMigrationDatabase;
};
