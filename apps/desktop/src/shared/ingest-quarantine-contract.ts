/**
 * @file ingest-quarantine-contract.ts
 * @description ISS-6115 (wongk review): the ingest-quarantine vocabulary shared
 * by the main-process store and the renderer copy that reports it.
 *
 * It lives here rather than beside the store because the store's module reaches
 * for `node:fs`, and the renderer tsconfig has no node types — but the renderer
 * genuinely needs these names, since the whole point is that the copy differs by
 * stage. Duplicating the shape on the renderer side instead would be the SSOT
 * drift the root guide calls out: two declarations of one contract, free to
 * disagree the moment a stage is added.
 */

/**
 * Which stage of the historical pass burned a full deadline on a source without
 * producing anything durable. Both stages charge the SAME per-source budget — the
 * store answers "this source poisons the historical pass, stop retrying it at full
 * cost", and a source that costs 90s of parse or 120s of import is equally not
 * worth re-attempting forever.
 *
 * The stage is nevertheless carried all the way to the UI, because the two make
 * different claims and a reader acting on them needs the difference:
 *
 *   - {@link SourceTimeoutStage.Parse} is a claim about the transcript BYTES — a
 *     CPU-spinning parser on a pathological file. The file could not be READ, and
 *     nothing was written, so already-imported sessions are untouched.
 *   - {@link SourceTimeoutStage.Import} is a claim about the SINK at that moment —
 *     the file was read fine and the WRITE did not finish inside its bound. The
 *     isolated importer commits its record groups one at a time, so a later group
 *     timing out leaves the earlier ones ALREADY WRITTEN. Saying "couldn't be
 *     read", or that existing sessions are unchanged, is false on this path.
 */
export const SourceTimeoutStage = {
  Parse: "parse",
  Import: "import",
} as const;
export type SourceTimeoutStage =
  (typeof SourceTimeoutStage)[keyof typeof SourceTimeoutStage];

/**
 * Quarantined sources split by the stage that quarantined them. A `Record` over
 * the stage union rather than a hand-written pair, so adding a stage fails
 * typecheck at every site that has to account for it.
 */
export type QuarantinedStageCounts = Record<SourceTimeoutStage, number>;

/**
 * What the main process reports about the boot import, as the renderer receives
 * it. Extracted from the runtime's inline return type (which sits at the
 * file-size ceiling) because it is a main-to-renderer CONTRACT, not a detail of
 * that module: the renderer's own `IngestProgress` mirrors it field for field,
 * and keeping the authoritative shape here is what lets the two be compared.
 */
export type DesktopIngestProgressReport = {
  byHarness: { harness: string; total: number; processed: number }[];
  total: number;
  processed: number;
  preparing: boolean;
  complete: boolean;
  timedOut: boolean;
  /**
   * ISS-4444: transcripts quarantined after their historical pass gave up on
   * them repeatedly (the boot import completes with these skipped). Surfaced so
   * the UI can honestly report the shortfall rather than silently under-count.
   * A SOURCE count — one poison source can hold many sessions — not a
   * scope-matched session tally.
   */
  quarantinedCount: number;
  /**
   * ISS-6115: the same population split by the stage that quarantined it, so a
   * renderer says "couldn't be read" only of the parse-stage subset. An import
   * stall means the transcript WAS read and its write did not finish.
   */
  quarantinedByStage: QuarantinedStageCounts;
};
