/**
 * @file data-revision-rebuild-summary.ts
 * @description What one DATA_REVISION rebuild pass reports.
 *
 * Extracted from `data-revision-rebuild.ts` (ISS-8601), which had reached the
 * `noExcessiveLinesPerFile` ceiling. The shape, its zero value and its log line
 * are one concern and now sit beside `-summary-merge.ts`, which folds several of
 * them together — that module previously had to reach back into the whole
 * rebuild engine for the type it merges.
 */

export type DataRevisionRebuildSummary = {
  staleTotal: number;
  rebuilt: number;
  deleted: number;
  skippedActive: number;
  /**
   * ISS-8601: rows admitted DESPITE being non-terminal, because they had been
   * silent past the staleness bound. The receipt that the backstop fired — a
   * pass that admits none is indistinguishable in the log from one that cannot.
   */
  wedgedActiveAdmitted: number;
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
    wedgedActiveAdmitted: 0,
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

export function logRebuildSummary(
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  currentRevision: number
): void {
  log(
    `data-revision rebuild complete (revision ${currentRevision}): stale=${summary.staleTotal} rebuilt=${summary.rebuilt} deleted=${summary.deleted} skippedActive=${summary.skippedActive} wedgedActiveAdmitted=${summary.wedgedActiveAdmitted} raceSkipped=${summary.raceSkipped} missingSource=${summary.missingSource} missingSourceRollupsRecomputed=${summary.missingSourceRollupsRecomputed} unmatchedSource=${summary.unmatchedSource} parseErrors=${summary.parseErrors} errors=${summary.errors} storageReset=${summary.storageReset}`
  );
}
