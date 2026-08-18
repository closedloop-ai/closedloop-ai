/**
 * @file data-revision-rebuild.ts
 * @description FEA-1785 boot-time data-revision rebuild. After the initial
 * import pass settles, re-derives every session whose `data_revision` differs
 * from the current `DATA_REVISION` and whose source transcript still exists:
 * per-session transactional delete + re-parse + re-insert via the normal
 * import path. Sessions whose source is gone keep their existing derived rows;
 * their `session_analytics` rollup IS recomputed from stored metadata
 * (FEA-2641). Revision 38 can then conservatively rebuild invocation-derived
 * rows from deterministic stored data and stamp only on success; older rebuild
 * policies leave the revision stale as the durable retry marker. Active
 * sessions are skipped — the ordinary reimport path re-derives and stamps them. A
 * surviving source whose parse yields no session under current semantics
 * (e.g. the codex re-serialization burst signature) is an import artifact and
 * its local session row is deleted outright.
 */

import type { AnalyticsRollupRecomputeResult } from "../../database/analytics-recompute.js";
import {
  type Harness,
  type HarnessCollector,
  type NormalizedSession,
  narrowHarness,
} from "../types.js";
import {
  COMPONENT_INVOCATION_STORED_REBUILD_REVISION,
  DATA_REVISION,
} from "./data-revision.js";
import { pruneFoldedChildRows } from "./data-revision-folded-child-prune.js";
import {
  createRebuildOutstanding,
  markRetryable,
  outstandingRemaining,
  type RebuildOutstanding,
} from "./data-revision-rebuild-outstanding.js";
import {
  createDataRevisionRebuildProgressReporter,
  type DataRevisionRebuildProgress,
} from "./data-revision-rebuild-progress.js";
import { rebuildStoredComponentInvocations } from "./data-revision-rebuild-stored-invocations.js";
import { isHistoricalParseWorkerParserOutputError } from "./historical-parse-worker-protocol.js";
import { isImportableCollectorSource } from "./source-admission.js";

// ISS-4586 / ISS-4654: `inactive` is the canonical terminal-not-failed session
// status. The legacy completed/abandoned entries are gone with the rest of the
// retired vocabulary — migration 0042 runs at boot, so no local row can carry
// one. Mirrors `TERMINAL_STATUS_SET` in db-constants.ts; kept as a local literal
// so this collector-engine module stays free of the db-runtime import.
const TERMINAL_STATUS_SET = new Set(["inactive", "error"]);
// ISS-4711: the full cooperative pause taken after each session write WHILE the
// db-host is under memory pressure OR the renderer just read (so GC/WAL reclaim
// and the UI stays responsive). Historically this flat 50ms was paid after
// EVERY write — a ~7h drain for a ~2,888-session corpus (~5/min). It is now the
// PRESSURE/ACTIVE-path pause only; the idle fast path skips it (see
// `resolveWritePauseMs`).
export const DATA_REVISION_REBUILD_WRITE_PAUSE_MS = 50;
// ISS-4711: idle fast-path pause. When neither memory pressure nor a recent
// renderer read holds, we drop to a 0ms cooperative yield: still a real
// `setImmediate`/loop-turn boundary so queued renderer IPC reads are serviced
// between writes (the UI never janks), but with no flat sleep floor — turning
// the multi-hour serial drain into minutes for a multi-thousand-session corpus.
export const DATA_REVISION_REBUILD_IDLE_PAUSE_MS = 0;

export type DataRevisionRebuildDatabase = {
  listStaleRevisionSessions(
    currentRevision: number
  ): Promise<Array<{ id: string; harness: string | null; status: string }>>;
  rebuildSessionFromParse(
    session: NormalizedSession,
    harness: Harness
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    storageReset?: boolean;
    /**
     * FEA-3659: true when the re-derived payload actually changed (the session's
     * `updated_at` sync watermark was bumped), so the row must (re-)sync to the
     * cloud. Undefined/false for a byte-identical re-derivation, which stamps only
     * `data_revision` and is a true sync no-op.
     */
    contentChanged?: boolean;
  }>;
  /**
   * FEA-3294 revision-38 bridge. Reconstructs the complete invocation
   * projection from stored deterministic rows in one DB transaction. It must
   * not read transcripts, the network, or live definition files, and must
   * leave both prior rows and the stale revision stamp intact on failure.
   */
  rebuildComponentInvocationsFromStoredRows?(
    sessionId: string,
    currentRevision: number
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    storageReset?: boolean;
    contentChanged?: boolean;
  }>;
  deleteSessionRow(sessionId: string): Promise<void>;
  /**
   * FEA-2641: optional hook — recompute `session_analytics` rollups from the
   * STORED session metadata for stale sessions whose source transcript no
   * longer exists (the rebuild cannot re-parse them, but the corrected rollup
   * SQL heals their human/agent classification from what is already in the DB).
   */
  recomputeAnalyticsRollups?(
    sessionIds: string[]
  ): Promise<AnalyticsRollupRecomputeResult>;
};

