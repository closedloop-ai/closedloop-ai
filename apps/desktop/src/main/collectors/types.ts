/**
 * @file types.ts
 * @description The collection-layer contract (FEA-1503). The `NormalizedSession`
 * output shape every harness parser emits was extracted to the browser-safe
 * harness slice of `@repo/lib` (FEA-2717) and is re-exported here so the many
 * desktop consumers of `collectors/types` keep working unchanged. The
 * desktop-only `HarnessCollector` descriptors (which reference `fs.watch`
 * semantics) and `SourceImportSnapshot` stay in this module.
 */

import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import type { Harness, NormalizedSession } from "@repo/lib/harness/types";
import type { HistoricalParseWorkerResumePoint } from "./engine/historical-parse-worker-protocol.js";
import type { OpencodeWithheldSubagentReport } from "./opencode/opencode-withheld-subagents.js";

// biome-ignore lint/performance/noBarrelFile: re-exports the extracted NormalizedSession contract (FEA-2717); collector descriptors below stay local
export * from "@repo/lib/harness/types";

/** Optional source snapshot captured immediately before parsing a source. */
export type SourceImportSnapshot = {
  fingerprint: string | null;
};

/**
 * Members shared by every collector regardless of cache strategy. The generic
 * boot importer and the generic watcher (`watcher.ts`, `collector-manager.ts`)
 * drive every harness through this uniform base, so the only per-harness code is
 * `home` (path/env resolution) + `parser` (format → NormalizedSession) + a small
 * descriptor.
 */
type BaseHarnessCollector = {
  key: Harness;
  /** Stable name for this collector's persisted catchup cache (file harnesses). */
  cacheName: string;
  /** Directories to recursively fs.watch. Missing dirs self-heal when they appear. */
  watchRoots(): string[];
  /**
   * Test-only escape hatch for injected collectors that intentionally use
   * synthetic paths without host roots. Production collectors must provide
   * roots so source admission can constrain historical parsing.
   */
  allowUnscopedSourceAdmission?: boolean;
  /** Which changed filenames (basename or relative path) trigger a re-import. */
  watchMatch(filename: string): boolean;
  /**
   * Map an fs.watch event to the source path(s) the collector should parse.
   * File-based collectors usually parse the changed file itself; collectors
   * whose watched files are sidecars can map back to the canonical source.
   */
  sourcePathsForWatchEvent?(root: string, filename: string): string[];
  /** Enumerate the current source paths to import. */
  listSources(): string[];
  /** Parse one source into zero or more normalized sessions. */
  parse(source: string): Promise<NormalizedSession[]>;
  /**
   * ISS-7625: drain the parse quality of the source the LAST {@link parse} read,
   * when that parse produced no session because the transcript carried no usable
   * timestamp. Returns `undefined` for every other outcome, including a clean
   * parse and a source the collector filtered out before parsing.
   *
   * A drain rather than a return-shape change because `parse` is implemented by
   * five collectors and consumed on two paths; a sink hung off the descriptor
   * keeps both unchanged. It is read IMMEDIATELY after the awaited `parse` on
   * both paths, and worker dispatch is serialized to one source per turn, so
   * "the last parse" is unambiguous.
   *
   * Optional: a collector that never reports one simply omits it, and the
   * caller's `?.()` is the pre-ISS-7625 silence.
   */
  takeUnreadableParseQuality?(): NormalizedParseQuality | undefined;
};

/**
 * File harnesses (Claude/Codex/Cursor/Copilot): one source file maps to one
 * session. `listSources()` returns the current source file paths; `parse(file)`
 * returns `[session]` (or `[]`); the per-file catchup cache skips unchanged
 * files. `batch` is absent (or explicitly `false`) — the union discriminant the
 * manager branches on to take the cached-per-file path. The members below are
 * the file-only capabilities; the compiler rejects any batch-only member on
 * these collectors (and vice versa).
 */
