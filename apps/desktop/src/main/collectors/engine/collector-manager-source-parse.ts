/**
 * @file collector-manager-source-parse.ts
 * @description Parsing ONE source for an import pass, and classifying what came
 * back. Extracted from collector-manager.ts (grandfathered shrink-only under the
 * root AGENTS.md line-count contract) so the bounded-parse machinery and its
 * three non-session outcomes live in a module that can own its own contract.
 *
 * The manager's import loop is then left with the decisions only it can make —
 * progress accounting, the live-event yield, the cooperative pauses — while the
 * question "did this source produce sessions, and if not, is it finished or will
 * it come back?" is answered here.
 *
 * ISS-4444: the low-duty historical parse is BOUNDED, so a CPU-spinning parser
 * on a poison transcript (a promise that never settles AND never throws) is
 * dead-lettered and the loop advanced, rather than wedging the whole sweep at
 * 1/N. A live-watcher parse stays unbounded (single, user-driven); a `null`
 * bound restores the prior unbounded await.
 *
 * ISS-6115: a clean parse no longer CLEARS the source's quarantine attempts here.
 * The store is now charged by the import bound too, and this step cannot see the
 * import outcome — so a source whose parse succeeded every pass while its import
 * timed out every pass had its tally wiped before it could ever converge. The
 * clear moved to `settleSourceQuarantine`, which runs once the pass knows whether
 * ANY deadline was burned on the source. The condition it applies is the same one
 * this step meant ("no attempts accrete across passes that went fine"), just
 * evaluated late enough to be true.
 *
 * ISS-5028: the two terminal-without-sessions outcomes each report whether they
 * were DURABLE — whether a later `collectPendingSources` can still return this
 * source — because the first-pass progress denominator is `processed + pending`
 * and only reconciles while a source counted as finished cannot also reappear as
 * pending. Neither answer is "the loop finished with it":
 *   - a timed-out parse leaves the source unmarked so it retries, EXCEPT on the
 *     attempt that crosses the quarantine threshold, which is terminal because
 *     ISS-4444 filters a quarantined source out of every later scan;
 *   - a thrown parse writes nothing, and only the `InvalidTokenCountError` path
 *     marks the source seen — and even then the caller must still ask whether
 *     the orphan self-heal will readmit it (`willSourceBeRescanned`), which is
 *     why this module reports `markedSeen` rather than claiming durability.
 */
import { SourceTimeoutStage } from "../../../shared/ingest-quarantine-contract.js";
import { InvalidTokenCountError } from "../../cost/token-counts.js";
import type { HarnessCollector, NormalizedSession } from "../types.js";
import {
  type BoundedParseInvoker,
  parseSourceBounded,
} from "./bounded-parse.js";
import type { CatchupCache } from "./catchup-cache.js";
import {
  type PendingSource,
  recordSourceTimeout,
} from "./collector-pending-sources.js";
import type { ParseQuarantine } from "./parse-quarantine.js";

/** What one source's parse produced for the pass. */
export type PassParseOutcome =
  | { kind: "sessions"; sessions: NormalizedSession[] }
  /**
   * The bounded parse never settled. `quarantined` is true only on the attempt
   * that crossed the ISS-4444 threshold, which is the attempt after which the
   * source stops being returned by `collectPendingSources`.
   */
  | { kind: "timedOut"; quarantined: boolean }
  /**
   * The parse threw. `markedSeen` is true when the catchup cache was advanced
   * anyway (the `InvalidTokenCountError` path); a partially-written file mid-turn
   * is normal, so the failure itself is deliberately not logged.
   */
  | { kind: "threw"; markedSeen: boolean }
  /** A stop()/restart superseded this generation while the parse was in flight. */
  | { kind: "superseded" };

export type PassParseOptions = {
  parseSource: BoundedParseInvoker;
  collector: HarnessCollector;
  source: string;
  /** The stat already read for this source by the pending scan. */
  stat: PendingSource["stat"];
  extraMtime: number | null;
  cache: CatchupCache | undefined;
  quarantine: ParseQuarantine | undefined;
  lowDutyImport: boolean;
  /** `null` disables the ISS-4444 bound (restores the unbounded await). */
  parseTimeoutMs: number | null;
  isImportActive: () => boolean;
  abortInFlightParse: () => void;
  log: (message: string) => void;
};

/**
 * Parse one source for an import pass. Also reports the wall time the parse
 * cost on EVERY path (including the failures), because the caller's per-source
 * profiling averages must not silently drop the sources that went wrong — those
 * are exactly the expensive ones.
 */
export async function parseSourceForPass(
  options: PassParseOptions
): Promise<{ outcome: PassParseOutcome; parseMs: number }> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    const outcome = await runParse(options);
    if (outcome !== null) {
      return { outcome, parseMs: elapsed() };
    }
  } catch (error) {
    return {
      outcome: { kind: "threw", markedSeen: markSeenOnThrow(options, error) },
      parseMs: elapsed(),
    };
  }
  return { outcome: recordTimeout(options), parseMs: elapsed() };
}

/**
 * The parse itself: `null` means it timed out and the caller must fall through
 * to the quarantine bookkeeping (kept out of the try so a throw from THERE is
 * never mistaken for a parse failure).
 */
async function runParse(
  options: PassParseOptions
): Promise<PassParseOutcome | null> {
  const { collector, lowDutyImport, parseSource, parseTimeoutMs, source } =
    options;
  if (lowDutyImport && parseTimeoutMs !== null) {
    const bounded = await parseSourceBounded(
      parseSource,
      options.log,
      collector.key,
      source,
      parseTimeoutMs,
      options.abortInFlightParse
    );
    if (bounded.timedOut) {
      return null;
    }
    return { kind: "sessions", sessions: bounded.sessions };
  }
  // Unbounded path (bound disabled or a live-watcher parse): there is no
  // deadline to arm, so the dispatch signal is a no-op here.
  const sessions = await parseSource(source, () => undefined);
  return { kind: "sessions", sessions };
}

/**
 * Dead-letter this pass: count a quarantine attempt (persisted by the caller's
 * end-of-pass flush) and leave the source UNMARKED so it retries next launch —
 * until it has wedged enough passes to be quarantined and skipped entirely.
 *
 * wongk review (ISS-4444): the bounded await can span the whole ~90s timeout
 * window, during which a stop()/start() restart can supersede this generation,
 * re-parse the source cleanly, and clear it. Re-check the generation before
 * mutating the SHARED quarantine so a stale timer from a superseded epoch cannot
 * record a fresh failure against a source the current epoch already healed.
 */
function recordTimeout(options: PassParseOptions): PassParseOutcome {
  if (!options.isImportActive()) {
    return { kind: "superseded" };
  }
  return {
    kind: "timedOut",
    quarantined: recordSourceTimeout(
      SourceTimeoutStage.Parse,
      options.quarantine,
      options.collector.key,
      options.source,
      options.stat,
      options.log
    ),
  };
}

/**
 * FEA-2027: an unsafe token count is a property of the transcript, not a
 * transient failure, so the source is marked seen and not retried forever. Batch
 * collectors have no per-source cache entry to advance.
 */
function markSeenOnThrow(options: PassParseOptions, error: unknown): boolean {
  const { cache, collector, extraMtime, source, stat } = options;
  if (!(error instanceof InvalidTokenCountError && !collector.batch && cache)) {
    return false;
  }
  cache.markSeenWith(source, stat, extraMtime);
  return true;
}