export type DataRevisionRebuildOptions = {
  collectors: readonly HarnessCollector[];
  db: DataRevisionRebuildDatabase;
  log?: (message: string) => void;
  /** Parser hook for keeping rebuild parsing off Electron's main process. */
  parseSource?: DataRevisionParseSource;
  /** Cooperative pause between main-process maintenance writes. */
  cooperativeDelay?: (ms: number) => Promise<void>;
  /**
   * ISS-4711: adaptive-pause gate — returns `true` while the db-host is under
   * memory pressure (`getMemoryPressure().level === "high"`). When set and
   * true, `pauseAfterWrite` takes the FULL cooperative pause so GC/WAL
   * checkpoint can reclaim; when absent or false the memory-pressure input to
   * the gate is treated as clear. Optional so the signal (which lives in the DB
   * host process) can be omitted, in which case the rebuild falls back to the
   * renderer-read input alone.
   *
   * ISS-4823: the production call site now supplies this. The db host publishes
   * its pressure level to main over the reverse channel and
   * `DbHostClient.isUnderMemoryPressure()` answers from that cached value — the
   * signal cannot be read synchronously across the process boundary any other
   * way, and a callback can never cross the method proxy. This arm is NOT
   * redundant with the db host's own back-pressure: that covers the two
   * `HEAVY_STORE_OPS` backfills, while this rebuild's `rebuildSessionFromParse`
   * writes take the generic invoke dispatch, which is neither heavy-op-gated nor
   * pressure-yielded.
   */
  isDbHostUnderMemoryPressure?: () => boolean;
  /**
   * ISS-4711: adaptive-pause gate — returns `true` when a renderer IPC read
   * landed within the recent quiet window (so the UI is actively being served).
   * When set and true, `pauseAfterWrite` takes the FULL cooperative pause to
   * yield the loop to the renderer; when absent or false the rebuild treats the
   * renderer as idle. Optional so this module stays testable without wiring the
   * main-process renderer-activity signal.
   */
  hasRecentRendererRead?: () => boolean;
  /** Cancellation hook used by the desktop runtime stop/close lifecycle. */
  shouldContinue?: () => boolean;
  /**
   * Select the approved FEA-3294 revision-38 hybrid migration. Source-present
   * sessions still use the normal parser rebuild; only missing sources and
   * historical parser-output failures use conservative stored-row recovery.
   * Explicit at the production call site so future revisions can choose their
   * own rebuild policy without inheriting revision-38 fallback semantics.
   */
  useStoredComponentInvocationRebuild?: boolean;
  /**
   * ISS-5808: hand this pass's summary to the caller on EVERY exit path,
   * including a throw. A db-host exit abandons the pass mid-drain, and the
   * sessions it had already COMMITTED before the child died are recorded only in
   * this in-memory object — the rejection carries none of it. Because the
   * rebuild is cursored on the `data_revision` stamp, those rows are now current
   * and a re-driven attempt correctly excludes them, so without this seam the
   * committed work exists in the database but appears in no summary at all: it is
   * never enqueued into the sync outbox and never triggers
   * `invalidateHistoricalDetails()`.
   *
   * Called exactly once per invocation, from a `finally`, so a re-drive can
   * reconcile the attempts rather than treating the last one as authoritative.
   * See `mergeDataRevisionRebuildSummaries`.
   */
  reportSummary?: (summary: DataRevisionRebuildSummary) => void;
  /**
   * ISS-6241: per-session progress for the splash's Compute step, which
   * otherwise renders a bare dot for a pass that runs for hours. Emitted only
   * once this attempt's terminal-stale population is known and non-empty, so a
   * consumer never receives a denominator the pass cannot substantiate. Optional
   * because the population signal is a UI affordance, not part of the rebuild's
   * contract — every non-UI caller (and every test that predates this) omits it.
   */
  reportProgress?: (progress: DataRevisionRebuildProgress) => void;
};

export type DataRevisionRebuildSummary = {
  staleTotal: number;
  rebuilt: number;
  deleted: number;
  skippedActive: number;
  raceSkipped: number;
  missingSource: number;
  unmatchedSource: number;
  parseErrors: number;
  errors: number;
  storageReset: boolean;
  /**
   * FEA-2641: missing-source sessions whose analytics rollup was recomputed
   * from stored metadata (0 when the db hook is absent, when the recompute threw
   * before committing anything, or when every chunk's primary transaction
   * failed).
   *
   * ISS-5071: this is the PRIMARY `session_analytics` commit count, NOT the
   * fully-repaired count — a session whose analytics transaction committed but
   * whose secondary activity-metrics refresh failed is counted here AND leaves
   * the revision stamp withheld. That is deliberate: this number exists so
   * post-boot maintenance can decide whether rows changed out-of-band and the
   * renderer's caches must be dropped, and rows DID change in that case.
   */
  missingSourceRollupsRecomputed: number;
  /**
   * FEA-3659: ids of the sessions that were rebuilt AND whose re-derived payload
   * actually changed (their `updated_at` sync watermark advanced). This is the
   * explicit changed-set the runtime enqueues into the durable sync outbox so a
   * DATA_REVISION bump propagates exactly these rows to the cloud — never the
   * whole corpus and never a byte-identical no-op. A subset of `rebuilt`.
   */
  changedSessionIds: string[];
};

/** A zero-valued summary: the accumulator every rebuild pass starts from. */
export function createEmptyDataRevisionRebuildSummary(): DataRevisionRebuildSummary {
  return {
    staleTotal: 0,
    rebuilt: 0,
    deleted: 0,
    skippedActive: 0,
    raceSkipped: 0,
    missingSource: 0,
    unmatchedSource: 0,
    parseErrors: 0,
    errors: 0,
    storageReset: false,
    missingSourceRollupsRecomputed: 0,
    changedSessionIds: [],
  };
}

