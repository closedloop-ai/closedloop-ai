// ISS-6241: per-session progress for the DATA_REVISION rebuild.
//
// The Compute step of the first-launch import splash rendered a bare active dot
// for a pass that legitimately runs for hours over a stale corpus, so a healthy
// long run was indistinguishable from a hang and read as one. This is the
// producer half: the only place that can answer "how far through" honestly.

/**
 * How far the CURRENT rebuild attempt has drained its own work population.
 *
 * Both numbers describe one attempt and one population. They are NOT a
 * cross-attempt or cross-boot tally: the rebuild is cursored on the
 * `data_revision` stamp, so a re-driven attempt legitimately re-selects a
 * SMALLER stale set and reports a smaller `total`. A consumer must therefore not
 * latch `total` monotonically — that would make the second attempt of a
 * re-driven pass render a denominator the pass can no longer substantiate.
 */
export type DataRevisionRebuildProgress = {
  /**
   * Sessions from this attempt's population that reached a TERMINAL outcome —
   * rebuilt, deleted, race-skipped, parse-errored, or resolved as
   * missing/unmatched source. Derived from the pending sets draining, never
   * from summing the summary counters: `rebuildStoredComponentInvocations` runs
   * a second sub-pass over some of the same sessions, so a sum of those fields
   * can exceed the population and render over 100%.
   */
  processed: number;
  /**
   * This attempt's TERMINAL-stale population: `staleTotal` minus the
   * non-terminal rows `groupTerminalStaleByHarness` skips into `skippedActive`.
   * Those are never worked, so counting them in the denominator would park the
   * bar short of its own end for the whole pass.
   */
  total: number;
};

/**
 * Report progress off the live pending sets.
 *
 * `processed` is `total - remaining`, recomputed from the sets themselves, so it
 * cannot drift from what the pass has actually resolved and cannot double-count
 * a session two sub-passes both touch. The map is small (one entry per harness),
 * so recomputing per source is cheaper than threading a counter through every
 * drain site — and a counter would have to be incremented at each of the six
 * terminal outcomes, which is exactly where it would eventually be forgotten.
 *
 * Emission is deduped on `processed`, so a source that resolves nothing (an
 * unimportable file, a session already handled) costs nothing downstream.
 */
export function createDataRevisionRebuildProgressReporter(
  pendingByHarness: ReadonlyMap<string, ReadonlySet<string>>,
  report?: (progress: DataRevisionRebuildProgress) => void,
  /**
   * Sessions that have LEFT the pending sets but the pass is not finished with:
   * the missing-source and parser-output cohort, which the repair tail
   * (`recomputeMissingSourceRollups`, then `rebuildStoredComponentInvocations`)
   * still works one chunk at a time.
   *
   * Without this the count reads N of N the instant the source walk ends —
   * `sumPending` is 0 by construction once the last harness entry is deleted —
   * and then sits at a finished-looking total while a slow, paused repair pass
   * runs. A bar pinned at 100% for minutes is the same "healthy or hung?"
   * question this ticket exists to answer, just moved to the end of the pass.
   *
   * Counted as still-remaining, so a session moving from `pending` into the
   * repair cohort leaves the numerator unchanged rather than advancing it. The
   * count therefore never goes backwards.
   */
  deferredRemaining: () => number = () => 0
): () => void {
  if (!report) {
    return () => {
      // No consumer: the rebuild must not pay to compute a number nobody reads.
    };
  }
  const total = sumPending(pendingByHarness);
  if (total === 0) {
    // Nothing to substantiate a denominator with. Staying silent leaves the
    // consumer in its indeterminate state rather than publishing a 0/0, which
    // is the shape ISS-5932 exists to prevent.
    return () => {
      // Intentionally inert; see above.
    };
  }
  let lastProcessed = -1;
  return () => {
    const remaining = sumPending(pendingByHarness) + deferredRemaining();
    // Clamped because the deferred cohort is counted from a different set than
    // the pending map: a double-count there must degrade to "no progress yet",
    // never to a negative numerator the boundary would drop anyway.
    const processed = Math.max(0, total - remaining);
    if (processed === lastProcessed) {
      return;
    }
    lastProcessed = processed;
    report({ processed, total });
  };
}

function sumPending(
  pendingByHarness: ReadonlyMap<string, ReadonlySet<string>>
): number {
  let remaining = 0;
  for (const pending of pendingByHarness.values()) {
    remaining += pending.size;
  }
  return remaining;
}
