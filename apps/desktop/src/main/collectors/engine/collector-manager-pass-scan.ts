/**
 * @file collector-manager-pass-scan.ts
 * @description The SCAN phase of one `CollectorManager` import pass, split out
 * of `collector-manager.ts` so the engine file keeps only the import loop.
 *
 * The scan is a self-contained responsibility: flag the renderer "preparing"
 * banner and yield before any synchronous directory walk, enumerate the pass's
 * sources, load the DB's existing session ids, compute the pending set, delete
 * the folded-child rows that set identified, and open the progress pass. It
 * owns the try/finally that guarantees the indeterminate "preparing" marker is
 * cleared however the scan ends, and every generation re-check that keeps a
 * stopped/superseded pass from clobbering the live one's shared state.
 *
 * It writes NO import rows — everything after the returned `pendingSources` is
 * the caller's loop.
 */
import type { HarnessCollector } from "../types.js";
import type { CatchupCache } from "./catchup-cache.js";
import type { IngestProgressTracker } from "./collector-manager-ingest-progress.js";
import {
  collectPendingSources,
  measurePendingSourceBytes,
  type WatcherEventSources,
} from "./collector-pending-sources.js";
import type { E2eAbandonHistoricalPass } from "./e2e-boot-import-abandon-seam.js";
import type { ParseQuarantine } from "./parse-quarantine.js";

type ImportPassScanDeps = {
  collector: HarnessCollector;
  cache: CatchupCache | undefined;
  quarantine: ParseQuarantine | undefined;
  generation: number;
  lowDutyImport: boolean;
  ingest: IngestProgressTracker;
  resolveSources: () => WatcherEventSources;
  loadExistingSessionIds: () => Promise<ReadonlySet<string> | undefined>;
  waitForRendererBackgroundSlot: () => Promise<void>;
  isImportActive: (generation: number) => boolean;
  deleteSessionRow?: (sessionId: string) => Promise<boolean>;
  log: (message: string) => void;
  /**
   * ISS-8982 (TEST-ONLY, `undefined` in every production run): see
   * `CollectorManagerOptions.e2eAbandonHistoricalPass`.
   */
  e2eAbandonHistoricalPass?: E2eAbandonHistoricalPass;
};

type ImportPassScan = {
  /**
   * `false` when this generation was stopped or superseded while the scan was
   * suspended. The caller must abandon the pass (`completed: false`) rather
   * than import against the fields below, which are then empty placeholders.
   */
  active: boolean;
  sources: string[];
  /**
   * ISS-4390: mapped source → the path(s) that actually changed. Empty for
   * boot/backfill; populated for watcher batches so the transcript lane can
   * enqueue the changed CHILD transcript instead of the unchanged root.
   */
  changedPathsBySource: ReadonlyMap<string, string[]>;
  pendingSources: Awaited<ReturnType<typeof collectPendingSources>>;
  /**
   * ISS-8346: each pending source's size, measured once here so the import loop
   * subtracts the SAME number the pass's byte total was built from. Recomputing
   * it per source at completion time would let a file that grew mid-pass leave
   * more bytes than it contributed. Empty when this pass is not the tracked
   * first fill, which is exactly when nothing reads it.
   */
  pendingBytesBySource: ReadonlyMap<string, number>;
  /**
   * ISS-5028: returned to the caller because the import loop needs it to decide
   * whether a finished source will be READMITTED by the orphan self-heal (see
   * `willSourceBeRescanned`) — the difference between a source that is durably
   * done and one that returns in the next resume's `pending`.
   */
  existingSessionIds: ReadonlySet<string> | undefined;
  /** Whether this pass is the tracked first historical fill for the harness. */
  trackProgress: boolean;
};

function abandonedScan(trackProgress: boolean): ImportPassScan {
  return {
    active: false,
    sources: [],
    changedPathsBySource: new Map(),
    pendingSources: [],
    pendingBytesBySource: new Map(),
    existingSessionIds: undefined,
    trackProgress,
  };
}