/**
 * ISS-5808: the accumulator is created HERE, outside the pass, so
 * `options.reportSummary` can hand it back on a throw as well as on a return —
 * the committed-work carry a re-drive needs. The pass itself is unchanged below.
 */
export async function runDataRevisionRebuild(
  options: DataRevisionRebuildOptions
): Promise<DataRevisionRebuildSummary> {
  const summary = createEmptyDataRevisionRebuildSummary();
  try {
    return await runDataRevisionRebuildInto(options, summary);
  } finally {
    options.reportSummary?.(summary);
  }
}

async function runDataRevisionRebuildInto(
  options: DataRevisionRebuildOptions,
  summary: DataRevisionRebuildSummary
): Promise<DataRevisionRebuildSummary> {
  const log = options.log ?? (() => {});
  const shouldContinue = options.shouldContinue ?? (() => true);

  const stale = await options.db.listStaleRevisionSessions(DATA_REVISION);
  summary.staleTotal = stale.length;
  if (stale.length === 0 || !shouldContinue()) {
    return summary;
  }

  const pass = createRebuildPass(options, summary, stale, log, shouldContinue);
  pass.reportProgress();
  await drainCollectorSources(pass);
  absorbUncollectedHarnesses(pass);
  await runRepairTail(pass);

  logRebuildSummary(summary, log);
  return summary;
}

function logRebuildSummary(
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void
): void {
  log(
    `data-revision rebuild complete (revision ${DATA_REVISION}): stale=${summary.staleTotal} rebuilt=${summary.rebuilt} deleted=${summary.deleted} skippedActive=${summary.skippedActive} raceSkipped=${summary.raceSkipped} missingSource=${summary.missingSource} missingSourceRollupsRecomputed=${summary.missingSourceRollupsRecomputed} unmatchedSource=${summary.unmatchedSource} parseErrors=${summary.parseErrors} errors=${summary.errors} storageReset=${summary.storageReset}`
  );
}

/**
 * Group terminal stale sessions by harness key. Non-terminal sessions
 * (active, running, etc.) heal via ordinary reimport (which stamps the
 * revision) — rebuilding mid-capture would race the live write paths — so
 * they only bump `skippedActive`.
 */
function groupTerminalStaleByHarness(
  stale: Array<{ id: string; harness: string | null; status: string }>,
  summary: DataRevisionRebuildSummary
): Map<string, Set<string>> {
  const pendingByHarness = new Map<string, Set<string>>();
  for (const row of stale) {
    if (!TERMINAL_STATUS_SET.has(row.status)) {
      summary.skippedActive++;
      continue;
    }
    const key = row.harness ?? "";
    const existing = pendingByHarness.get(key);
    if (existing) {
      existing.add(row.id);
    } else {
      pendingByHarness.set(key, new Set([row.id]));
    }
  }
  return pendingByHarness;
}

/**
 * FEA-2641: sessions without a surviving source can't be re-parsed, but their
 * analytics rollup CAN be recomputed from the stored metadata — the corrected
 * human/agent classification must reach them too, or they keep their polluted
 * is_human forever. Revision 38 runs this before its stored invocation fallback;
 * a successful fallback then stamps the revision. Older policies preserve the
 * stale stamp and revisit this small population on later boots. The analytics
 * repair remains best-effort, but revision 38 withholds its stored fallback
 * stamp when that repair fails so the session stays retryable on the next boot.
 *
 * Returns the STAMP-READY ids only. The separate "how many analytics rows
 * actually changed" answer lands on `summary.missingSourceRollupsRecomputed`
 * (ISS-5071) because the caller's cache-invalidation decision and its stamp
 * decision are different questions with different answers.
 *
 * ISS-6165: this returned a single boolean for the whole cohort, which made one
 * failing chunk withhold the stamp from every session in the pass. It now
 * returns the subset cleared to stamp, so a partial failure retires the sessions
 * that repaired and leaves only the ones that did not.
 */