export type FileHarnessCollector = BaseHarnessCollector & {
  /** Always absent/`false` for file harnesses — the `HarnessCollector` discriminant. */
  batch?: false;
  /**
   * Directories that may contain historical/import sources. Defaults to
   * `watchRoots()`, but collectors can widen this when archived sources are not
   * live-watched.
   */
  sourceRoots?(): string[];
  /**
   * Called once before a batch of per-source cache checks. Collectors can use
   * this to precompute source-set metadata that would otherwise be recomputed by
   * `extraMtime` or `isBurstArtifactSource` for every source. May be async so a
   * heavy precompute (the Codex rollout-linkage graph build) can yield to the
   * event loop instead of blocking the main thread; callers must await it.
   */
  prepareSourceBatch?(sources: readonly string[]): void | Promise<void>;
  /**
   * FEA-1459 Fix 11: Optional extra mtime to incorporate into the catchup cache
   * fingerprint. For claude, this is the max mtime across subagent files so that
   * a subagent-only change triggers re-import of the parent session.
   */
  extraMtime?(source: string): number | null;
  /**
   * FEA-1785: Derive the session id that a parse of this source path would
   * produce, from the path alone (no I/O). Returns null when the id is not
   * derivable without parsing (e.g. copilot chat files where the stored id is
   * content-derived and the path basename is not guaranteed to match).
   */
  sessionIdForSource?(source: string): string | null;
  /**
   * FEA-1785: Returns true when a source is positively classified as a burst
   * artifact (e.g. codex re-serialization). When a mapped source yields zero
   * sessions under the current parser, only burst-artifact sources are deleted;
   * other zero-result parses (unreadable, incomplete, no-timestamp) are left
   * stale for retry.
   */
  isBurstArtifactSource?(source: string): boolean;
  /**
   * ISS-12036: identifies the runtime settings a zero-session parse depends on
   * (Codex: the burst thresholds read from env on every parse). The catch-up
   * cache honours a source's "parsed to no session" mark only while this
   * still matches. Absent: the mark depends on the file's bytes alone.
   */
  zeroSessionParseKey?(): string;
};

/**
 * Batch harnesses (OpenCode): the whole store is a single source. `batch: true`
 * bypasses the per-file catchup cache; the collector self-fingerprints inside
 * `listSources()` (returns `[]` when the store is unchanged, else a single
 * sentinel) and `parse(sentinel)` loads every session from the store. Batch
 * collectors do not implement `sessionIdForSource` — their session ids are
 * content-derived, not derivable from the (single sentinel) path.
 */
export type BatchHarnessCollector = BaseHarnessCollector & {
  /** Always `true` for batch harnesses — the `HarnessCollector` discriminant. */
  batch: true;
  /**
   * FEA-1785: Enumerate ALL current sources unconditionally, bypassing any
   * self-fingerprinting that makes listSources() return [] when the store is
   * unchanged. The data-revision rebuild needs unconditional enumeration to
   * re-derive stale sessions even when the underlying store hasn't changed.
   * File-based collectors don't need this — their listSources() is already
   * unconditional.
   */
  listSourcesForRebuild?(): string[];
  /**
   * Called after a source has been successfully imported. Batch collectors use
   * this to persist durable fingerprints when parsing happened off-main-process.
   *
   * ISS-5028 (whitlockk review): returns whether the snapshot was actually
   * COMMITTED. A collector may legitimately refuse — OpenCode declines a
   * snapshot that moved under the pass — and the caller must be able to tell,
   * because a refused source returns as pending on the next scan and so is not
   * finished for first-pass progress purposes. An implementation that cannot
   * refuse returns `true`; the caller also reads an ABSENT hook as committed,
   * since a collector with no hook has nothing to refuse.
   */
  markSourceImported?(source: string, snapshot?: SourceImportSnapshot): boolean;
  /**
   * ISS-7696: where the worker must resume `source`, when a previous pass left a
   * CONFIRMED continuation.
   *
   * Confirmed means the pass that received the previous window ran its whole
   * session loop and reached {@link markSourceImported}. That distinction is the
   * whole point of parking this on the collector: the manager can abandon the
   * tail of a delivered window mid-source to service live-watcher events, and it
   * can leave a source unmarked because one session failed — in both cases the
   * window must be RE-DELIVERED, not skipped past. A continuation advanced by
   * the worker's own bookkeeping would skip it and then let the final window
   * seal the store over the hole.
   */
  resumeAfterForSource?(
    source: string
  ): HistoricalParseWorkerResumePoint | undefined;
  /**
   * Clears collector-owned durable ingest state that lives outside SQLite.
   * Used when the local derived session cache is reset so old source
   * fingerprints cannot suppress the rebuild.
   */
  resetIngestState?(): void;
  /**
   * Capture an idempotency token immediately before parsing. Batch collectors
   * use it to avoid marking a newer store version imported when the source
   * changes while the parsed snapshot is still being written.
   */
  sourceFingerprint?(source: string): string | null;
  /**
   * ISS-5266 (whitlockk review): apply the side-report of a parse that ran
   * OUT-OF-PROCESS, on this collector's behalf.
   *
   * A batch collector's `parse` can have durable side effects beyond the
   * sessions it returns — OpenCode records which subagent subtrees it WITHHELD,
   * so an under-count is distinguishable from a real zero. In-process those
   * effects run inside `parse` via an injected sink. The historical/boot import
   * parses in a utility process instead, on a throwaway collector instance with
   * no sink, so the effect never happened for THIS instance: the record was
   * dropped and — worse — the failure latch that makes {@link markSourceImported}
   * refuse a premature seal was never armed.
   *
   * Handing the report back here replays the effect on the instance that
   * actually owns the fingerprint, through the same sink and the same latch the
   * in-process path uses. That is what keeps the seal gate a SINGLE mechanism
   * rather than two copies of one check that can drift.
   *
   * Never rejects: a failed record is latched internally (exactly as in `parse`)
   * so it surfaces as a refused seal and a retry next launch, not as a failed
   * import of sessions that parsed fine.
   */
  applyParseSideReport?(report: CollectorParseSideReport): Promise<void>;
};