async function deleteFoldedChildren({
  collector,
  foldedChildSessionIds,
  generation,
  isImportActive,
  deleteSessionRow,
  log,
}: {
  collector: HarnessCollector;
  foldedChildSessionIds: ReadonlySet<string>;
  generation: number;
  isImportActive: (generation: number) => boolean;
  deleteSessionRow?: (sessionId: string) => Promise<boolean>;
  log: (message: string) => void;
}): Promise<void> {
  if (!deleteSessionRow) {
    return;
  }
  for (const sessionId of foldedChildSessionIds) {
    if (!isImportActive(generation)) {
      break;
    }
    try {
      await deleteSessionRow(sessionId);
    } catch (error) {
      log(
        `collector ${collector.key} folded-child cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Run the scan phase of one import pass. Resolves to `active: false` whenever
 * the generation was stopped or superseded mid-scan, in which case no shared
 * progress state was written and the caller must abandon the pass.
 */
export async function scanImportPass(
  deps: ImportPassScanDeps
): Promise<ImportPassScan> {
  const {
    collector,
    cache,
    quarantine,
    generation,
    lowDutyImport,
    ingest,
    resolveSources,
    loadExistingSessionIds,
    waitForRendererBackgroundSlot,
    isImportActive,
    deleteSessionRow,
    log,
    e2eAbandonHistoricalPass,
  } = deps;
  // First-pass historical import: flag "preparing" and yield BEFORE any
  // synchronous source scan blocks the main thread, so the import banner can
  // render and start its off-main-thread shimmer before the freeze rather than
  // only appearing once the total is known afterward. Gated on
  // `!ingest.hasEntry` so re-entries don't repeat.
  if (lowDutyImport && !ingest.hasEntry(collector.key)) {
    ingest.markPreparing(collector.key);
    await waitForRendererBackgroundSlot();
    if (!isImportActive(generation)) {
      ingest.clearPreparing(collector.key);
      return abandonedScan(false);
    }
  }
  // Track first-pass progress for this harness (the big historical fill).
  const trackProgress =
    lowDutyImport && ingest.isFirstPassPending(collector.key);
  // The scan (source enumeration, existing-id load, pending computation) runs
  // inside try/finally so the "preparing" marker is ALWAYS cleared once the
  // total is known or the scan fails — a throw here must not leave the banner
  // stuck showing "preparing" forever.
  try {
    // Enumerate sources only AFTER the preparing yield. `listSources()` does a
    // synchronous recursive directory walk that, for a large local history, is
    // itself a main-thread freeze; resolving it lazily here (rather than at the
    // call site) keeps it from running before the banner can paint.
    const { sources, changedPathsBySource } = resolveSources();
    const existingSessionIds = await loadExistingSessionIds();
    const foldedChildSessionIds = new Set<string>();
    const pendingSources = await collectPendingSources(
      collector,
      cache,
      sources,
      existingSessionIds,
      foldedChildSessionIds,
      quarantine
    );
    // FEA-2264: collectPendingSources now yields cooperatively, so this
    // generation may have been stopped or superseded by a restart while the
    // scan was suspended. Bail before mutating shared state (folded-child
    // deletes, ingestProgress, the backfill log) so a stale generation cannot
    // clobber the live one's banner/progress.
    if (!isImportActive(generation)) {
      return abandonedScan(trackProgress);
    }
    await deleteFoldedChildren({
      collector,
      foldedChildSessionIds,
      generation,
      isImportActive,
      deleteSessionRow,
      log,
    });
    // The delete loop above awaits `deleteSessionRow` per folded child. The
    // in-loop guard only re-checks at the TOP of each iteration, so after the
    // FINAL await we can fall through here on a superseded generation: a
    // stop()/restart that landed during that last await bumped the generation
    // (and stop() cleared `ingestProgress`). Re-check before writing shared
    // progress state below, or this stale continuation repopulates
    // `ingestProgress` (undoing stop()'s clear) or clobbers the new
    // generation's live entry with a reset {total, processed: 0}.
    if (!isImportActive(generation)) {
      return abandonedScan(trackProgress);
    }
    let pendingBytesBySource: ReadonlyMap<string, number> = new Map();
    if (trackProgress && pendingSources.length > 0) {
      // ISS-8346: sizing the pending set awaits (a batch collector's sources
      // carry no stat and are stat'd here), so re-check the generation before
      // opening the pass, for the same reason every other await in this scan
      // does — a stale continuation must not reopen a pass `stop()` just closed.
      const measured = await measurePendingSourceBytes(pendingSources);
      if (!isImportActive(generation)) {
        return abandonedScan(trackProgress);
      }
      pendingBytesBySource = measured.bytesBySource;
      ingest.beginPass(
        collector.key,
        pendingSources.length,
        measured.totalBytes
      );
      // ISS-8982 (TEST-ONLY): throws a recoverable `DbHostExitError` while this
      // harness's seam budget lasts, so the pass the line above just opened
      // abandons exactly as it would had the db-host died under it.
      //
      // AFTER `beginPass`, and that ordering is load-bearing: a pass that
      // rejects before it opens takes `abandonPass`'s `!startedAt` early return
      // and records NO shortfall, so `drained` reads true alongside
      // `retriesExhausted` (ISS-5808/ISS-5281, and the budget docblock in
      // `collector-manager-ingest-progress.ts`). Moving this above `beginPass`
      // would silently flip that, and drive the terminal over a state that
      // claims the queue emptied. `undefined` outside the E2E launch env, where
      // this is an optional call on nothing.
      e2eAbandonHistoricalPass?.(collector.key);
    }
    return {
      active: true,
      sources,
      changedPathsBySource,
      pendingSources,
      pendingBytesBySource,
      existingSessionIds,
      trackProgress,
    };
  } finally {
    // The scan finished (the total is now set above, or there is nothing to
    // import) or it threw — either way, leave the indeterminate "preparing"
    // state so it can never stay stuck on.
    ingest.clearPreparing(collector.key);
  }
}
