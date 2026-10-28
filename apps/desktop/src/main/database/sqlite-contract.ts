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
import type { ClaudeCodeOtelSideTableSignal } from "../otel/claude-code-otel-signal-contract.js";
import type { ClaudeCodeOtelPersistenceSummary } from "../otel/claude-code-persistence.js";
import type { ClaudeCodeSignalDropReason } from "../otel/claude-code-signal-drop.js";
import type {
  PackInstallRunEndInput,
  PackInstallRunStartInput,
} from "../packs/catalog-store.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";
import type { StorePerfDiagnostics } from "../telemetry/telemetry-protocol.js";
import type { AnalyticsRollupRecomputeResult } from "./analytics-recompute.js";
import type { BranchReadFacadeMethods } from "./branch-read-facades.js";
import type { CollectorIngestStoreRow } from "./collector-ingest-store.js";
import type { StorePerfSampler } from "./db-host/store-perf-sampler.js";
import type { DiagnosticsMethods } from "./diagnostics-methods.js";
import type { Prisma } from "./generated/client.js";
import type { openMigrationDatabase } from "./migration/migration-executor.js";
import type { MigrationStep } from "./migration/migration-runner.js";
import type { DbHostPrisma, DesktopPrisma } from "./prisma-client.js";
import type {
  SessionIdentity,
  SessionIdentityProvider,
  SessionOwnerClaimResult,
} from "./session-owner-identity.js";
import type { StoreHealthMethods } from "./store-health-methods.js";
import type { TranscriptExtract } from "./transcript.js";
import type { TranscriptSyncStore } from "./transcript-sync-store.js";
import type {
  createWriteQueue,
  WriteQueueTaskObserver,
} from "./write-queue.js";