async function recomputeMissingSourceRollups(
  db: DataRevisionRebuildDatabase,
  missingSourceIds: string[],
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void
): Promise<string[]> {
  if (missingSourceIds.length === 0) {
    return [];
  }
  // FEA-3597: a MISSING bridge is FAILURE for a non-empty id list, not success.
  // This used to report readiness here, so a caller gating a `data_revision`
  // stamp on it would stamp sessions nothing had repaired — the opposite of this
  // function's own documented intent.
  if (!db.recomputeAnalyticsRollups) {
    log(
      `data-revision rebuild: no rollup-recompute bridge for ${missingSourceIds.length} session(s); withholding the stamp so they stay retryable`
    );
    return [];
  }
  try {
    const result = await db.recomputeAnalyticsRollups(missingSourceIds);
    // ISS-5071 (@wongk): the PRIMARY analytics outcome and the full-repair
    // failure count are two independent axes, and this function must not
    // conflate them. `committed` is what the caller invalidates caches on (it
    // counts sessions whose `session_analytics` transaction actually landed,
    // including chunks whose SECONDARY metrics refresh then failed); `failed`
    // is the stamp gate alone. The old `attempted - failed` arithmetic reported
    // a one-session metrics-only failure as zero recomputes, which made
    // post-boot maintenance skip `invalidateHistoricalDetails()` and
    // `desktop:db:changed` and left mounted Insights queries stale against rows
    // that HAD been rewritten.
    summary.missingSourceRollupsRecomputed = result.committed;
    // FEA-3597: the recompute catches per-chunk failures internally and never
    // throws, so "it did not throw" is NOT evidence of repair. Gate on the real
    // per-chunk outcome instead.
    if (result.failed > 0) {
      // ISS-6165: withhold exactly the sessions the bridge names as unrepaired,
      // and only when its answer can be trusted to BE that set — see
      // `resolveNamedFailures` for the three checks and why a count match alone
      // is not one of them. Anything short of all three degrades to the
      // conservative cohort-wide withholding, the same as an absent set: an
      // unknown failure set must never read as an empty one.
      const failedIds = result.failedSessionIds;
      const withheld = resolveNamedFailures(
        failedIds,
        result.failed,
        missingSourceIds
      );
      const readyIds = withheld
        ? missingSourceIds.filter((id) => !withheld.has(id))
        : [];
      const outcome = describeStampWithholding(
        withheld,
        failedIds,
        missingSourceIds.length,
        readyIds.length
      );
      log(
        `data-revision rebuild: missing-source rollup recompute failed for ${result.failed}/${result.attempted} session(s); ${result.committed} committed, ${outcome}`
      );
      return readyIds;
    }
    return missingSourceIds;
  } catch (error) {
    log(
      `data-revision rebuild: missing-source rollup recompute failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

async function rebuildHarness(
  collector: HarnessCollector,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean,
  outstanding: RebuildOutstanding,
  reportProgress: () => void
): Promise<void> {
  // Narrow the discriminant: listSourcesForRebuild is batch-only,
  // sessionIdForSource is file-only. Each view is undefined for the other kind,
  // preserving the prior optional-chaining fallbacks.
  const { fileCollector, batchCollector } = narrowHarness(collector);
  const sources =
    batchCollector?.listSourcesForRebuild?.() ?? collector.listSources();
  const unmappedParserErrorPending = new Set<string>();
  const unmappedSourcePresentRetryPending = new Set<string>();
  for (const source of sources) {
    if (pending.size === 0) {
      return;
    }
    if (!shouldContinue()) {
      countUnmappedParserErrors(
        pending,
        summary,
        unmappedParserErrorPending,
        outstanding
      );
      return;
    }
    if (!isImportableCollectorSource(collector, source)) {
      continue;
    }
    const sid = fileCollector?.sessionIdForSource?.(source) ?? null;
    if (sid === null) {
      await rebuildUnmappedSource(
        collector,
        source,
        pending,
        db,
        summary,
        log,
        parseSource,
        pauseAfterWrite,
        shouldContinue,
        unmappedParserErrorPending,
        unmappedSourcePresentRetryPending,
        outstanding,
        reportProgress
      );
      reportProgress();
      continue;
    }
    if (!pending.has(sid)) {
      continue;
    }
    await rebuildMappedSource(
      collector,
      source,
      sid,
      pending,
      db,
      summary,
      log,
      parseSource,
      pauseAfterWrite,
      shouldContinue,
      outstanding
    );
    if (summary.storageReset) {
      return;
    }
    reportProgress();
  }
  for (const sid of unmappedSourcePresentRetryPending) {
    pending.delete(sid);
    unmappedParserErrorPending.delete(sid);
    // shafty023 review: withheld from missing-source fallback precisely BECAUSE
    // a surviving unmapped source may still own them. They stay stale for a
    // later boot, so they are outstanding, not processed.
    markRetryable(outstanding, sid);
  }
  countUnmappedParserErrors(
    pending,
    summary,
    unmappedParserErrorPending,
    outstanding
  );
  reportProgress();
}

function countUnmappedParserErrors(
  pending: Set<string>,
  summary: DataRevisionRebuildSummary,
  unmappedParserErrorPending: Set<string>,
  outstanding: RebuildOutstanding
): void {
  for (const sid of unmappedParserErrorPending) {
    if (pending.delete(sid)) {
      summary.parseErrors++;
      outstanding.parserOutputFallbackIds.add(sid);
    }
  }
}

/**
 * A source that positively maps to a stale session id. If current parsers
 * yield no session for it, the row is an import artifact and is deleted
 * (FEA-1785 §4); the cloud copy is handled by FEA-1787's phantom purge.
 */
async function rebuildMappedSource(
  collector: HarnessCollector,
  source: string,
  sid: string,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean,
  outstanding: RebuildOutstanding
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  const parsed = await parseDataRevisionSource(collector, source, parseSource);
  if (parsed.kind !== DataRevisionSourceParseResultKind.Sessions) {
    handleMappedSourceParseFailure(
      collector.key,
      sid,
      parsed,
      pending,
      summary,
      outstanding,
      log
    );
    return;
  }
  const { sessions } = parsed;
  const match = sessions.find((s) => s.sessionId === sid);
  if (match) {
    if (!shouldContinue()) {
      return;
    }
    await applyRebuild(collector.key, match, pending, db, summary, outstanding);
    if (summary.storageReset) {
      return;
    }
    await pauseAfterWrite();
    return;
  }
  if (sessions.length === 0) {
    await handleEmptyMappedSource(
      collector,
      source,
      sid,
      pending,
      db,
      summary,
      log,
      pauseAfterWrite,
      shouldContinue,
      outstanding
    );
  } else {
    // Source parsed but no session matches the mapped id — distinct from
    // missing-source (file exists and parses fine).
    summary.unmatchedSource++;
    pending.delete(sid);
    // shafty023 review: nothing was rebuilt, deleted, or stamped — the row keeps
    // its stale revision and is re-selected next pass.
    markRetryable(outstanding, sid);
  }
}

/**
 * A source whose session id is unknowable from the path (copilot chat,
 * opencode batch store): parse, then rebuild any stale ids it contains.
 * Never deletes — there is no positive source→id mapping to justify it.
 */
async function rebuildUnmappedSource(
  collector: HarnessCollector,
  source: string,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean,
  unmappedParserErrorPending: Set<string>,
  unmappedSourcePresentRetryPending: Set<string>,
  outstanding: RebuildOutstanding,
  reportProgress: () => void
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  const parsed = await parseDataRevisionSource(collector, source, parseSource);
  if (parsed.kind !== DataRevisionSourceParseResultKind.Sessions) {
    handleUnmappedSourceParseFailure(
      collector.key,
      parsed,
      pending,
      unmappedParserErrorPending,
      unmappedSourcePresentRetryPending,
      log
    );
    return;
  }
  const { sessions } = parsed;
  if (sessions.length === 0) {
    // A surviving batch/unmapped source can own any remaining stale id. An
    // empty parse is therefore not proof those ids have no source; withhold
    // missing-source fallback and retry on a later boot.
    for (const sid of pending) {
      unmappedSourcePresentRetryPending.add(sid);
    }
    return;
  }
  // ISS-5395: prune any pre-fold top-level row for a session THIS parse folded
  // into a root, BEFORE the roots are re-derived below. Revision 69 counts a
  // folded subagent's round-trips on the root, so leaving the stale child row in
  // place would double-count every one of them on the autonomy trend and the
  // activity heatmap.
  const pruned = await pruneFoldedChildRows({
    harness: collector.key,
    sessions,
    pending,
    deleteSessionRow: (sessionId) => db.deleteSessionRow(sessionId),
    log,
    pauseAfterWrite,
    shouldContinue,
  });
  summary.deleted += pruned.deletedIds.length;
  summary.errors += pruned.errors;
  for (const session of sessions) {
    if (pending.size === 0 || !shouldContinue()) {
      return;
    }
    if (pending.has(session.sessionId)) {
      await applyRebuild(
        collector.key,
        session,
        pending,
        db,
        summary,
        outstanding
      );
      if (summary.storageReset) {
        return;
      }
      // shafty023 review: emit from the PER-SESSION transition, not only after
      // the whole batch returns. OpenCode's rebuild source is a single
      // `opencode.db`, so this loop IS the entire pass for that harness — the
      // caller's one report after it returned left a large rebuild sitting at
      // `0 of N` for the full drain and then jumping to `N of N`.
      reportProgress();
      await pauseAfterWrite();
    }
  }
}

async function applyRebuild(
  harness: Harness,
  session: NormalizedSession,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  outstanding: RebuildOutstanding
): Promise<void> {
  const result = await db.rebuildSessionFromParse(session, harness);
  if (result.storageReset) {
    summary.storageReset = true;
    return;
  }
  if (result.rebuilt) {
    summary.rebuilt++;
    // FEA-3659: only rows whose re-derived payload actually changed had their
    // updated_at bumped and therefore need to (re-)sync. A byte-identical
    // re-derivation stamped only data_revision (a true sync no-op), so it is NOT
    // collected — this is what keeps a DATA_REVISION bump from re-uploading the
    // whole corpus.
    if (result.contentChanged) {
      summary.changedSessionIds.push(session.sessionId);
    }
  } else if (result.activeRace) {
    // Deliberately NOT retryable: `staleRebuildSkip` reports an active race only
    // for a session that went non-terminal, which "heals through ordinary import
    // instead" — that path stamps it, so parking it here as outstanding would
    // queue a rebuild for work another codepath already owns.
    summary.raceSkipped++;
  } else {
    summary.errors++;
    // shafty023 review: a failed rebuild leaves the revision stale as the
    // durable retry marker, so this session is outstanding, not processed.
    markRetryable(outstanding, session.sessionId);
  }
  pending.delete(session.sessionId);
}

export type DataRevisionParseSource = (
  collector: HarnessCollector,
  source: string
) => Promise<NormalizedSession[]>;

const DataRevisionSourceParseResultKind = {
  ParserOutputError: "parser_output_error",
  Retry: "retry",
  Sessions: "sessions",
} as const;

type DataRevisionSourceParseResult =
  | {
      kind: typeof DataRevisionSourceParseResultKind.Sessions;
      sessions: NormalizedSession[];
    }
  | {
      kind:
        | typeof DataRevisionSourceParseResultKind.ParserOutputError
        | typeof DataRevisionSourceParseResultKind.Retry;
      error: unknown;
    };

async function parseDataRevisionSource(
  collector: HarnessCollector,
  source: string,
  parseSource: DataRevisionParseSource
): Promise<DataRevisionSourceParseResult> {
  try {
    return {
      kind: DataRevisionSourceParseResultKind.Sessions,
      sessions: await parseSource(collector, source),
    };
  } catch (error) {
    return {
      kind: isHistoricalParseWorkerParserOutputError(error)
        ? DataRevisionSourceParseResultKind.ParserOutputError
        : DataRevisionSourceParseResultKind.Retry,
      error,
    };
  }
}

function handleMappedSourceParseFailure(
  harness: Harness,
  sessionId: string,
  parsed: Exclude<
    DataRevisionSourceParseResult,
    { kind: typeof DataRevisionSourceParseResultKind.Sessions }
  >,
  pending: Set<string>,
  summary: DataRevisionRebuildSummary,
  outstanding: RebuildOutstanding,
  log: (message: string) => void
): void {
  pending.delete(sessionId);
  if (parsed.kind !== DataRevisionSourceParseResultKind.ParserOutputError) {
    // shafty023 review: a mapped `Retry` is a TRANSIENT parse failure — the row
    // keeps its stale revision and a later pass re-selects it. It has left
    // `pending`, so without this it would be credited as processed and the pass
    // could reach `N of N` with this session's work never done.
    markRetryable(outstanding, sessionId);
    return;
  }
  summary.parseErrors++;
  outstanding.parserOutputFallbackIds.add(sessionId);
  log(
    `data-revision rebuild [${harness}]: parseError=${sessionId} ${errorMessage(parsed.error)}`
  );
}

async function handleEmptyMappedSource(
  collector: HarnessCollector,
  source: string,
  sessionId: string,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean,
  outstanding: RebuildOutstanding
): Promise<void> {
  const isBurstArtifact =
    !collector.batch && collector.isBurstArtifactSource?.(source) === true;
  if (!isBurstArtifact) {
    pending.delete(sessionId);
    // shafty023 review: only a burst artifact is safe to delete outright. Any
    // other empty parse leaves the row stale and retryable.
    markRetryable(outstanding, sessionId);
    return;
  }
  if (!shouldContinue()) {
    return;
  }
  await db.deleteSessionRow(sessionId);
  summary.deleted++;
  pending.delete(sessionId);
  await pauseAfterWrite();
  log(
    `data-revision rebuild [${collector.key}]: deleted import artifact ${sessionId} (current parser skips its source)`
  );
}

function handleUnmappedSourceParseFailure(
  harness: Harness,
  parsed: Exclude<
    DataRevisionSourceParseResult,
    { kind: typeof DataRevisionSourceParseResultKind.Sessions }
  >,
  pending: Set<string>,
  unmappedParserErrorPending: Set<string>,
  unmappedSourcePresentRetryPending: Set<string>,
  log: (message: string) => void
): void {
  if (parsed.kind === DataRevisionSourceParseResultKind.ParserOutputError) {
    addPendingSessionIds(unmappedParserErrorPending, pending);
    log(
      `data-revision rebuild [${harness}]: parseError=unmapped-source ${errorMessage(parsed.error)}`
    );
    return;
  }
  addPendingSessionIds(unmappedSourcePresentRetryPending, pending);
}

function addPendingSessionIds(target: Set<string>, pending: Set<string>): void {
  for (const sessionId of pending) {
    target.add(sessionId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ISS-4711: resolve the per-write cooperative-pause duration from the adaptive
 * gate. Under db-host memory pressure OR a recent renderer read, take the full
 * pause (`DATA_REVISION_REBUILD_WRITE_PAUSE_MS`) so GC/WAL checkpoint can reclaim
 * and the renderer's queued IPC reads are serviced without janking the UI. When
 * neither holds, drop to the idle fast-path pause
 * (`DATA_REVISION_REBUILD_IDLE_PAUSE_MS`, 0ms): still a real cooperative yield
 * (the delay hook always reaches a loop-turn boundary), but with no flat 50ms
 * floor — so a few-thousand-session corpus rebuilds in minutes, not hours.
 */
function resolveWritePauseMs(
  underPressure: boolean,
  recentRendererRead: boolean
): number {
  return underPressure || recentRendererRead
    ? DATA_REVISION_REBUILD_WRITE_PAUSE_MS
    : DATA_REVISION_REBUILD_IDLE_PAUSE_MS;
}

/**
 * ISS-4711: build the per-write cooperative-pause callback with the adaptive
 * gate baked in. Keep the full pause (and its pressure-yield) ONLY while the
 * db-host is under memory pressure OR the renderer just read; otherwise drop to
 * the idle fast path so the flat 50ms/session floor no longer stretches a
 * multi-thousand-session rebuild into hours. Either signal being unwired
 * degrades safely to "clear" for that input, so the module stays usable — and
 * testable — with neither wired. Extracted so `runDataRevisionRebuild` stays
 * under the cognitive-complexity ceiling.
 */
function buildAdaptivePauseAfterWrite(
  options: DataRevisionRebuildOptions
): () => Promise<void> {
  const isUnderPressure = options.isDbHostUnderMemoryPressure ?? (() => false);
  const hasRecentRead = options.hasRecentRendererRead ?? (() => false);
  return () =>
    options.cooperativeDelay?.(
      resolveWritePauseMs(isUnderPressure(), hasRecentRead())
    ) ?? Promise.resolve();
}

/**
 * The unrepaired subset the bridge named, or `null` when its answer cannot be
 * trusted to BE that subset.
 *
 * ISS-6165 (@wongk): `failedSessionIds.length === failed` is only a PROXY for
 * parity, and it does not prove these are the failed sessions. Two shapes pass
 * it and then return a genuinely failed session to `readyIds`, stamping a
 * rollup nothing repaired — permanently, because nothing re-selects a stamped
 * session:
 *
 *  - a FOREIGN id — `{failed: 1, failedSessionIds: ["not-in-cohort"]}` withholds
 *    from nobody, so the whole cohort including the real failure is stamped;
 *  - a DUPLICATE — `{failed: 2, failedSessionIds: ["a", "a"]}` collapses to one
 *    withheld id, so the second genuine failure is stamped.
 *
 * Both are the FEA-3597 defect this gate exists to prevent, so the checks are
 * uniqueness, count parity, and membership in the cohort we asked about. The
 * producer promises all three, but the result crosses the db-host
 * `utilityProcess` proxy, where a version-skewed or malformed answer is
 * reachable input rather than a type-forbidden one.
 */
function resolveNamedFailures(
  failedSessionIds: readonly string[] | undefined,
  failed: number,
  cohort: readonly string[]
): Set<string> | null {
  if (failedSessionIds === undefined) {
    return null;
  }
  const named = new Set(failedSessionIds);
  if (named.size !== failedSessionIds.length || named.size !== failed) {
    return null;
  }
  const inCohort = new Set(cohort);
  for (const id of named) {
    if (!inCohort.has(id)) {
      return null;
    }
  }
  return named;
}

/**
 * The stamp-withholding clause of the recompute-failure log line.
 *
 * The three branches must NOT share a "withholding N" phrasing. On both
 * fallbacks N is the whole cohort, so printing it beside the bridge's true
 * `failed` count puts two numbers that measure different things in one
 * sentence — an operator debugging exactly the ISS-6165 non-convergence would
 * read the wider number as the bug recurring. The two fallbacks are also kept
 * distinct from each other: "did not name" is an older host build and expected,
 * while "named an inconsistent set" means the bridge itself is wrong and is
 * worth chasing.
 */
function describeStampWithholding(
  withheld: Set<string> | null,
  named: readonly string[] | undefined,
  cohortSize: number,
  readyCount: number
): string {
  if (withheld) {
    return `withholding the stamp for the ${cohortSize - readyCount} session(s) it named`;
  }
  if (named === undefined) {
    return `withholding the stamp for all ${cohortSize} session(s) (the bridge did not name the unrepaired subset)`;
  }
  return `withholding the stamp for all ${cohortSize} session(s) (the bridge named ${named.length} session(s) that are not a unique subset of the cohort matching its own failure count)`;
}

/**
 * The mutable state one rebuild attempt drains, plus the collaborators every
 * stage of the drain needs.
 *
 * The pass is three stages over ONE set of live sets — the collector walk, the
 * uncollected-harness sweep, and the repair tail — and the progress reporter
 * reads those same sets to answer "how far through". Threading them as one
 * value is what lets each stage be its own function without the reporter losing
 * sight of the sets it measures.
 */
type DataRevisionRebuildPass = {
  options: DataRevisionRebuildOptions;
  summary: DataRevisionRebuildSummary;
  log: (message: string) => void;
  parseSource: DataRevisionParseSource;
  pauseAfterWrite: () => Promise<void>;
  shouldContinue: () => boolean;
  pendingByHarness: Map<string, Set<string>>;
  /** Ids out of `pendingByHarness` that the pass has not finished with. */
  outstanding: RebuildOutstanding;
  missingSourceIds: string[];
  /** The repair tail has finished, so its cohort is genuinely done. */
  repairTailComplete: boolean;
  reportProgress: () => void;
};

function createRebuildPass(
  options: DataRevisionRebuildOptions,
  summary: DataRevisionRebuildSummary,
  stale: Array<{ id: string; harness: string | null; status: string }>,
  log: (message: string) => void,
  shouldContinue: () => boolean
): DataRevisionRebuildPass {
  const pass: DataRevisionRebuildPass = {
    options,
    summary,
    log,
    parseSource:
      options.parseSource ?? ((collector, source) => collector.parse(source)),
    pauseAfterWrite: buildAdaptivePauseAfterWrite(options),
    shouldContinue,
    pendingByHarness: groupTerminalStaleByHarness(stale, summary),
    outstanding: createRebuildOutstanding(),
    missingSourceIds: [],
    repairTailComplete: false,
    reportProgress: () => {
      // Replaced below; the reporter has to close over `pass` itself.
    },
  };
  // Created AFTER grouping, so the denominator is the population this attempt
  // will actually work rather than the raw stale count.
  pass.reportProgress = createDataRevisionRebuildProgressReporter(
    pass.pendingByHarness,
    options.reportProgress,
    // ISS-6241: ids that have LEFT the pending sets but the pass is not done
    // with — the two repair cohorts, plus every id still owed a retry. Counted
    // as outstanding so the source walk ending cannot read as the whole pass
    // finishing. A session moving from `pending` into one of these leaves the
    // numerator unchanged, so the count never goes backwards.
    () => outstandingRemaining(pass.outstanding, pass.repairTailComplete)
  );
  return pass;
}

/** Re-derive every stale session whose collector still has its source. */
async function drainCollectorSources(
  pass: DataRevisionRebuildPass
): Promise<void> {
  for (const collector of pass.options.collectors) {
    const pending = pass.pendingByHarness.get(collector.key);
    if (!pending?.size) {
      continue;
    }
    await rebuildHarness(
      collector,
      pending,
      pass.options.db,
      pass.summary,
      pass.log,
      pass.parseSource,
      pass.pauseAfterWrite,
      pass.shouldContinue,
      pass.outstanding,
      pass.reportProgress
    );
    if (pass.summary.storageReset) {
      return;
    }
    // Whatever is left has no surviving, positively-mapped source.
    pass.log(
      `data-revision rebuild [${collector.key}]: missingSource=${pending.size}`
    );
    deferToRepairTail(pass, collector.key, pending);
    pass.reportProgress();
  }
}

/**
 * Stale sessions whose harness has no collector (null/unknown) can never be
 * re-derived — count them with the missing-source population.
 */
function absorbUncollectedHarnesses(pass: DataRevisionRebuildPass): void {
  if (pass.summary.storageReset) {
    return;
  }
  for (const [key, orphaned] of pass.pendingByHarness) {
    deferToRepairTail(pass, key, orphaned);
  }
  pass.reportProgress();
}

/**
 * Move a harness's unresolved ids out of the pending map and into the repair
 * cohort.
 *
 * ISS-6241: missing-source is not DONE — these ids become `repairableIds` and
 * are worked by the repair tail, so they stay outstanding rather than letting
 * the map delete credit them as finished. The map entry goes so `sumPending`
 * stops counting them twice.
 */
function deferToRepairTail(
  pass: DataRevisionRebuildPass,
  harnessKey: string,
  unresolved: Set<string>
): void {
  pass.summary.missingSource += unresolved.size;
  pass.missingSourceIds.push(...unresolved);
  for (const sessionId of unresolved) {
    pass.outstanding.repairPendingIds.add(sessionId);
  }
  pass.pendingByHarness.delete(harnessKey);
}

/**
 * The tail that works the sessions no re-parse could reach: recompute their
 * rollups, then (where the revision allows) rebuild their invocations from
 * stored rows.
 *
 * FEA-3597: `parserOutputFallbackIds` are ids whose re-parse threw a
 * parser-output error. They were REMOVED from `pending` before being added
 * there, so they are NOT in `missingSourceIds` and the rollup recompute never
 * saw them — yet they flowed into `rebuildStoredComponentInvocations`, which
 * rebuilds only invocation rows and then unconditionally stamps
 * `data_revision`. That SEALED them at the new revision with derived rows
 * (including `session_turn_bucket`) still on the old semantics, and because the
 * stamp was current nothing ever selected them again. The affected set is the
 * sessions that blew the worker payload budget — i.e. the largest ones, the
 * biggest contributors to the very counts this revision corrects.
 *
 * Both cohorts therefore go through the same rollup recompute and the same
 * readiness gate, so a failed repair leaves the revision stale and retryable
 * instead of sealing bad data.
 */
async function runRepairTail(pass: DataRevisionRebuildPass): Promise<void> {
  const repairableIds = [
    ...new Set([
      ...pass.missingSourceIds,
      ...pass.outstanding.parserOutputFallbackIds,
    ]),
  ];
  // ISS-6165: the stamp gate is PER SESSION. It used to be one boolean for the
  // whole pass, so a single failing chunk withheld the stamp from every
  // repairable session — the 439 that fully repaired stayed stale alongside the
  // 1 that did not. The next pass then re-selected the identical cohort and hit
  // the identical failure, so the rebuild could log `complete` indefinitely
  // while retiring nothing. Withholding exactly the sessions that failed makes
  // each pass monotonically reduce the stale population, which is what
  // convergence means here.
  let stampReadyIds: string[] = repairableIds;
  if (!pass.summary.storageReset && pass.shouldContinue()) {
    stampReadyIds = await recomputeMissingSourceRollups(
      pass.options.db,
      repairableIds,
      pass.summary,
      pass.log
    );
  }
  // ISS-6241 (shafty023 review): the sessions the recompute WITHHELD a stamp
  // from were not repaired — they keep the stale revision as their retry marker
  // and a later pass re-selects them. `repairTailComplete` retires the repair
  // cohorts wholesale, so without this a partial repair still published `N of N`
  // while naming its own failures in the log line above it.
  const stampReady = new Set(stampReadyIds);
  for (const sessionId of repairableIds) {
    if (!stampReady.has(sessionId)) {
      markRetryable(pass.outstanding, sessionId);
    }
  }

  if (
    isStoredComponentInvocationBridgeEnabled(pass.options) &&
    !pass.summary.storageReset &&
    pass.shouldContinue()
  ) {
    await rebuildStoredComponentInvocations(
      stampReadyIds,
      pass.options.db,
      pass.summary,
      pass.log,
      pass.pauseAfterWrite,
      pass.shouldContinue
    );
  }

  // ISS-6241: the repair tail is done, so its cohort is genuinely finished and
  // the count may reach its total. Gated on the pass NOT having been cut short:
  // a storage reset or a cancellation leaves these ids outstanding, so the last
  // number the user saw stays honestly short of the total rather than claiming
  // a completion that did not happen.
  if (!pass.summary.storageReset && pass.shouldContinue()) {
    pass.repairTailComplete = true;
    pass.reportProgress();
  }
}

/**
 * The stored-row invocation bridge rebuilds invocations for sessions whose
 * SOURCE transcript is gone (`missingSourceIds`) or whose reparse produced no
 * session (`parserOutputFallbackIds`) — sessions that CANNOT be reparsed. It was
 * introduced at COMPONENT_INVOCATION_STORED_REBUILD_REVISION and stays valid for
 * every revision at or after it: present-source sessions always reparse via
 * `rebuildHarness` (that is how FEA-4093 rev-40 Hook capture lands), while these
 * transcript-less sessions still recover their non-hook invocations from stored
 * rows rather than losing them. `>=` (not `===`) keeps the bridge on as
 * DATA_REVISION advances; hooks simply never appear for a session with no
 * transcript.
 */
function isStoredComponentInvocationBridgeEnabled(
  options: DataRevisionRebuildOptions
): boolean {
  return (
    (DATA_REVISION as number) >= COMPONENT_INVOCATION_STORED_REBUILD_REVISION &&
    options.useStoredComponentInvocationRebuild === true
  );
}
