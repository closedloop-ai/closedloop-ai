/**
 * @file collector-pending-sources.ts
 * @description The "which sources need importing this pass" concern, extracted
 * from `collector-manager.ts` (ISS-4444, shrink-only rule). Given a collector's
 * enumerated source paths, this decides — cooperatively, yielding to the event
 * loop over a large history — which are actually pending (changed / orphaned /
 * not quarantined), reads their stats, and orders them for import. Also maps
 * live-watcher events to importable source paths. All pure module functions with
 * no `CollectorManager` state; the manager composes them.
 */
import { stat as statAsync } from "node:fs/promises";
import path from "node:path";
import { SourceTimeoutStage } from "../../../shared/ingest-quarantine-contract.js";
import {
  type Harness,
  type HarnessCollector,
  narrowHarness,
  type SourceImportSnapshot,
} from "../types.js";
import type { CatchupCache } from "./catchup-cache.js";
import { yieldToEventLoop } from "./cooperative-yield.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";
import {
  IMPORT_QUARANTINE_COOLDOWN_MS,
  type ParseQuarantine,
  type QuarantineFingerprint,
} from "./parse-quarantine.js";
import { isImportableSourcePath } from "./source-admission.js";
import type { HarnessWatcherEvent } from "./watcher.js";

/**
 * A source enumerated for a boot/backfill import pass, with the stat and
 * fingerprint metadata the import loop needs. `stat` mirrors the catchup cache's
 * unchanged-check result; `snapshot` carries the batch collector's opaque
 * source fingerprint (opencode DB).
 */
export type PendingSource = {
  source: string;
  stat: ReturnType<CatchupCache["isUnchanged"]>["stat"];
  extraMtime: number | null;
  snapshot?: SourceImportSnapshot;
};

/**
 * A backlog above this size is treated as a large import pass — the manager throttles
 * cooperatively and defers large single sources so first data paints sooner.
 */
export const LARGE_IMPORT_BACKLOG_THRESHOLD = 50;

// FEA-2264: yield cadence for the cooperative source scan (see
// collectPendingSources). 256 keeps the added macrotask turns negligible (a few
// dozen over a multi-thousand-file history) while bounding any single
// synchronous stat run to a small slice.
const COLLECT_PENDING_YIELD_EVERY = 256;

// FEA-2264: prewarm concurrency for the async stat pass that warms the OS stat
// cache before the synchronous per-source scan runs.
const PREWARM_STAT_CONCURRENCY = 64;

// A single source larger than this is deferred to the back of the import order so
// first data (the many small recent sources) paints before a giant transcript.
const LARGE_SOURCE_FIRST_DATA_DEFER_BYTES =
  HistoricalParseWorkerLimits.maxWorkerResponseTextBytes;

async function prewarmSourceStats(sources: readonly string[]): Promise<void> {
  for (
    let index = 0;
    index < sources.length;
    index += PREWARM_STAT_CONCURRENCY
  ) {
    const batch = sources.slice(index, index + PREWARM_STAT_CONCURRENCY);
    await Promise.all(
      batch.map((source) =>
        statAsync(source).then(
          () => undefined,
          () => undefined
        )
      )
    );
  }
}

/**
 * ISS-4444 (codex P1): the content-changed fingerprint the parse-quarantine store
 * keys freshness on. A `fs.Stats` (already read for the source) maps directly to
 * {mtimeMs, size}; a stat failure degrades to `null`, which the store treats
 * conservatively (a source it cannot stat stays quarantined). Kept as a tiny
 * mapper so both the pre-parse skip check and the timeout recorder derive the
 * same shape from whatever stat they already hold.
 */