/* The clone-safe STORE-HEALTH reads the FEA-1999 probe consumes are intersected
   in from `store-health-methods.ts` rather than restated here — they share one
   contract, and restating them here would only grow this file. */
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
    /**
     * ISS-9838: the persisted collector ingest stores (catchup cache, parse
     * quarantine, Codex linkage). Clone-safe args and results — strings and
     * numbers only — so both ops forward unchanged through the db-host proxy.
     */
    collectorIngestStores: {
      /**
       * Every persisted store, read once at boot BEFORE the collectors are
       * constructed (ISS-9837 R1). Returns rows rather than a hydrated map so
       * the result stays a clone-safe array across the proxy.
       */
      loadAll(): Promise<CollectorIngestStoreRow[]>;
      /** Replace one store's snapshot wholesale. */
      save(
        storeKey: string,
        formatVersion: number,
        payload: string
      ): Promise<void>;
    };
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
    claudeCodeOtel: {
      /**
       * ISS-7352. Side-table signals ONLY — `token_usage` is owned by the
       * transcript parser and is excluded from the parameter type, so a caller
       * that reaches for it fails typecheck. The implementation rejects it at
       * runtime too, because this facade is a process boundary and a type
       * cannot constrain what arrives over IPC.
       */
      persistSignals(
        signals: ClaudeCodeOtelSideTableSignal[]
      ): Promise<ClaudeCodeOtelPersistenceSummary>;
      /**
       * ISS-10717: record signals this machine LOST, by reason. The three drop
       * sites used to log the loss and discard it, which is why nothing
       * downstream could say how complete the corpus was.
       */
      recordSignalDrop(input: {
        harness: string;
        reason: ClaudeCodeSignalDropReason;
        count: number;
      }): Promise<void>;
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
        // Optional fixed clock. Omitted, the read runs on the STORE's clock
        // (`now` below) — real time in production, the injected instant in a
        // test — so the date-windowed insights (trend series) are deterministic
        // without every call site restating the date (ISS-9279).
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
      getWorkflowData(): Promise<WorkflowQueryData>;
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
    listStaleRevisionSessions(currentRevision: number): Promise<
      Array<{
        id: string;
        harness: string | null;
        status: string;
        /**
         * ISS-8601: the age anchor the rebuild's admission test reads. NOT NULL
         * in the schema and indexed by `idx_sessions_last_activity`; the same
         * column the SQL aggregate and the JS staleness fold already share.
         */
        lastActivityAt: string;
      }>
    >;
    /**
     * ISS-8601: the store's clock, as an ISO-8601 string — the same one that
     * stamps writes and anchors the in-transaction rebuild guards. Exposed so a
     * MAIN-process reader can classify a row against the instant the guards will
     * use rather than against its own wall clock; the two disagreeing is what
     * turns the rebuild's age bound back into an unbounded retry. Over the
     * db-host proxy this resolves as a promise, so callers await it — and the
     * RETURN TYPE says so rather than leaving the prose to carry it. Typed
     * `string` it would be the first synchronous member on this contract, and a
     * main-process caller writing `new Date(db.now())` would compile clean and
     * silently get an Invalid Date.
     */
    now(): string | Promise<string>;
    /**
     * All session ids currently in the DB. Used by the collector manager to
     * self-heal catchup-cache/DB divergence: a source the persistent ingest
     * cache marks "seen" whose row was dropped by a DB reset/migration must be
     * re-imported, not skipped (codex/claude orphaning after PGlite→SQLite).
     */
    listExistingSessionIds(): Promise<Set<string>>;
    rebuildSessionFromParse(
      session: NormalizedSession,
      harness: Harness,
      // ISS-8741: the source revision to stamp as the new known-good projection,
      // written in the SAME transaction as the replacement. Optional — omitting
      // it is the pre-substrate behaviour and leaves the row's stamp alone.
      projectionRevision?: string | null,
      // ISS-12552: the policy the session was re-parsed under; absent, the
      // store's own current policy.
      parsePolicy?: ParsePolicy
      // FEA-3659: `needsResync` mirrors the impl (and the
      // DataRevisionRebuildDatabase declaration) — true when the row must
      // re-sync (payload changed and `updated_at` bumped, or ISS-12251 only
      // `created_at` moved), so the rebuild enqueues ONLY those rows for sync.
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      needsResync?: boolean;
    }>;
    /**
     * ISS-8741: mark a session as having a projection replacement IN FLIGHT at
     * `revision`, in its own transaction, before the replacement is built. The
     * known-good stamp is deliberately NOT here: it rides inside
     * {@link rebuildSessionFromParse}'s transaction, because a stamp that could
     * commit separately from the rows it describes would be the split this
     * substrate exists to prevent.
     *
     * Flat methods rather than a nested store object because every path here
     * crosses the db-host proxy, whose dotted op paths are a narrower, more
     * failure-prone surface than a plain method name.
     */
    claimProjectionCandidate(
      sessionId: string,
      revision: string
    ): Promise<void>;
    /** ISS-8741: clear the in-flight marker, leaving the known-good stamp alone. */
    releaseProjectionCandidate(sessionId: string): Promise<void>;
    rebuildComponentInvocationsFromStoredRows(
      sessionId: string,
      currentRevision: number,
      // ISS-12552: off also clears the session's attribution evidence.
      parsePolicy?: ParsePolicy
    ): Promise<{
      rebuilt: boolean;
      activeRace: boolean;
      needsResync?: boolean;
    }>;
    /**
     * Deletes the row and its session-attributable derived rows, and REPORTS
     * whether it did (ISS-8601). It refuses a non-terminal row in its own
     * transaction; while that outcome was `void`, callers read every non-throwing
     * call as a deletion and counted and logged ones that never happened.
     */
    deleteSessionRow(sessionId: string): Promise<boolean>;
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
  /**
   * ISS-7110: fired after any write-queue task's underlying work resolves —
   * every `prisma.write` path (backfill, importer, sync, live hooks,
   * maintenance), including a task whose caller was evicted (ISS-4572) but
   * whose transaction still committed; never for a write that rejected. The
   * db-host worker wires this to the FEA-2055 insights-cache epoch bump —
   * `emit` above fires only from the live-hook lifecycle and cannot see
   * importer/backfill writes.
   */
  onCommittedWrite?: () => void;
  /**
   * ISS-7256 (whitlockk review): fired on each tokened write-queue task's
   * `queued`/`dispatched`/`settled` transition, synchronously at the transition.
   * The db-host store thread wires this to a `WriteTask` message so the
   * DISPATCHER can answer `importer.hasUndispatchedWrite` from a mirror while
   * this thread is parked inside a synchronous statement — the window in which a
   * pull is answered by nothing. Omitted in the in-process topology, where
   * `probeUndispatchedTask` reads the queue directly.
   */
  onWriteTaskPhase?: WriteQueueTaskObserver;
  /** Fired once when a live SessionEnd hook drives a session terminal. */
  onSessionTerminal?: (notice: { sessionId: string; status: string }) => void;
  extractTranscript?: (path: string) => TranscriptExtract | null;
  getUserIdentity?: SessionIdentityProvider;
  resolveGitPath?: () => string;
  log?: (message: string) => void;
  /**
   * The store's clock, as an ISO-8601 string. Omitted ⇒ real time. It stamps
   * writes and boot maintenance (including the retention sweep),
   * AND anchors the date-windowed dashboard reads (ISS-9279), so a test that
   * pins it gets one instant for both halves rather than a writer and a reader
   * that disagree by however long ago the fixtures were written.
   */
  now?: () => string;
  staleMinutes?: number;
  // Data-governance retention window (days). Terminal sessions older than this
  // are purged by the boot retention sweep; omit to use the module default.
  retentionDays?: number;
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
  /**
   * ISS-6339 test seam: sink for each executed migration's duration/outcome.
   * Production omits it and gets `reportMigrationStep`, which emits on the
   * desktop telemetry transport.
   */
  onMigrationStep?: (step: MigrationStep) => void;
  /**
   * ISS-6339 test seam: sink for each periodic store-performance sample.
   * Production omits it and gets `reportStorePerfSample`.
   *
   * Both seams exist so a test can assert the PRODUCTION WIRING — that opening
   * the store really does hook the statement recorder to the adapter and the
   * sampler to the emit — without standing up `Observability`, whose emitter is
   * a null no-op outside the main-process composition root and so would make an
   * unwired seam and a wired one indistinguishable.
   */
  onStorePerfSample?: (sample: StorePerfDiagnostics) => void;
  /**
   * ISS-6339 test seam: the sampler's tick. Production omits it and gets the
   * store-integrity heartbeat cadence, which a test cannot wait 30 minutes for.
   */
  storePerfSampleIntervalMs?: number;
  /**
   * ISS-7919 test seam: hands back the sampler this open started, so the wiring
   * test can await its `whenSamplesSettled()` — the sampler's own signal that
   * the work a tick began has finished — instead of guessing how long the
   * tick's real `stat` needs.
   *
   * It hands back the sampler to OBSERVE, not to drive: the wiring test still
   * gets its samples from the production interval, because a store that wired
   * the sink but never started the timer would satisfy a direct `sampleOnce()`
   * and emit nothing in the field. Production omits this and the sampler is
   * unreachable from outside, exactly as before.
   */
  onStorePerfSamplerStarted?: (sampler: StorePerfSampler) => void;
  /** ISS-8876 test seam: force the portable event-fingerprint fallback. */
  rowDigestSupportProbe?: () => Promise<boolean>;
};
