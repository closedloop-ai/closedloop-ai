import { mkdir } from "node:fs/promises";
import path from "node:path";
import { captureRepoIdentity as captureRepoIdentityFn } from "../enrichment/repo-identity.js";
import type { ClaudeCodeOtelSideTableSignal } from "../otel/claude-code-otel-signal-contract.js";
import {
  isTokenUsageOtelSignal,
  persistClaudeCodeOtelSignals,
} from "../otel/claude-code-persistence.js";
import { createClaudeCodeSignalDropRecorder } from "../otel/claude-code-signal-drop.js";
import { parseCodexOtelBatch } from "../otel/codex-otel-contract.js";
import { persistCodexOtelBatch } from "../otel/codex-otel-writer.js";
import {
  reportMigrationStep,
  reportStorePerfSample,
} from "../telemetry/store-perf-telemetry.js";
import { recomputeAnalyticsRollupsFor } from "./analytics-recompute.js";
import { startBootMaintenance } from "./boot-maintenance.js";
import { createBranchCanonicalActivityReadMethods } from "./branch-activity-read.js";
import { createBranchMetricEventEvidenceMethods } from "./branch-metric-event-provenance.js";
import {
  loadCollectorIngestStores,
  saveCollectorIngestStore,
} from "./collector-ingest-store.js";
import { createSqliteDashboardQueries } from "./dashboard-queries.js";
import { safe } from "./db-helpers.js";
import { createQueryPerfRecorder } from "./db-host/db-host-query-perf.js";
import {
  type StorePerfSampler,
  startStorePerfSampler,
} from "./db-host/store-perf-sampler.js";
import { createDiagnosticsMethods } from "./diagnostics-methods.js";
import { createSqliteLifecycle } from "./live-hook.js";
import {
  BASELINE_MIGRATIONS,
  COLLAPSED_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "./migration/baseline-schema.js";
import { openMigrationDatabase } from "./migration/migration-executor.js";
import { runDesktopMigrations } from "./migration/migration-runner.js";
import { MIGRATIONS } from "./migration/migrations-manifest.js";
import { createDesktopPrisma, type DesktopPrisma } from "./prisma-client.js";
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
import {
  claimUnownedSessionIdentity,
  SessionOwnerClaimSkip,
} from "./session-owner-identity.js";
import type {
  OpenSqliteAgentDatabaseOptions,
  SqliteAgentDatabase,
} from "./sqlite-contract.js";
import { createMaintenanceFacade } from "./sqlite-maintenance-facade.js";
import {
  createSqliteSessionSyncSource,
  loadSqliteMeteredUsageRows,
} from "./sync-source.js";
import { createRowDigestProbe } from "./synced-child-row-fingerprint.js";
import { normalizeStoredTimestampFormats as normalizeStoredTimestampFormatsFn } from "./timestamp-format-maintenance.js";
import { healSessionLastActivityAtFloor } from "./token-cost-maintenance.js";
import { createTranscriptSyncStore } from "./transcript-sync-store.js";
import { createSqliteImporter } from "./write-core.js";
import { createWriteQueue, withCommittedWriteObserver } from "./write-queue.js";

/*
 * ISS-5400: the facade/proxy/options TYPE CONTRACT moved verbatim to
 * `./sqlite-contract.js` to bring this file back under the 1,000 logical-line
 * ceiling. Re-exported here so existing consumers keep importing from
 * `sqlite.js` — no call site changed.
 */
export type {
  DbHostAgentDatabase,
  OpenSqliteAgentDatabaseOptions,
  SqliteAgentDatabase,
} from "./sqlite-contract.js";
/**
 * FEA-1839: prefix for the synthetic `session_id` of a
 * `mutual_exclusivity_violation` event. A real harness session id is a bare
 * id/uuid, so this namespaced value can never collide with one — keeping the
 * diagnostic row off any real session's event stream and clear of
 * `rebuildSessionFromParse`'s per-session DELETE.
 */

export async function openSqliteAgentDatabase(
  options: OpenSqliteAgentDatabaseOptions
): Promise<SqliteAgentDatabase> {
  await mkdir(path.dirname(options.dataDir), { recursive: true });
  // libSQL/SQLite (WAL): `db` is the boot-time migration handle; the Prisma
  // adapter opens its own connection from `dbConfig` (same file, WAL → concurrent
  // reads while the backfill writes).
  const { db, config: dbConfig } = await (
    options.openMigrationDatabase ?? openMigrationDatabase
  )(options.dataDir);
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
      // ISS-6339: one event per executed migration. Injected rather than emitted
      // by the runner so the runner keeps no telemetry dependency and the tests
      // that drive it (and `prisma-test-utils`) stay emit-free.
      onStep: options.onMigrationStep ?? reportMigrationStep,
    });
  } catch (error) {
    // Close the handle so the DB stays closed on refusal, but never let a
    // close() failure mask the original migration error (it is the one the
    // boot path surfaces to the user).
    await db.close().catch(() => undefined);
    throw error;
  }
  const nowFn = options.now ?? (() => new Date().toISOString());
  const queue = createWriteQueue(options.onWriteTaskPhase);
  // ISS-7110: observe committed writes at the single-writer boundary every
  // `prisma.write` path flows through — backfill, importer, sync, live hooks,
  // maintenance alike. The db-host worker wires `onCommittedWrite` to the
  // FEA-2055 insights-cache epoch bump; before this seam the bump rode only the
  // live-hook `emit`, so importer/backfill writes never invalidated the cache
  // and a dashboard response computed over the pre-backfill (empty) store was
  // re-served on every refetch. The raw `queue` keeps serving `cancel`/`drain`
  // and the facade's `writeQueue` untouched.
  const writeSerializer = options.onCommittedWrite
    ? withCommittedWriteObserver(queue, options.onCommittedWrite)
    : queue;
  // The single Prisma layer (writer + reader pool) over the same file; writes
  // serialize through the shared queue. Built before the stores so their reads
  // can run on it. If construction fails partway (a connection or PRAGMA
  // throwing), createDesktopPrisma disconnects its own opened clients, but the
  // boot-time migration `db` is ours to close — mirror the migration-refusal
  // cleanup so a post-migration boot failure leaks nothing.
  // ISS-6339: the query-duration accumulator, wired at the adapter boundary
  // every statement crosses. Bounded cardinality by construction — it keeps a
  // per-statement-FAMILY histogram and never retains the SQL text.
  const queryPerf = createQueryPerfRecorder();
  let prisma: DesktopPrisma;
  try {
    prisma = await createDesktopPrisma(dbConfig, writeSerializer, {
      onStatementSettled: queryPerf.record,
    });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  // ISS-6339: drains that accumulator and reads the store/WAL file sizes on the
  // store-integrity heartbeat cadence. Started AFTER the client exists so the
  // first window cannot span construction.
  const storePerfSampler: StorePerfSampler = startStorePerfSampler({
    databasePath: options.dataDir,
    recorder: queryPerf,
    emit: options.onStorePerfSample ?? reportStorePerfSample,
    ...(options.storePerfSampleIntervalMs === undefined
      ? {}
      : { intervalMs: options.storePerfSampleIntervalMs }),
    log,
  });
  options.onStorePerfSamplerStarted?.(storePerfSampler);
  // FEA-2038 + the heal/backfill wave: the background boot-maintenance chain
  // (ordering + per-pass .catch isolation live in the module). Fire-and-forget:
  // never awaited here, exposed via `whenBootMaintenanceSettled()` below.
  const bootMaintenance = startBootMaintenance(prisma, log);
  // The events + token-usage stores run on the single Prisma client — `replace`
  // takes an optional `Prisma.TransactionClient` so the importer / lifecycle /
  // sync paths run it inside their `$transaction`.
  const tokenUsage = createSqliteTokenUsageStore(prisma);
  const events = createSqliteEventStore(prisma);
  const sessions = createSqliteSessionStore(prisma);
  // ISS-10717: the dropped-signal counter behind the completeness signal. Its
  // own `warn` goes to the same store log as every other write here, so a
  // refused count is visible rather than silently coerced.
  const signalDropRecorder = createClaudeCodeSignalDropRecorder({
    prisma,
    warn: (message) => log(message),
  });
  const agents = createSqliteAgentStore(prisma, events);
  // ISS-9279: on the STORE's clock, not `new Date()` — a store opened with an
  // injected `now` must read its date-windowed dashboards through the same
  // instant it wrote them at.
  const dashboard = createSqliteDashboardQueries(prisma, nowFn);

  // ISS-4591: resolved once per database, OUTSIDE any transaction, so a prepare
  // error can never land mid-rebuild. See the module for the caching contract
  // (conclusive results only — a transient failure is retried).
  const supportsRowDigest =
    options.rowDigestSupportProbe ?? createRowDigestProbe(prisma.client, log);

  // FEA-3743: normalize any non-canonical (offset-form) timestamp text left by
  // an earlier build's Codex OTel writer into the canonical UTC 'Z' form BEFORE
  // the floor heal and sweeps below — all three compare these columns as text,
  // so they must see one format. This runs first (not in post-backfill
  // maintenance) precisely so the FEA-3591 floor heal below no longer has to
  // exclude offset-form rows: at this point in boot every started_at
  // /last_activity_at is canonical. That is a point-in-boot property, NOT a
  // durable one — write-core.ts writes `session.startedAt` verbatim from the
  // harness on its new-row INSERT, so a session FIRST imported after this pass
  // carries the harness spelling until the next boot heals it. (A re-import does
  // not undo the heal: nothing rewrites `started_at` on an existing row. See the
  // KNOWN GAP note in timestamp-format-maintenance.ts, which also covers
  // `sessions.ended_at`, healed by nothing.) The property holds for the rest of
  // this maintenance chain, which is what the floor heal below needs.
  // Best-effort and .catch-isolated; a failure just leaves the
  // format defect for the next boot (the floor heal's own GLOB floor still
  // treats an unparseable value as epoch, so it can never regress an instant).
  const timestampHeal = await normalizeStoredTimestampFormatsFn(
    prisma,
    log,
    nowFn
  ).catch((e: unknown) => {
    log(
      `boot: timestamp-format heal failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return { rewritten: 0, healedSessionIds: [] as string[] };
  });
  // FEA-3743: a healed `sessions.started_at` is copied into the persisted,
  // sync-emitted `session_analytics.started_at` by the rollup. The analytics
  // backfill only anti-joins MISSING rows, so an existing offset-form copy would
  // stay non-canonical after the source heal — re-derive the affected rollups so
  // the derived timestamp is canonicalized too. Best-effort, .catch-isolated;
  // the `updated_at` bump in the heal already re-queues the source rows for sync.
  await recomputeAnalyticsRollupsFor(
    prisma,
    timestampHeal.healedSessionIds,
    nowFn,
    log
  ).catch((e: unknown) => {
    log(
      `boot: timestamp-format analytics recompute failed: ${e instanceof Error ? e.message : String(e)}`
    );
  });

  // FEA-3591: floor-heal `last_activity_at` BEFORE either sweep below — both
  // consume the stored value. The orphan sweep copies it into `ended_at`
  // (a pre-start value would persist a negative duration) and the retention
  // sweep purges on it (a pre-start value makes the row look older than it is,
  // so it could be purged prematurely — and the purge is sync-blind). Awaited
  // for the same libSQL single-write-transaction reason as the sweeps; the heal
  // is a bounded UPDATE over the (typically tiny, convergent-to-empty)
  // violating set, so the boot cost is negligible.
  //
  // If the heal FAILS (discovery error or any failed chunk), both sweeps are
  // SKIPPED this boot (PR #3334 review, P1): with unhealed rows still in the
  // store, the orphan sweep would stamp a pre-start `ended_at` (a value that
  // is never re-derived) and the retention sweep could permanently delete a
  // row by its corrupted-older timestamp before the promised next-boot retry.
  // Skipping only delays cleanup by one boot; deletion is irreversible.
  let sweepsBlockedByFailedHeal = false;
  await healSessionLastActivityAtFloor(prisma, nowFn(), log)
    .then(({ healed, failedChunks }) => {
      if (healed > 0) {
        log(`boot: floored last_activity_at on ${healed} session(s)`);
      }
      if (failedChunks > 0) {
        sweepsBlockedByFailedHeal = true;
      }
    })
    .catch((e: unknown) => {
      sweepsBlockedByFailedHeal = true;
      log(
        `boot: last-activity floor heal failed: ${e instanceof Error ? e.message : String(e)}`
      );
    });

  if (sweepsBlockedByFailedHeal) {
    log(
      "boot: skipping orphan + retention sweeps — the last-activity floor heal did not complete, and sweeping unhealed rows could stamp pre-start ended_at values or purge rows by corrupted timestamps; both retry next boot"
    );
  } else {
    // ISS-4654: the FEA-3593 swept-session ended_at heal ran here. It is retired
    // — it selected `status = 'abandoned'` only, and migration 0042 collapses
    // that status to `inactive` at boot BEFORE this point, having already
    // performed the same ended_at repair for exactly this population (see the
    // @whitlockk note in 0042). The heal could therefore never match another row.

    // Gap 8: Sweep orphaned sessions left in 'active' status by a process kill
    // that never delivered a SessionEnd hook. Runs once at boot, before the
    // importer starts, so stale sessions are cleaned up proactively.
    //
    // Awaited (not fire-and-forget) under libSQL: a single connection can hold
    // only one open write transaction at a time, so an in-flight sweep
    // transaction would force any concurrent write to fail with SQLITE_BUSY.
    // Completing the sweep before returning the handle guarantees no write
    // transaction is open when the caller (or a test) starts writing. The sweep
    // is a single fast UPDATE over the orphan set, so the boot cost is
    // negligible.
    await sweepOrphanedSessions(prisma, nowFn())
      .then(({ swept, heldBack }) => {
        if (swept > 0) {
          log(`boot: swept ${swept} orphaned session(s) to inactive/error`);
        }
        // ISS-5429: a held-back row is one whose timestamps survived BOTH heals
        // above in a form the sweep cannot compare soundly, so it stays `active`
        // — and, never terminal, outside the retention purge too. That used to
        // happen with nothing counting or logging it. The bad-data rule forbids
        // silently dropping a value that cannot be right; this is the report.
        if (heldBack > 0) {
          log(
            `boot: held back ${heldBack} stale session(s) with non-canonical timestamps the format heal did not repair; they stay active`
          );
        }
      })
      .catch((e: unknown) =>
        log(
          `boot: orphaned-session sweep failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );

    // Privacy / data-governance: purge terminal sessions older than the
    // retention window so the local store does not keep full session history
    // (transcripts, tool calls, token usage, agents) indefinitely. Runs once
    // per boot, right after the orphan sweep and before the importer — and,
    // like it, is awaited so no retention-delete transaction is left open under
    // libSQL's single connection when the caller starts writing.
    //
    // ISS-5492: only in the STEADY state is this the sessions crossing the
    // window on this boot. The FIRST sweep on an install older than the window
    // purges the whole backlog in one transaction, so the sweep chunks its child
    // deletes (`SWEEP_ID_CHUNK`) rather than relying on the set being small.
    //
    // ISS-6031: `deferredUndelivered` is reported alongside the purge count. A
    // past-window session that still holds a `pending` outbox row is kept, not
    // deleted — purging it destroys, on the only machine that has it, data the
    // cloud never received. Logged so a store accumulating undeliverable history
    // is visible rather than indistinguishable from an empty sweep.
    await sweepExpiredSessions(prisma, nowFn(), options.retentionDays)
      .then(({ purged, deferredUndelivered }) => {
        if (purged > 0) {
          log(`boot: purged ${purged} session(s) past the retention window`);
        }
        if (deferredUndelivered > 0) {
          log(
            `boot: kept ${deferredUndelivered} session(s) past the retention window that still owe the cloud a delivery (pending sync outbox row)`
          );
        }
      })
      .catch((e: unknown) =>
        log(
          `boot: retention sweep failed: ${e instanceof Error ? e.message : String(e)}`
        )
      );
  }

  // ISS-6168: claim the sessions the pre-fix importer wrote with a NULL owner so
  // the desktop Owner column resolves for the existing corpus, not just for
  // sessions imported from here on. Runs AFTER the retention purge (never stamp
  // a row this boot is about to delete) and, like the sweeps, is awaited so no
  // write transaction is open when the caller starts writing. Identity-scoped
  // and non-inventing — see claimUnownedSessionIdentity for the exact rule.
  //
  // The provider read is wrapped: it is evaluated as an ARGUMENT, so a throw
  // would land outside the `.catch` below and reject `openSqliteAgentDatabase`
  // itself — which the db-host Init handler reports exactly like a migration
  // refusal, taking the whole local database down. Losing attribution for one
  // boot is recoverable (the next boot re-claims); losing the database is not.
  // Same rule the two INSERT paths already honor via buildSessionIdentityInsert.
  await claimUnownedSessionIdentity(
    prisma,
    safe(() => options.getUserIdentity?.()) ?? null
  )
    .then(({ claimed, skipped }) => {
      if (claimed > 0) {
        log(`boot: attributed ${claimed} previously unowned session(s)`);
      }
      if (skipped === SessionOwnerClaimSkip.ForeignOwnerPresent) {
        log(
          "boot: left unowned sessions unattributed — this store also holds another account's sessions, and local evidence cannot say which account the unowned ones belong to"
        );
      }
    })
    .catch((e: unknown) =>
      log(
        `boot: session owner claim failed: ${e instanceof Error ? e.message : String(e)}`
      )
    );

  const database: SqliteAgentDatabase = {
    backend: "sqlite",
    connection: null,
    prisma,
    writeQueue: queue,
    importer: createSqliteImporter(prisma, tokenUsage, {
      detectBillingMode: options.detectBillingMode,
      // ISS-6168: the importer stamps `user_id`/`organization_id` from the same
      // provider the live-hook lifecycle below uses. Omitting it here is what
      // left every imported session unattributed.
      getUserIdentity: options.getUserIdentity,
      // ISS-8757: the same probe the rebuild gate uses, so the event-content
      // bracket in the incremental import folds with the real row digest.
      supportsRowDigest,
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
      // ISS-4572: hand the importer the write-queue's TASK-SCOPED eviction so a
      // bounded historical import that times out can ACTIVELY EVICT its OWN wedged
      // write (identified by session id) from the shared queue, letting later
      // sources proceed instead of parking behind the never-completing write —
      // without ever taking an unrelated healthy session's transaction as victim.
      cancelInFlightWrite: (sessionId, reason) =>
        queue.cancel(sessionId, reason),
      // ISS-7256: the read-only counterpart, so the bound can tell a session that
      // WEDGED the writer from one that only ever waited behind another owner's
      // write — without evicting the latter to find out. This is the IN-PROCESS
      // answer, read straight off the queue. In DB-host mode the same op path is
      // answered by the dispatcher's mirror instead and never reaches here, for
      // the reason `write-dispatch-mirror.ts` gives.
      hasUndispatchedWrite: (sessionId) =>
        queue.probeUndispatchedTask(sessionId),
    }),
    syncSource: createSqliteSessionSyncSource(prisma, log),
    transcriptSync: createTranscriptSyncStore(prisma),
    collectorIngestStores: {
      loadAll: () => loadCollectorIngestStores(prisma),
      save: (storeKey, formatVersion, payload) =>
        saveCollectorIngestStore(prisma, storeKey, formatVersion, payload),
    },
    sessions,
    agents,
    events,
    tokenUsage,
    claudeCodeOtel: {
      // ISS-7352: the production caller `persistClaudeCodeOtelSignals` never
      // had. Signals arrive already narrowed by the OTLP normalizer; the
      // persister re-validates and reports each rejection, so a single
      // malformed signal costs its own row and not the batch.
      persistSignals: async (signals: ClaudeCodeOtelSideTableSignal[]) => {
        // The parameter type excludes `token_usage`, but this facade is a
        // process boundary: the db-host receives whatever IPC hands it. A
        // transcript-owned total must not be overwritable through here, so the
        // discriminant is re-checked at runtime and offenders are counted as
        // rejected rather than silently dropped.
        const admissible: ClaudeCodeOtelSideTableSignal[] = [];
        let refused = 0;
        for (const signal of signals) {
          if (isTokenUsageOtelSignal(signal)) {
            refused += 1;
            log(
              "claude-code otel signal rejected: token_usage is owned by the transcript parser and cannot be written through the OTel lane"
            );
            continue;
          }
          admissible.push(signal);
        }
        if (admissible.length === 0) {
          return { accepted: 0, rejected: refused };
        }
        const summary = await persistClaudeCodeOtelSignals(
          { prisma, events: admissible },
          {
            warn: (warning) =>
              log(
                `claude-code otel signal ${warning.index} (${warning.signalType ?? "untyped"}) rejected: ${warning.issues.join("; ")}`
              ),
            // ISS-10720: the invocation-attribution refresh's per-session tally.
            log,
          }
        );
        return {
          accepted: summary.accepted,
          rejected: summary.rejected + refused,
        };
      },
      recordSignalDrop: (input) => signalDropRecorder.record(input),
    },
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
          // ISS-6168: a live Codex run's OTel batch usually creates the session
          // row before the importer sees the transcript, so this writer owns the
          // owner stamp for those rows.
          getUserIdentity: options.getUserIdentity,
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
    // ISS-6168: the post-open re-claim seam. See the contract for why the boot
    // pass alone is not enough (identity is routinely null at db open).
    claimSessionOwnerIdentity: (identity) =>
      claimUnownedSessionIdentity(prisma, identity),
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
    // ISS-5400: the maintenance slice (data-revision rebuild, session deletion,
    // rollup recompute, repo-identity/historical backfill, PR-link remediation,
    // timestamp normalization, pack install-run recording) lives in
    // `./sqlite-maintenance-facade.js`. It spreads `createStoreHealthMethods`
    // internally, so key precedence within the returned object is unchanged.
    ...createMaintenanceFacade({
      prisma,
      log,
      nowFn,
      detectBillingMode: options.detectBillingMode,
      getUserIdentity: options.getUserIdentity,
      supportsRowDigest,
      tokenUsage,
    }),
    ...createDiagnosticsMethods(prisma, log),
    ...createBranchCanonicalActivityReadMethods(prisma),
    ...createBranchMetricEventEvidenceMethods(prisma),
    close: async () => {
      // ISS-6339: stop the perf timer before anything else so a tick cannot fire
      // against a torn-down connection.
      storePerfSampler.stop();
      await queue.drain();
      await prisma.disconnect().catch(() => undefined);
      await db.close();
    },
  };

  return database;
}