export function quarantineFingerprintFromStat(
  stat: { mtimeMs: number; size: number } | null
): QuarantineFingerprint {
  if (!stat) {
    return null;
  }
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * ISS-4444 (codex P1): read the quarantine freshness fingerprint for a source
 * being considered for the SKIP path (where no `fs.Stats` has been read yet). The
 * OS stat cache is warm from `prewarmSourceStats`, so this is cheap. A stat
 * failure degrades to `null` (the store keeps the source quarantined).
 */
async function readQuarantineFingerprint(
  source: string
): Promise<QuarantineFingerprint> {
  try {
    const stat = await statAsync(source);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

export async function collectPendingSources(
  collector: HarnessCollector,
  cache: CatchupCache | undefined,
  sources: string[],
  existingSessionIds?: ReadonlySet<string>,
  foldedChildSessionIds?: Set<string>,
  quarantine?: ParseQuarantine
): Promise<PendingSource[]> {
  await prewarmSourceStats(sources);
  // File-only members (prepareSourceBatch/extraMtime) and the batch-only
  // sourceFingerprint are reached through these narrowed views; the prior
  // optional-chaining no-op for the other kind is preserved by the undefined.
  const { fileCollector, batchCollector } = narrowHarness(collector);
  // FEA-2264: prepareSourceBatch can be cooperative (the Codex collector builds
  // its rollout-linkage graph here, reading session_meta off every changed
  // rollout). Awaiting it lets that build yield to the event loop on a cold
  // cache instead of stat/reading thousands of files synchronously before the
  // per-source loop below even starts.
  await fileCollector?.prepareSourceBatch?.(sources);
  const pendingSources: PendingSource[] = [];
  // FEA-2264: this loop runs multiple synchronous statSync calls per source
  // (cache.isUnchanged plus the codex extraMtime workflow-journal/descendant
  // stats). Over a large history that is many thousands of blocking stats; yield
  // to the event loop every COLLECT_PENDING_YIELD_EVERY sources so renderer reads
  // and the cloud socket are serviced and the UI stays responsive while it runs.
  let sourcesSinceYield = 0;
  for (const source of sources) {
    if (++sourcesSinceYield >= COLLECT_PENDING_YIELD_EVERY) {
      sourcesSinceYield = 0;
      await yieldToEventLoop();
    }
    // ISS-4444: a quarantined source poisons the parser (its parse wedges), so it
    // is excluded from this pass entirely — never parsed, never counted toward the
    // pass total — so the boot import COMPLETES (bar reaches 100%) instead of
    // wedging on it every launch. Left UNMARKED in the catchup cache, so clearing
    // the quarantine file re-attempts it from scratch.
    //
    // ISS-4444 (codex P1): pass the current fingerprint so a corrected transcript
    // at the same path (a human fixed the poison file) invalidates the stale entry
    // and is re-attempted, instead of the path-only key skipping it forever.
    // ISS-4444 (shafty023 review): only a source with an existing quarantine
    // entry can be skipped here, and only for such a source does the freshness
    // fingerprint matter. Gate the per-source `stat` on `hasEntry` so the common
    // no-entry case (the vast majority of a large history) does not pay a stat at
    // all — `isQuarantined` would short-circuit to false there regardless.
    if (quarantine?.hasEntry(source)) {
      const fingerprint = await readQuarantineFingerprint(source);
      if (quarantine.isQuarantined(source, fingerprint)) {
        continue;
      }
    }
    const extraMtime = fileCollector?.extraMtime
      ? fileCollector.extraMtime(source)
      : null;
    const decision =
      collector.batch || !cache
        ? { skip: false as const, stat: null }
        : resolveNonBatchSourceDecision(
            collector,
            cache,
            source,
            extraMtime,
            existingSessionIds,
            foldedChildSessionIds
          );
    if (decision.skip) {
      continue;
    }
    const snapshot = batchCollector?.sourceFingerprint
      ? { fingerprint: batchCollector.sourceFingerprint(source) }
      : undefined;
    pendingSources.push({ source, stat: decision.stat, extraMtime, snapshot });
  }
  pendingSources.sort(
    (a, b) =>
      pendingSourceLargeDeferRank(a) - pendingSourceLargeDeferRank(b) ||
      (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0)
  );
  return pendingSources;
}

/**
 * The per-source decision for a NON-batch collector with a catchup cache: is this
 * source skipped (unchanged / a folded burst child) or pending, and with what
 * stat? Extracted from `collectPendingSources` to keep its cognitive complexity
 * under the ceiling. Preserves the burst side-effect of recording the folded
 * child session id.
 */
function resolveNonBatchSourceDecision(
  collector: HarnessCollector,
  cache: CatchupCache,
  source: string,
  extraMtime: number | null,
  existingSessionIds: ReadonlySet<string> | undefined,
  foldedChildSessionIds: Set<string> | undefined
): { skip: true } | { skip: false; stat: PendingSource["stat"] } {
  // isBurstArtifactSource is file-only; narrow the union (this helper only runs on
  // the non-batch branch, so fileCollector is defined) so the access typechecks. A
  // batch collector would narrow to undefined here and isBurst stays false, exactly
  // as the prior optional-chaining no-op did.
  const { fileCollector } = narrowHarness(collector);
  const status = cache.isUnchanged(source, extraMtime);
  const isBurst =
    status.unchanged && fileCollector?.isBurstArtifactSource?.(source) === true;
  if (isBurst) {
    const foldedChildSessionId = foldedChildSessionIdForSource(
      collector,
      source,
      existingSessionIds
    );
    if (foldedChildSessionId) {
      foldedChildSessionIds?.add(foldedChildSessionId);
    }
    return { skip: true };
  }
  const skipUnchanged =
    status.unchanged &&
    !isOrphanedFromDb(collector, source, existingSessionIds);
  if (skipUnchanged) {
    return { skip: true };
  }
  return { skip: false, stat: status.stat };
}

/**
 * Current-revision Codex child rollouts fold into their root parent. If the
 * child was previously imported standalone while the parent was missing, a
 * later unchanged child source can otherwise be skipped before the empty-parse
 * cleanup path runs.
 */
function foldedChildSessionIdForSource(
  collector: HarnessCollector,
  source: string,
  existingSessionIds: ReadonlySet<string> | undefined
): string | null {
  // isBurstArtifactSource/sessionIdForSource are file-only; a batch collector
  // narrows to undefined here and the function returns null as before.
  const { fileCollector } = narrowHarness(collector);
  if (!(existingSessionIds && fileCollector?.isBurstArtifactSource?.(source))) {
    return null;
  }
  const sessionId = fileCollector.sessionIdForSource?.(source) ?? null;
  if (!(sessionId && existingSessionIds.has(sessionId))) {
    return null;
  }
  return sessionId;
}

/**
 * Self-heal cache/DB divergence: a source the persistent catchup cache marks
 * "unchanged" but whose derived session row is GONE from the current database
 * must be re-imported, not skipped. This happens after a DB reset/migration/
 * rebuild (e.g. PGlite→SQLite): the JSON ingest cache persists across that
 * reset INDEPENDENTLY of the DB, so non-batch collectors (codex, claude) would
 * otherwise stay orphaned forever — cache says "seen", DB has no row.
 *
 * Only collectors that can derive the session id from the path alone (no I/O,
 * `sessionIdForSource`, FEA-1785) participate. When the id can't be derived
 * without parsing (returns null) we keep the cheap "skip unchanged" behavior so
 * steady-state boots never re-parse every transcript. When the id IS derivable
 * and IS present in `existingSessionIds`, the source is still skipped — normal
 * steady state is unchanged.
 */
function isOrphanedFromDb(
  collector: HarnessCollector,
  source: string,
  existingSessionIds: ReadonlySet<string> | undefined
): boolean {
  if (!existingSessionIds) {
    return false;
  }
  // sessionIdForSource is file-only; batch collectors are never orphan-checked
  // this way (their listSources is already unconditional), so undefined → false.
  const { fileCollector } = narrowHarness(collector);
  const sessionId = fileCollector?.sessionIdForSource?.(source) ?? null;
  if (sessionId === null) {
    return false;
  }
  return !existingSessionIds.has(sessionId);
}

function pendingSourceLargeDeferRank(source: PendingSource): number {
  const size = source.stat?.size ?? 0;
  return size > LARGE_SOURCE_FIRST_DATA_DEFER_BYTES ? 1 : 0;
}

/**
 * Convert watcher events into importable source paths for a collector.
 * Mapped sources are constrained to regular files under the watched root so an
 * event-scoped import cannot parse arbitrary local paths.
 *
 * Thin wrapper over {@link sourcePathsForWatcherEventsWithOrigins} for callers
 * that only need the import work-list.
 */
export function sourcePathsForWatcherEvents(
  collector: HarnessCollector,
  events: HarnessWatcherEvent[]
): string[] {
  return sourcePathsForWatcherEventsWithOrigins(collector, events).sources;
}

/**
 * The import work-list from a watcher batch, plus the ORIGINAL changed paths
 * each mapped source came from.
 */
export type WatcherEventSources = {
  /** Mapped, admitted sources to import (the pre-ISS-4390 return value). */
  sources: string[];
  /**
   * Mapped source → the changed path(s) whose events produced it. A collector
   * that folds a child event onto a parent source (Codex `findCodexRootSource`,
   * Claude's `subagents/` → parent remap) reports the PARENT as the source, so
   * without this the identity of the file that actually changed is lost before
   * any consumer sees it.
   */
  changedPathsBySource: Map<string, string[]>;
};

/**
 * ISS-4390: like {@link sourcePathsForWatcherEvents}, but also reports which
 * changed path(s) each mapped source was derived from.
 *
 * The collapse itself is correct for its own purpose — it answers "which source
 * do I re-parse?", and a child rollout / sidecar is parsed through its parent.
 * It is only LOSSY for a consumer asking a different question, namely the
 * transcript archive lane's "which file's bytes changed?". Reporting both keeps
 * the collector seam harness-agnostic (it hands over plain paths and no
 * transcript-lane vocabulary) while letting that consumer resolve the real file.
 *
 * Origins are held to the SAME admission check as mapped sources — a changed
 * path that is not an importable regular file under the watched root is dropped
 * rather than forwarded, so this cannot widen what a downstream consumer opens.
 */
export function sourcePathsForWatcherEventsWithOrigins(
  collector: HarnessCollector,
  events: HarnessWatcherEvent[]
): WatcherEventSources {
  const sources = new Set<string>();
  const originsBySource = new Map<string, Set<string>>();
  for (const event of events) {
    const changed = path.resolve(
      path.isAbsolute(event.filename)
        ? event.filename
        : path.join(event.root, event.filename)
    );
    const mapped = collector.sourcePathsForWatchEvent?.(
      event.root,
      event.filename
    ) ?? [changed];
    // Attribute an origin ONLY when the event maps to exactly one source. A
    // collector that fans one changed file out to several sources gives no basis
    // to say which one owns it; recording it against all of them would enqueue
    // the same child under one `subagent:{id}` against several
    // `externalSessionId`s and archive it once per source. Claude and Codex both
    // map 1:1 today, so this changes nothing now — it just makes a future
    // multi-mapping collector degrade to `main`-only (pre-ISS-4390 behavior)
    // instead of silently double-archiving.
    const changedIsAttributable =
      mapped.length === 1 && isImportableSourcePath(changed, [event.root]);
    for (const source of mapped) {
      const resolvedSource = path.resolve(source);
      if (!isImportableSourcePath(resolvedSource, [event.root])) {
        continue;
      }
      sources.add(resolvedSource);
      if (!changedIsAttributable) {
        continue;
      }
      const origins = originsBySource.get(resolvedSource);
      if (origins) {
        origins.add(changed);
      } else {
        originsBySource.set(resolvedSource, new Set([changed]));
      }
    }
  }
  const changedPathsBySource = new Map<string, string[]>();
  for (const [source, origins] of originsBySource) {
    changedPathsBySource.set(source, [...origins]);
  }
  return { sources: [...sources], changedPathsBySource };
}

const SOURCE_TIMEOUT_STAGE_REASON: Record<SourceTimeoutStage, string> = {
  [SourceTimeoutStage.Parse]: "wedged repeatedly",
  [SourceTimeoutStage.Import]:
    "exceeded the historical import bound repeatedly",
};

/**
 * ISS-6115 (wongk review): how each stage's quarantine ENDS. The two differ, and
 * an incident reading this line needs to know which one it is looking at — a
 * parse quarantine waits on the transcript, an import quarantine waits on a clock
 * because its cause is the sink, not the bytes.
 */
const SOURCE_TIMEOUT_STAGE_RETRY: Record<SourceTimeoutStage, string> = {
  [SourceTimeoutStage.Parse]:
    "it will be skipped on future launches until the transcript changes or its quarantine is cleared",
  [SourceTimeoutStage.Import]: `it will be skipped until the transcript changes or its ${IMPORT_QUARANTINE_COOLDOWN_MS}ms cooldown elapses, whichever comes first`,
};

/**
 * Record one dead-lettered (timed-out) historical PARSE (ISS-4444) or IMPORT
 * (ISS-6115) for a source and, when it crosses the quarantine threshold on THIS
 * call, report that it will no longer be retried. Persisted best-effort by the
 * caller's end-of-pass flush. Lives beside {@link quarantineFingerprintFromStat}
 * — the fingerprint it records — rather than in the grandfathered manager.
 *
 * ISS-5028 (wongk review): returns whether THIS attempt quarantined the source.
 * A timed-out parse normally leaves the source unmarked so it retries, which is
 * why the caller reports it as a non-durable outcome — but the attempt that
 * crosses the threshold is TERMINAL: {@link collectPendingSources} filters a
 * quarantined source out of every later scan, so it never returns as pending.
 * Reporting it as non-durable there would drop it from the numerator AND the
 * denominator, shrinking the announced population under the operator.
 */
export function recordSourceTimeout(
  stage: SourceTimeoutStage,
  quarantine: ParseQuarantine | undefined,
  harness: Harness,
  source: string,
  // ISS-4444 (codex P1): the source stat already read for this pass, mapped to
  // the freshness fingerprint the store records so a later content change
  // invalidates the entry.
  stat: { mtimeMs: number; size: number } | null,
  log: (message: string) => void
): boolean {
  if (!quarantine) {
    return false;
  }
  const nowQuarantined = quarantine.recordFailure(
    source,
    quarantineFingerprintFromStat(stat),
    stage
  );
  if (nowQuarantined) {
    log(
      `${stage} quarantine [${harness}]: ${source} ${SOURCE_TIMEOUT_STAGE_REASON[stage]} and is now quarantined; ${SOURCE_TIMEOUT_STAGE_RETRY[stage]}`
    );
  }
  return nowQuarantined;
}

/**
 * ISS-6115: settle one source's quarantine state at the end of its pass, and
 * report whether THIS pass quarantined it.
 *
 * The rule is one sentence: a pass that BURNED A DEADLINE on the source charges
 * an attempt; a pass that did not clears the tally.
 *
 *   - `timedOut` — the source burned the historical import bound, exactly as a
 *     wedged parse burns the parse bound. The ISS-4476 isolate path leaves a
 *     timed-out source UNMARKED so it retries, which without a budget means it is
 *     re-attempted at full cost on every pass forever (measured: 8 days of
 *     `codex 0/2465`). `main/sync/AGENTS.md` invariant 5 — "unbounded retry is
 *     never acceptable, every terminal path must be reachable" — forbids that.
 *   - otherwise the source parsed within its bound and no session's import hit
 *     the import bound, so it is not a deadline-burner and its prior attempts are
 *     cleared. This is ISS-4444's clear, moved off the parse step: the parse step
 *     could not see the import outcome, so it wiped an import-timeout tally
 *     before it could ever converge. Deliberately NOT gated on the source having
 *     COMMITTED — an `incomplete` record group or a session-local `failed` import
 *     leaves the source unmarked for retry but is not a deadline burn, and gating
 *     on it would let old attempts accrete across unrelated passes, which is
 *     precisely what ISS-4444's clear existed to prevent.
 *
 * A genuine import REJECTION reaches neither branch: it propagates out of
 * `importSessionBounded` and aborts the harness pass by design (ISS-4410), so it
 * is never charged as an attempt.
 *
 * `batchSource` EXEMPTS a batch collector's store from the charge (never from the
 * clear). A batch source is the whole DB, not one transcript, so quarantining it
 * would drop every remaining and future session of that harness from the
 * historical path rather than one poison transcript — and it could never be
 * re-admitted, because a batch source carries no `stat` and therefore no
 * freshness fingerprint. It also does not need the budget: unlike a wedged parse,
 * which yields nothing, a timed-out batch import still commits its other sessions
 * every pass and `BatchResumeCursors` fast-forwards past them, so the per-pass
 * cost converges on its own. The root cause is ISS-6003's.
 *
 * `active` is the caller's generation check re-read AFTER its awaits: the import
 * bound spans two minutes, in which a stop()/restart can supersede the epoch and
 * re-import the source cleanly, and a stale epoch must not mutate the shared
 * store (wongk review, ISS-4444).
 */
export function settleSourceQuarantine(options: {
  quarantine: ParseQuarantine | undefined;
  harness: Harness;
  source: string;
  stat: { mtimeMs: number; size: number } | null;
  timedOut: boolean;
  batchSource: boolean;
  active: boolean;
  log: (message: string) => void;
}): boolean {
  const { quarantine } = options;
  if (!(quarantine && options.active)) {
    return false;
  }
  if (!options.timedOut) {
    quarantine.clear(options.source);
    return false;
  }
  if (options.batchSource) {
    return false;
  }
  return recordSourceTimeout(
    SourceTimeoutStage.Import,
    quarantine,
    options.harness,
    options.source,
    options.stat,
    options.log
  );
}

/**
 * ISS-6115 (wongk review): one source's retry budget for one pass, settled EXACTLY
 * ONCE however the pass leaves that source.
 *
 * {@link settleSourceQuarantine} used to be called only on the import loop's
 * fallthrough, and two exits never reach it: a genuine importer REJECTION unwinds
 * straight out to `runImportFor.catch`, and a batch MID-SOURCE YIELD returns
 * early. Both left the previous passes' tally in place instead of clearing it, so
 * `timeout, timeout, rejection, timeout` quarantined a source on a budget of 3
 * even though the rejection pass burned no deadline at all. The manager now drives
 * this from a `finally`, which covers every non-fallthrough exit — including the
 * mid-source yield, which is reachable only from the watcher-driven pass (the boot
 * pass supplies no yield controls).
 *
 * Owning the timed-out flag as well as the settle is what makes "settled once" a
 * property of this object rather than of the caller's control flow: the two facts
 * cannot drift apart, and the memoized result stays readable after the `finally`
 * for the caller's own durability reporting.
 */
export function createSourceBudgetSettler(options: {
  quarantine: ParseQuarantine | undefined;
  harness: Harness;
  source: string;
  stat: { mtimeMs: number; size: number } | null;
  batchSource: boolean;
  /** The caller's generation check, re-read at settle time (see below). */
  isActive: () => boolean;
  log: (message: string) => void;
}): {
  /** One of this source's sessions burned the historical import bound. */
  noteImportTimedOut(): void;
  /**
   * Charge or clear the budget, and report whether THIS pass quarantined the
   * source. Idempotent: later calls return the first call's answer.
   */
  settle(): boolean;
} {
  let timedOut = false;
  let settled: boolean | null = null;
  return {
    noteImportTimedOut(): void {
      timedOut = true;
    },
    settle(): boolean {
      settled ??= settleSourceQuarantine({
        active: options.isActive(),
        batchSource: options.batchSource,
        harness: options.harness,
        log: options.log,
        quarantine: options.quarantine,
        source: options.source,
        stat: options.stat,
        timedOut,
      });
      return settled;
    },
  };
}

/**
 * ISS-5028: will a source that this pass finished be READMITTED by a later
 * pending scan? This is the predicate the first-pass progress denominator needs:
 * `total = processed + pending` only reconciles while a source counted as
 * finished cannot also reappear in `pending`.
 *
 * Marking a source seen in the catchup cache is NOT sufficient. The orphan
 * self-heal ({@link isOrphanedFromDb}) readmits an unchanged, marked-seen source
 * whose derived session row is absent from the database — and several outcomes
 * mark a source seen while writing no row at all: the FEA-2027 unsafe-token-count
 * skip (`{ skipped: true, reactivated: false }`, `write-core.ts`), a parse that
 * yields zero sessions, and the `InvalidTokenCountError` cache-mark path. Those
 * are precisely the sources that would otherwise be counted twice, once per
 * resume, walking the denominator above the real population.
 *
 * `importedThisPass` carries the session ids this pass actually wrote, because
 * `existingSessionIds` is a snapshot taken before the pass began and would
 * otherwise report a freshly-imported source as still orphaned.
 *
 * Deliberately delegates to {@link isOrphanedFromDb} rather than re-deriving the
 * orphan rule, so the readmission predicate and the readmission itself can never
 * drift apart. It answers only the ORPHAN readmission: a source whose bytes
 * change after this pass imported it is readmitted by the ordinary
 * `cache.isUnchanged` check instead, which is genuinely new work rather than a
 * double count of the same work.
 */
export function willSourceBeRescanned(
  collector: HarnessCollector,
  source: string,
  existingSessionIds: ReadonlySet<string> | undefined,
  importedThisPass: ReadonlySet<string>
): boolean {
  if (!isOrphanedFromDb(collector, source, existingSessionIds)) {
    return false;
  }
  const { fileCollector } = narrowHarness(collector);
  const sessionId = fileCollector?.sessionIdForSource?.(source) ?? null;
  return sessionId !== null && !importedThisPass.has(sessionId);
}
