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
 * policies leave the revision stale as the durable retry marker. A LIVE capture is
 * skipped — the ordinary reimport path re-derives and stamps it — but a
 * non-terminal session that has been silent past the staleness bound is admitted
 * (ISS-8601): no reimport is coming for it, so refusing it forever is what left
 * those rows unbuildable. A
 * surviving source whose parse yields no session under current semantics
 * (e.g. the codex re-serialization burst signature) is an import artifact and
 * its local session row is deleted outright.
 */

import type { AnalyticsRollupRecomputeResult } from "../../database/analytics-recompute.js";
import { effectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import {
  type Harness,
  type HarnessCollector,
  type NormalizedSession,
  narrowHarness,
} from "../types.js";
import {
  COMPONENT_INVOCATION_STORED_REBUILD_REVISION,
  dataRevisionFor,
} from "./data-revision.js";
import { pruneFoldedChildRows } from "./data-revision-folded-child-prune.js";
import {
  createRebuildOutstanding,
  markRetryable,
  outstandingRemaining,
  type RebuildOutstanding,
} from "./data-revision-rebuild-outstanding.js";
import {
  type DataRevisionParseSource,
  type DataRevisionSourceParseResult,
  DataRevisionSourceParseResultKind,
  parseDataRevisionSource,
} from "./data-revision-rebuild-parse.js";
import {
  createDataRevisionRebuildProgressReporter,
  type DataRevisionRebuildProgress,
} from "./data-revision-rebuild-progress.js";
import { promoteSessionProjection } from "./data-revision-rebuild-projection-gate.js";
import {
  groupTerminalStaleByHarness,
  type StaleRevisionSessionRow,
  wedgedAdmittedIds,
} from "./data-revision-rebuild-stale-selection.js";
import { rebuildStoredComponentInvocations } from "./data-revision-rebuild-stored-invocations.js";
import {
  createEmptyDataRevisionRebuildSummary,
  type DataRevisionRebuildSummary,
  logRebuildSummary,
} from "./data-revision-rebuild-summary.js";
import { isImportableCollectorSource } from "./source-admission.js";

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
  ): Promise<StaleRevisionSessionRow[]>;
  /**
   * ISS-8601: the STORE's clock, which the in-transaction rebuild guards already
   * read. The selection must read the same one or it can admit a row the guard
   * then refuses as an active race — and `raceSkipped` is deliberately not
   * retryable, so that row would never be stamped and would be re-selected on
   * every boot.
   *
   * Optional only so a test double may omit it. In production it is ALWAYS
   * present and it ALWAYS returns a promise: the db-host proxy (FEA-2038)
   * answers every property path and forwards the call as an IPC `invoke`. The
   * caller awaits it for exactly that reason.
   */
  now?: () => string | Promise<string>;
  rebuildSessionFromParse(
    session: NormalizedSession,
    harness: Harness,
    /**
     * ISS-8741: the source revision to stamp as the new known-good projection,
     * inside the replacement's own transaction. Supplied by the promotion gate.
     */
    projectionRevision?: string | null,
    /** ISS-12552: the policy the session was re-parsed under. */
    parsePolicy?: ParsePolicy
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    storageReset?: boolean;
    /**
     * FEA-3659: true when the row must (re-)sync to the cloud: its re-derived
     * payload changed (the `updated_at` sync watermark was bumped) or, ISS-12251,
     * only its `created_at` moved (no bump). Undefined/false for a byte-identical
     * re-derivation, which stamps only `data_revision` and is a true sync no-op.
     */
    needsResync?: boolean;
  }>;
  /**
   * FEA-3294 revision-38 bridge. Reconstructs the complete invocation
   * projection from stored deterministic rows in one DB transaction. It must
   * not read transcripts, the network, or live definition files, and must
   * leave both prior rows and the stale revision stamp intact on failure.
   */
  rebuildComponentInvocationsFromStoredRows?(
    sessionId: string,
    currentRevision: number,
    /** ISS-12552: the pass's policy; off clears attribution evidence too. */
    parsePolicy?: ParsePolicy
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    storageReset?: boolean;
    needsResync?: boolean;
  }>;
  /**
   * ISS-8601: reports whether the row was actually DELETED. The store's
   * implementation re-checks status inside the transaction and refuses a
   * non-terminal row by returning early; when that outcome was `void` the
   * callers could not tell a refusal from a deletion, so they counted and logged
   * one that never happened and dropped the id from the pass.
   */
  deleteSessionRow(sessionId: string): Promise<boolean>;
  /**
   * ISS-8741: the durable in-flight marker, claimed in its own transaction
   * before a replacement is built and cleared when one commits or is abandoned.
   * Optional so a wiring (or a test double) that predates the substrate still
   * gets the validation gate and the atomic replacement.
   */
  claimProjectionCandidate?(sessionId: string, revision: string): Promise<void>;
  releaseProjectionCandidate?(sessionId: string): Promise<void>;
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
  /**
   * ISS-12552 (PRD-800 "Rollout"): the policy this pass re-derives under,
   * and so the revision it selects against and stamps. Defaults to this
   * process's current policy.
   */
  parsePolicy?: ParsePolicy;
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

  const parsePolicy = options.parsePolicy ?? effectiveParsePolicy();
  const stale = await options.db.listStaleRevisionSessions(
    dataRevisionFor(parsePolicy)
  );
  summary.staleTotal = stale.length;
  if (stale.length === 0 || !shouldContinue()) {
    return summary;
  }

  // ISS-8601: AWAITED, and awaited HERE rather than read at each classify site.
  // In production this `db` is the FEA-2038 forwarding proxy, whose every call
  // is an IPC `invoke` returning a promise — so a bare `db.now()` would hand
  // `new Date()` a Promise, yield an Invalid Date, and make the staleness test
  // answer "not stale" for every row on every real boot while staying green in
  // every test, where the store is in-process. `await` is correct on both
  // topologies: a bare string awaits to itself.
  const now = resolveRebuildClock(await options.db.now?.());

  const pass = createRebuildPass(
    options,
    summary,
    stale,
    log,
    shouldContinue,
    now,
    parsePolicy
  );
  pass.reportProgress();
  await drainCollectorSources(pass);
  absorbUncollectedHarnesses(pass);
  await runRepairTail(pass);

  logRebuildSummary(summary, log, dataRevisionFor(parsePolicy));
  return summary;
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
    // ISS-5071 (@whitlockk): the PRIMARY analytics outcome and the full-repair
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
  reportProgress: () => void,
  parsePolicy: ParsePolicy
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
        reportProgress,
        parsePolicy
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
      outstanding,
      parsePolicy
    );
    if (summary.storageReset) {
      return;
    }
    reportProgress();
  }
  for (const sid of unmappedSourcePresentRetryPending) {
    pending.delete(sid);
    unmappedParserErrorPending.delete(sid);
    // davetho review: withheld from missing-source fallback precisely BECAUSE
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
  outstanding: RebuildOutstanding,
  parsePolicy: ParsePolicy
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  const parsed = await parseDataRevisionSource(
    collector,
    source,
    parseSource,
    log
  );
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
    await applyRebuild(
      collector.key,
      match,
      pending,
      db,
      summary,
      outstanding,
      log,
      parsePolicy
    );
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
    // davetho review: nothing was rebuilt, deleted, or stamped — the row keeps
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
  reportProgress: () => void,
  parsePolicy: ParsePolicy
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  const parsed = await parseDataRevisionSource(
    collector,
    source,
    parseSource,
    log
  );
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
  // ISS-8601: a folded child the store REFUSED to delete (non-terminal, so a
  // wedged row this revision admitted) must leave `pending` here. A folded child
  // is by construction absent from `sessions`, so it can never be rebuilt by the
  // loop below; left pending it would fall through to the repair tail, and that
  // tail's stored-invocation bridge stamps `data_revision` UNCONDITIONALLY. The
  // row would be sealed at the current revision with its duplicate top-level row
  // still in place, making the ISS-5395 double-count permanent — the exact
  // sealing failure FEA-3597 fixed for the parser-output cohort. Marking it
  // retryable keeps the stale revision as its retry marker instead.
  for (const refusedId of pruned.refusedIds) {
    pending.delete(refusedId);
    markRetryable(outstanding, refusedId);
  }
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
        outstanding,
        log,
        parsePolicy
      );
      if (summary.storageReset) {
        return;
      }
      // davetho review: emit from the PER-SESSION transition, not only after
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
  outstanding: RebuildOutstanding,
  log: (message: string) => void,
  parsePolicy: ParsePolicy
): Promise<void> {
  // ISS-8741: through the gate — the candidate is put to the session view's own
  // validator while the standing projection is still in place, and only an
  // accepted one reaches the teardown-and-reimport transaction.
  const { result } = await promoteSessionProjection(
    harness,
    session,
    db,
    log,
    parsePolicy
  );
  if (result.storageReset) {
    summary.storageReset = true;
    return;
  }
  if (result.rebuilt) {
    summary.rebuilt++;
    // FEA-3659: only rows whose re-derived payload changed (updated_at bumped)
    // or whose created_at alone moved (ISS-12251, no bump) need to (re-)sync. A
    // byte-identical re-derivation stamped only data_revision (a true sync
    // no-op), so it is NOT collected — this is what keeps a DATA_REVISION bump
    // from re-uploading the whole corpus.
    if (result.needsResync) {
      summary.changedSessionIds.push(session.sessionId);
    }
  } else if (result.activeRace) {
    // Deliberately NOT retryable: `staleRebuildSkip` reports an active race only
    // for a LIVE capture, which "heals through ordinary import instead" — that
    // path stamps it, so parking it here as outstanding would queue a rebuild for
    // work another codepath already owns.
    //
    // ISS-8601 is what makes that reasoning sound. The guard used to refuse every
    // non-terminal row, including wedged ones no import will ever reach, so this
    // branch quietly discarded rows nothing else owned. Now the age bound sends
    // those down the rebuild instead, and an `activeRace` genuinely means the row
    // came back to life.
    summary.raceSkipped++;
  } else {
    summary.errors++;
    // davetho review: a failed rebuild leaves the revision stale as the
    // durable retry marker, so this session is outstanding, not processed.
    markRetryable(outstanding, session.sessionId);
  }
  pending.delete(session.sessionId);
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
    // davetho review: a mapped `Retry` is a TRANSIENT parse failure — the row
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
    // davetho review: only a burst artifact is safe to delete outright. Any
    // other empty parse leaves the row stale and retryable.
    markRetryable(outstanding, sessionId);
    return;
  }
  if (!shouldContinue()) {
    return;
  }
  const deleted = await db.deleteSessionRow(sessionId);
  pending.delete(sessionId);
  if (!deleted) {
    // ISS-8601: the store refused — the row went non-terminal, or it is one of
    // the wedged rows this revision now admits, and the delete guard is
    // deliberately status-only so nothing this pass admits can be purged.
    // Counting or logging a deletion that did not happen would drop the row from
    // the pass while leaving it in the store. Its stale revision IS the retry
    // marker, so it is outstanding rather than deleted, and a later pass
    // re-selects it once it reaches a terminal status.
    markRetryable(outstanding, sessionId);
    return;
  }
  summary.deleted++;
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
 * ISS-6165 (@whitlockk): `failedSessionIds.length === failed` is only a PROXY for
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
  /** ISS-12552: the policy, and so the revision, this pass works under. */
  parsePolicy: ParsePolicy;
  summary: DataRevisionRebuildSummary;
  log: (message: string) => void;
  parseSource: DataRevisionParseSource;
  pauseAfterWrite: () => Promise<void>;
  shouldContinue: () => boolean;
  pendingByHarness: Map<string, Set<string>>;
  /** ISS-8601: ids admitted despite being non-terminal; never stampable. */
  wedgedAdmitted: Set<string>;
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
  stale: readonly StaleRevisionSessionRow[],
  log: (message: string) => void,
  shouldContinue: () => boolean,
  now: Date,
  parsePolicy: ParsePolicy
): DataRevisionRebuildPass {
  const parseSource =
    options.parseSource ?? ((collector, source) => collector.parse(source));
  const pass: DataRevisionRebuildPass = {
    options,
    parsePolicy,
    summary,
    log,
    parseSource: (collector, source) =>
      parseSource(collector, source, parsePolicy),
    pauseAfterWrite: buildAdaptivePauseAfterWrite(options),
    shouldContinue,
    pendingByHarness: groupTerminalStaleByHarness(stale, summary, now),
    wedgedAdmitted: wedgedAdmittedIds(stale, now),
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
      pass.reportProgress,
      pass.parsePolicy
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
  // ISS-6241 (davetho review): the sessions the recompute WITHHELD a stamp
  // from were not repaired — they keep the stale revision as their retry marker
  // and a later pass re-selects them. `repairTailComplete` retires the repair
  // cohorts wholesale, so without this a partial repair still published `N of N`
  // while naming its own failures in the log line above it.
  // ISS-8601: a row admitted only because it was WEDGED must never be stamped by
  // the repair tail. The bridge below rebuilds invocation rows and then stamps
  // `data_revision` unconditionally, and a stamped row is never selected again —
  // so a wedged folded child sealed here keeps its duplicate top-level row for
  // good, which is the ISS-5395 defect made permanent. Withheld as a SET at this
  // one boundary rather than at each route into it (a refused delete, a thrown
  // delete, an unmatched source), because a future route would silently inherit
  // the hazard. These keep their stale revision as the retry marker.
  stampReadyIds = stampReadyIds.filter((id) => !pass.wedgedAdmitted.has(id));
  const stampReady = new Set(stampReadyIds);
  for (const sessionId of repairableIds) {
    if (!stampReady.has(sessionId)) {
      markRetryable(pass.outstanding, sessionId);
    }
  }

  if (
    isStoredComponentInvocationBridgeEnabled(
      pass.options,
      dataRevisionFor(pass.parsePolicy)
    ) &&
    !pass.summary.storageReset &&
    pass.shouldContinue()
  ) {
    await rebuildStoredComponentInvocations(
      stampReadyIds,
      pass.parsePolicy,
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
 * the revision advances; hooks simply never appear for a session with no
 * transcript.
 */
function isStoredComponentInvocationBridgeEnabled(
  options: DataRevisionRebuildOptions,
  currentRevision: number
): boolean {
  return (
    currentRevision >= COMPONENT_INVOCATION_STORED_REBUILD_REVISION &&
    options.useStoredComponentInvocationRebuild === true
  );
}

/**
 * The instant this pass classifies rows against.
 *
 * `??` alone is not enough: it only rejects null/undefined, so any non-nullish
 * unreadable reading (an empty string, a non-ISO form from a skewed db-host op)
 * would yield an Invalid Date, make every age comparison NaN, and quietly answer
 * "not stale" for the whole corpus — the age bound disabled in production with
 * every test still green. A clock we cannot read falls back to wall time, which
 * is what the in-process store uses anyway.
 */
function resolveRebuildClock(reading: string | undefined): Date {
  const parsed = reading === undefined ? null : new Date(reading);
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date();
}