/**
 * ISS-7696: WHICH caller produced a parse side-report.
 *
 * Two independent callers re-read the same source through the same worker on the
 * same long-lived collector instance: the ingest engine, whose pass owns the
 * fingerprint and seals it, and the DATA_REVISION rebuild, which re-derives
 * sessions and never seals anything. A report describes "the last load" — but
 * with two callers that phrase is ambiguous, and the seal-gate fields are the
 * ones where the ambiguity costs data: the rebuild always parses from offset 0
 * on its own schedule, so its report can land between an ingest pass's parse and
 * that pass's `markSourceImported` and hand the seal a verdict about a different
 * window. Naming the caller is what lets the collector keep the seal gate owned
 * by the pass that seals.
 */
export const CollectorParseScope = {
  Import: "import",
  Rebuild: "rebuild",
} as const;

export type CollectorParseScope =
  (typeof CollectorParseScope)[keyof typeof CollectorParseScope];

/**
 * ISS-5266: what an out-of-process parse learned that is not a session.
 *
 * A discriminated bag rather than a bare report, so the next collector that
 * needs to carry something back adds a member instead of a parallel channel.
 */
export type CollectorParseSideReport = {
  /**
   * Present only for an OpenCode batch load. Optional and additive: absent for
   * every other harness, and never emitted as `null`.
   */
  withheldOpencodeSubagents?: OpencodeWithheldSubagentReport;
  /**
   * ISS-5854: sessions the worker's response budget dropped to make the payload
   * cross the process boundary. Present only when the clamp actually dropped
   * some; absent otherwise, and never `null`.
   *
   * It rides this bag for the same reason the report above does. The import
   * path's only completeness signal is "every session in the list imported", and
   * a dropped session was never in the list — so without this the fingerprint is
   * sealed over a SHORT load and the dropped tail is never re-read.
   */
  droppedSessions?: number;
  /**
   * ISS-7696: where the worker says the NEXT pass should pick up, present only
   * when this window left sessions behind.
   *
   * It arrives PENDING and is not used until the pass reaches
   * {@link BatchHarnessCollector.markSourceImported} — see
   * {@link BatchHarnessCollector.resumeAfterForSource} for why the seal gate,
   * and not the worker, is what confirms a window was consumed.
   */
  resumeAfter?: HistoricalParseWorkerResumePoint;
  /**
   * ISS-7696: which caller produced this report. Absent means
   * {@link CollectorParseScope.Import} — the pre-ISS-7696 reading, and the one
   * every existing caller wants.
   */
  scope?: CollectorParseScope;
  /**
   * ISS-8561: WHICH source this report describes.
   *
   * A batch collector may own more than one store — golden mode points the
   * OpenCode collector at every staged dossier — and the seal-gate fields above
   * are per-store answers. The manager knows the source it just parsed, so it
   * names it here rather than leaving the collector to infer it.
   *
   * Optional and additive: a caller that omits it keeps the single-store
   * reading, where there is only one source the report can be about.
   */
  sourcePath?: string;
};

/**
 * A per-harness collector descriptor (FEA-1503): a discriminated union on
 * `batch` of the file vs batch cache strategies. Splitting the former
 * optional-member bag into two capability interfaces (ISP) lets the compiler
 * enforce which members belong to which kind and documents the contract — file
 * collectors cannot accidentally carry batch-only members and vice versa.
 * Consumers that handle both kinds generically narrow on the `batch`
 * discriminant before reaching for a kind-specific member.
 */
export type HarnessCollector = FileHarnessCollector | BatchHarnessCollector;

/**
 * Narrow a `HarnessCollector` on its `batch` discriminant into the two
 * capability views: exactly one is defined and the other is `undefined`. A
 * consumer that interleaves file-only and batch-only access destructures the
 * view(s) it needs (`const { fileCollector } = narrowHarness(collector)`) and
 * reaches members through them, so the prior optional-chaining no-op for the
 * other kind is preserved without re-deriving the ternary at each call site.
 */
export function narrowHarness(collector: HarnessCollector): {
  fileCollector: FileHarnessCollector | undefined;
  batchCollector: BatchHarnessCollector | undefined;
} {
  return collector.batch
    ? { fileCollector: undefined, batchCollector: collector }
    : { fileCollector: collector, batchCollector: undefined };
}
