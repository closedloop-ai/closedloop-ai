/**
 * @file collector-manager-shutdown.ts
 * @description The teardown half of a `CollectorManager` epoch — the sibling of
 * `collector-manager-startup.ts`, which builds the epoch this unwinds. Owns the
 * order in which the epoch's handles are released and its durable state is
 * settled: cancel the boot-import watchdog, unblock a paused import so its loop
 * can observe `stopped` and exit, drop the stranded first-pass progress, cancel
 * the deferred imports, stop the watchers, and flush every persisted store.
 *
 * Extracted from `collector-manager.ts` so that file shrinks rather than grows.
 * The manager still owns the epoch (`generation`, `stopped`, `started`); this
 * module only unwinds what one epoch allocated.
 */
import type { CatchupCache } from "./catchup-cache.js";
import type { BatchResumeCursors } from "./collector-manager-batch-resume.js";
import type { IngestProgressTracker } from "./collector-manager-ingest-progress.js";
import type { DeferredImportTask } from "./collector-manager-startup.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import type { ParseQuarantine } from "./parse-quarantine.js";
import type { HarnessWatcher } from "./watcher.js";

export type CollectorEpochTeardown = {
  /** FEA-4156 boot-import watchdog, cancelled so a later epoch cannot fire it. */
  clearBootImportWatchdog: () => void;
  /** Unblock a paused backfill so its loop can observe `stopped` and exit. */
  resumeImport: () => void;
  ingest: IngestProgressTracker;
  batchResume: BatchResumeCursors;
  deferredImportTasks: Set<DeferredImportTask>;
  watchers: HarnessWatcher[];
  caches: Iterable<CatchupCache>;
  quarantines: Iterable<ParseQuarantine>;
  historicalParseRunner: HistoricalParseRunner | undefined;
};

/**
 * Unwind one `start()` epoch. The caller has ALREADY set its `stopped` flag —
 * that must happen on the caller's own turn, before this yields, so an in-flight
 * import pass sees it at its next active check.
 *
 * ISS-9839 (ISS-9837 C2): the batch-resume flush is AWAITED. This is the
 * ordinary quit path — exactly the interruption that cursor exists to survive —
 * and a fire-and-forget write here would convert the bounded replay ISS-5161
 * bought into the unbounded one it fixed. Everything before the await is
 * synchronous and runs in the caller's turn, so the flushed payload is the same
 * one a synchronous `stop()` would have written.
 */
export async function teardownCollectorEpoch(
  epoch: CollectorEpochTeardown
): Promise<void> {
  epoch.clearBootImportWatchdog();
  epoch.resumeImport();
  // Drop the stranded first-pass progress entries + console bookkeeping, but
  // PRESERVE the first-pass gate (see IngestProgressTracker.resetForStop): the
  // gate is only set post-completion, and re-arming it on an in-process restart
  // of an already-imported machine would surface a routine catch-up as a false
  // "Importing your history" state.
  epoch.ingest.resetForStop();
  // ISS-5161: PERSIST the in-flight batch cursor before releasing it, so the next
  // launch resumes the batch backfill instead of replaying the corpus. `clear()`
  // only releases memory; it deliberately does NOT discard what is persisted, and
  // it runs after the await so an outstanding failed write still retains its
  // entries.
  const batchResumeFlushed = epoch.batchResume.flush();
  for (const task of epoch.deferredImportTasks) {
    task.cancel();
  }
  epoch.deferredImportTasks.clear();
  for (const watcher of epoch.watchers) {
    try {
      watcher.stop();
    } catch {
      /* ignore */
    }
  }
  epoch.watchers.length = 0;
  for (const cache of epoch.caches) {
    cache.flush();
  }
  // ISS-4444: persist any dead-letter / quarantine state recorded this session so
  // a stop()/restart doesn't lose a poison transcript's accrued wedging attempts.
  for (const quarantine of epoch.quarantines) {
    quarantine.flush();
  }
  epoch.historicalParseRunner?.stop();
  await batchResumeFlushed;
  epoch.batchResume.clear();
}
