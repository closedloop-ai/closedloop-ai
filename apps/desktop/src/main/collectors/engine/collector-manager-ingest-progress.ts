/**
 * @file collector-manager-ingest-progress.ts
 * @description FTUE first-pass ingest-progress bookkeeping, extracted from
 * collector-manager.ts (which has no entry in the `noExcessiveLinesPerFile`
 * grandfather list, so the 1,000-line ceiling is enforced on it). Owns the
 * per-harness progress map,
 * the first-pass-done gate, and the console-observability lines for the first
 * historical import pass, so the manager delegates rather than growing these
 * maps and their throttled-logging inline.
 *
 * The manager retains the boot-import completion/timeout lifecycle and the
 * quarantine counts (separate concerns) and composes them onto this tracker's
 * snapshot in getIngestProgress().
 *
 * ISS-4917: the first-pass LIFECYCLE lines (begin + complete) are emitted for
 * every first pass regardless of source count — the source-count threshold now
 * only decides whether the announce carries the "first launch can take a while"
 * hint, and only the periodic per-source line stays time-throttled. A first pass
 * under the old 50-source threshold previously logged nothing at all, which is
 * exactly the steady-state case for an already-imported machine, so a stalled
 * import in that range was invisible in main.log.
 *
 * The same ticket adds the no-progress watch below. Its whole value is that the
 * log never claims something untrue, so the tracker distinguishes the three ways
 * a pass can fail to advance:
 *   - the SOURCE SCAN has not finished yet (`markPreparing` … `clearPreparing`),
 *     which is reported in its own words because there is no processed/total to
 *     report yet (whitlockk review: the scan runs BEFORE the first `beginPass`, so a
 *     freeze there previously produced no line at all);
 *   - the pass is SUSPENDED by design — parked at the user's backfill pause, or
 *     returned early to let a live-watcher event through — which is muted per
 *     harness, and only from the moment the loop actually parks (whitlockk review:
 *     the pause FLAG flips before the loop reaches its pause point, so muting on
 *     the flag hid a genuinely wedged in-flight parse);
 *   - the pass is RUNNING and simply is not completing sources, which is
 *     reported — but as "no source completed in the last Ns" rather than a flat
 *     "STALLED", because a single source may legitimately still be inside its
 *     sanctioned bounded parse/import window (HISTORICAL_PARSE_TIMEOUT_MS is
 *     90s and HISTORICAL_IMPORT_SESSION_TIMEOUT_MS is 120s per session, both
 *     above the warn window below).
 */

import type { QuarantinedStageCounts } from "../../../shared/ingest-quarantine-contract.js";
import {
  createPendingByteLedger,
  type PendingByteLedger,
} from "./ingest-pending-bytes.js";

// Console-observability thresholds for the first-pass backfill: a first pass
// with at least this many source files carries the slow-first-launch hint, and
// at most one periodic progress line is emitted per interval (scale-independent).
const INGEST_LOG_MIN_SOURCES = 50;
const INGEST_LOG_INTERVAL_MS = 10_000;
// No-progress watch (ISS-4917): an in-flight first pass that has completed no
// source for this long reports it, re-armed at the same cadence so a long wedge
// keeps reporting rather than going quiet after one line. The sweep runs on a
// single shared interval. The window is deliberately BELOW the per-source parse
// and import bounds: the point is to surface a pass that is not moving early,
// and the line's wording (not a flat "stalled" claim) is what keeps it honest
// when the current source is still inside a sanctioned bound.
const INGEST_STALL_WARN_MS = 60_000;
const INGEST_STALL_CHECK_MS = 15_000;
const SLOW_LAUNCH_HINT = "; first launch can take a while";

export type IngestProgressSnapshot = {
  byHarness: { harness: string; total: number; processed: number }[];
  total: number;
  processed: number;
  preparing: boolean;
  /**
   * ISS-5281 (whitlockk review): a PRODUCER-OWNED terminal signal — every first pass
   * this manager began has ended, no source scan is running, and no pass left a
   * source behind for retry. The renderer used to infer this from aggregate
   * `processed >= total && !preparing`, which is not the same claim and is false
   * in three reachable places:
   *   - `preparing` is only ever set for a harness's FIRST scan
   *     (`markPreparing` is gated on `!hasEntry`), so every cooperative
   *     yield/resume re-scans with `preparing` false while `processed === total`
   *     — reaching the known total is exactly what sends the loop back for the
   *     next quantum, and the re-scan then GROWS `total`;
   *   - a harness whose total is 0 is filtered out of the snapshot entirely, so
   *     a wedge in that region contributes nothing to the aggregate and the
   *     aggregate says nothing about it;
   *   - {@link settlePass} settles a finished pass's bar to 100%, so a source
   *     left retryable by a non-durable outcome would be hidden behind
   *     `processed === total`. That shortfall is preserved here instead.
   */
  drained: boolean;
};

/**
 * Clock + scheduler seam so the no-progress watch is deterministic under test.
 * `schedule` returns its own cancel function, keeping the handle type opaque to
 * this module (node's `setInterval` handle differs from the DOM's).
 */
export type IngestProgressClock = {
  now(): number;
  schedule(callback: () => void, intervalMs: number): () => void;
};

/**
 * Per-harness first-pass ingest progress plus its console-observability
 * bookkeeping. First-pass semantics are per-manager-lifecycle: `resetForStop`
 * keeps the gate (`firstPassDone`) for every harness that FINISHED, because the
 * renderer treats the first-pass signal as first-launch import — and re-arms it
 * for one that did not, so the next pass is tracked and the ISS-6116 backfill
 * counters survive a collector restart.
 */
/**
 * ISS-5808 — how many CONSECUTIVE abandoned passes a harness may have before
 * `abandonPass` stops authorizing an in-session re-drive.
 *
 * The re-drive exists because a pass the db-host killed genuinely did not
 * finish and can finish against the replacement child. But the pass is re-armed
 * by the watcher off `HarnessImportResult.outcome`, and the watcher has no
 * counter of its own — so a source that reproducibly kills the child on write
 * (the exit-code-5 fan-out signature) would re-crash on every re-drive, forever,
 * paced only by the supervisor's 30s crash backoff and degrading every other
 * db-host consumer with it. `main/sync/AGENTS.md` invariant 5: unbounded retry
 * is never acceptable, every terminal path must be reachable.
 *
 * Past the budget the pass reports `RetriesExhausted` (ISS-6207) — its own
 * terminal, NOT completion — so recovery falls back to the 60s catch-up poll and
 * the next launch without the boot-import lifecycle being told the work
 * finished. Nothing is lost: import is idempotent, and where the pass reached
 * `beginPass` the `unfinished` shortfall below keeps `isDrained()` reporting it
 * as not drained. A pass abandoned BEFORE `beginPass` records no shortfall (see
 * the early return in `abandonPass`), so `drained` can read true alongside
 * `retriesExhausted` — which is why the readiness surfaces gate on the terminal
 * claim itself, never on `drained` alone. The dividing line is `beginPass`, not
 * which phase the pass was in: most of the source scan runs ahead of it, but
 * ISS-8982's test-only seam throws from inside that scan AFTER the pass opens,
 * and that abandon does record a shortfall.
 */
const MAX_CONSECUTIVE_ABANDON_REDRIVES = 3;

export class IngestProgressTracker {
  // Per-harness {total, processed} for the first historical import pass
  // (source-file units ≈ sessions). Feeds the dashboard "Claude Code 612 / 1,357"
  // card while the local DB fills. `processed` counts sources that reached a
  // TERMINAL outcome this pass (imported, dead-lettered, or skipped), never the
  // source currently in flight. ISS-4715: both members are CUMULATIVE for the
  // whole pass — they survive a yield/resume, which reconciles the recomputed
  // remaining population into them rather than replacing them — so the pair
  // always describes one population and the numerator never goes backwards.
  // ISS-5028: `processed` counts sources that are DURABLY finished (see
  // `advance`), because a source left for retry is still in the remaining
  // population that `beginPass` reconciles against.
  private readonly progress = new Map<
    string,
    { total: number; processed: number }
  >();
  // Sources completed since the CURRENT resume. The parse/import millisecond
  // totals the manager reports are per-invocation accumulators (they reset when
  // the pass re-enters), so the per-source averages must divide by the matching
  // per-resume count, not by the cumulative `processed` above.
  private readonly processedSinceResume = new Map<string, number>();
  // Harnesses whose first pass ran to completion; gates re-tracking on later
  // catch-up passes so a routine catch-up is not surfaced as first-pass progress.
  // ISS-6116: survives `resetForStop` only for harnesses that finished with
  // nothing outstanding — one that still has sources to land is re-armed, so the
  // next pass is tracked and the backfill counters keep reporting it.
  private readonly firstPassDone = new Set<string>();
  // Console-observability keyed by harness: `startedAt` is the first-pass start
  // (set once; gates the completion line and yields a correct duration across
  // yield/resume), `progressLoggedAt` throttles the periodic progress line.
  private readonly startedAt = new Map<string, number>();
  private readonly progressLoggedAt = new Map<string, number>();
  // The total this pass first announced. Presence makes the lifecycle announce
  // one-shot; the value only decides whether a later population expansion crosses
  // the slow-launch threshold. The live `progress.total` is authoritative for
  // completion because newly-discovered sources can legitimately grow the pass.
  private readonly announcedTotal = new Map<string, number>();
  // No-progress watch (ISS-4917), keyed by harness: `lastAdvancedAt` is when
  // this pass last completed a source (seeded at begin/resume so a pass that
  // never starts moving is still reported), `stallLoggedAt` re-throttles the
  // line.
  private readonly lastAdvancedAt = new Map<string, number>();
  // ISS-8058: when this harness last COMPLETED A SOURCE, and nothing else.
  // Deliberately NOT `lastAdvancedAt`, which `beginPass` and `noteResumed` also
  // seed — correct for a warn line (a re-entry or a resume is not worth warning
  // about) and fatal for a wedge claim, because a pass that keeps yielding and
  // re-entering without finishing anything would re-seed itself forever and
  // never look wedged. Absent means no source has EVER landed for this pass.
  private readonly lastSourceCompletedAt = new Map<string, number>();
  private readonly stallLoggedAt = new Map<string, number>();
  private cancelStallWatch: (() => void) | null = null;
  // Passes that are not advancing BY DESIGN, so reporting them would be the log
  // telling the operator something untrue: parked at the user's backfill pause,
  // or returned early to service live-watcher events. Tracked PER HARNESS and
  // set by the import loop at the moment it actually parks/returns, not when the
  // pause flag flips.
  private readonly suspended = new Set<string>();
  // Harnesses whose first-pass import has begun but whose source scan
  // (collectPendingSources) has not yet produced a total. Surfaced so the import
  // banner can show an indeterminate "preparing" state before the scan blocks,
  // and swept by the no-progress watch so a frozen scan is reported too.
  private readonly preparing = new Set<string>();
  private readonly preparingStartedAt = new Map<string, number>();
  private readonly preparingStallLoggedAt = new Map<string, number>();
  // ISS-5281 (whitlockk review): the REAL shortfall a pass ended with, keyed by
  // harness — sources THIS TRACKER will not come back to, because the first-pass
  // gate stops them being re-tracked. Recorded at settle/abandon and never
  // inferred from the counters afterwards, since `settlePass` deliberately
  // settles the bar to 100% and would otherwise erase the evidence. Boot-scoped:
  // cleared only by `resetForStop`.
  // ISS-7306: that is a claim about TRACKING, not about importing. The catch-up
  // poll re-runs the historical pass over the full source list for the life of
  // the boot, and every category counted here is by construction the retryable
  // one — so these sources ARE retried, they just stop being first-pass
  // progress. Anything reported from this map must say the narrower thing.
  private readonly unfinished = new Map<string, number>();
  // ISS-5808 — consecutive abandoned passes per harness, the budget that bounds
  // the in-session re-drive `abandonPass` authorizes. Cleared on a settled pass
  // (progress was made, so the next failure starts from a full budget) and by
  // `resetForStop`. Bounded by construction: one small integer per harness.
  private readonly consecutiveAbandons = new Map<string, number>();
  // ISS-8346 — the same passes counted in BYTES, for the analysis estimate. Kept
  // in its own ledger rather than widened onto `progress` because the two units
  // do not degrade together: a batch collector's pass has an honest source count
  // and no measurable byte population at all.
  private readonly pendingBytes: PendingByteLedger = createPendingByteLedger();

  private readonly log: (message: string) => void;
  private readonly clock: IngestProgressClock;

  constructor(
    log: (message: string) => void,
    clock: IngestProgressClock = defaultIngestProgressClock
  ) {
    this.log = log;
    this.clock = clock;
  }

  /**
   * The progress portion of getIngestProgress; the manager composes
   * `complete`/`timedOut`/`quarantinedCount` (other lifecycles) onto this.
   * Harnesses with no pending sources (total 0) are omitted.
   */
  snapshot(): IngestProgressSnapshot {
    const byHarness = [...this.progress.entries()]
      .filter(([, entry]) => entry.total > 0)
      .map(([harness, entry]) => ({
        harness,
        total: entry.total,
        processed: Math.min(entry.processed, entry.total),
      }));
    return {
      byHarness,
      total: byHarness.reduce((sum, h) => sum + h.total, 0),
      processed: byHarness.reduce((sum, h) => sum + h.processed, 0),
      // A first-pass import has begun but not yet produced a total (the source
      // scan is running); the banner shows an indeterminate state for this.
      preparing: this.preparing.size > 0,
      drained: this.isDrained(),
    };
  }

  /**
   * ISS-6116: the per-harness view the desktop import-health telemetry window
   * reports. One row per harness with a tracked first pass, so `remaining` is a
   * number this tracker actually knows rather than an inference — a harness the
   * scan found nothing for never reaches {@link beginPass} and is absent here,
   * which is what keeps an install with nothing to import from reading as a
   * stalled one.
   *
   * Read-only ON PURPOSE: it shares {@link isNotAdvancing} with
   * {@link checkStalls} so the log line and the counter can never disagree about
   * what "not advancing" means, but it touches none of the throttle state, so a
   * telemetry window cannot suppress a log line or vice versa.
   */
  reportHarnessProgress(): IngestHarnessProgressReport[] {
    const now = this.clock.now();
    // Three sources, because a harness can be wedged in any of them and only
    // the first has a live progress entry: a running or settled pass, a pass
    // ABANDONED past its re-drive budget (`abandonPass` drops the entry but
    // preserves the shortfall), and a source scan frozen before it ever reached
    // `beginPass`. Omitting the last two would report the harness as untracked,
    // which a reader cannot tell from "this machine does not use it".
    const harnesses = new Set([
      ...this.progress.keys(),
      ...this.unfinished.keys(),
      ...this.preparing,
    ]);
    return [...harnesses].map((harness) => {
      const remaining = this.remainingSources(harness);
      return {
        harness,
        notAdvancing:
          this.isNotAdvancing(harness, now) || this.isScanFrozen(harness, now),
        ...(remaining === undefined ? {} : { remaining }),
      };
    });
  }

  /**
   * ISS-8346: bytes these harnesses' tracked first passes have still to parse,
   * or `null` when no honest number can be stated for them.
   *
   * MAIN-ONLY. It is deliberately absent from {@link snapshot} and so from the
   * renderer wire: the estimate that consumes it is derived in main against an
   * inventory the renderer does not hold, and a second byte figure on the import
   * banner's payload would be a number nothing renders and everything could
   * disagree with.
   *
   * The caller names the harnesses because the population it is dividing is not
   * this tracker's. The transcript inventory enumerates only the harnesses it
   * measured, so a harness importing outside that set — Cursor, Copilot — must
   * not push the parsed figure past a total that never counted its bytes.
   */
  remainingPendingBytes(harnesses: readonly string[]): number | null {
    return this.pendingBytes.remaining(harnesses, this.preparing);
  }

  /**
   * ISS-8058: the import is demonstrably MOVING — there is a pass in flight that
   * is not parked, and EVERY such pass completed a source within `withinMs`.
   * The boot watchdog asks this before calling a still-running import wedged, so
   * a first launch that is merely large re-arms instead of being reported as a
   * failure.
   *
   * Three things this deliberately does NOT do, each of which had a pre-existing
   * FEA-4156 regression test waiting for it:
   *
   * - It does not read {@link lastAdvancedAt}. That ledger is re-seeded by
   *   `beginPass` and `noteResumed` with no source completed, so a wedged pass
   *   looked freshly-advancing for a whole window after every cooperative
   *   re-entry or resume. Only a completed source counts here.
   * - It does not accept ANY pass moving as proof the import is healthy. One
   *   harness landing sources must not mask a wedged sibling — that is the exact
   *   case this watchdog exists for, and the only control for it, since the
   *   renderer's backstop watches the aggregate the advancing harness is moving.
   * - It does not fall back to the pass start for a harness that has completed
   *   nothing. Absent means no source has ever landed, which is not-advancing:
   *   otherwise a wedge would be excused for its first window.
   *
   * A pass parked by design is excluded rather than counted against — but if
   * every in-flight pass is parked, or none is in flight at all (a source scan
   * frozen before its first `beginPass`), nothing is progressing and this is
   * false, which is what keeps those wedges reachable.
   */
  hasAdvancingPass(withinMs: number): boolean {
    const now = this.clock.now();
    let sawRunningPass = false;
    for (const key of this.startedAt.keys()) {
      if (this.suspended.has(key)) {
        continue;
      }
      sawRunningPass = true;
      const completedAt = this.lastSourceCompletedAt.get(key);
      if (completedAt === undefined || now - completedAt >= withinMs) {
        return false;
      }
    }
    return sawRunningPass;
  }

  /**
   * ISS-5281 (whitlockk review): every begun first pass has ENDED, nothing is
   * scanning, and no pass left work behind. `startedAt` is the in-flight set —
   * `beginPass` seeds it once per pass and `forgetPass` (settle/abandon) clears
   * it — so a yielded pass mid-quantum, a harness still scanning, and a wedged
   * parse all keep this false, none of which the aggregate counters can see.
   * Requires at least one tracked pass: with none, there is nothing this could
   * be asserting, and "unknown" must not read as "finished".
   */
  private isDrained(): boolean {
    if (this.preparing.size > 0 || this.startedAt.size > 0) {
      return false;
    }
    if (this.progress.size === 0) {
      return false;
    }
    for (const shortfall of this.unfinished.values()) {
      if (shortfall > 0) {
        return false;
      }
    }
    return true;
  }

  /** Whether a progress entry already exists (gates the preparing yield). */
  hasEntry(key: string): boolean {
    return this.progress.has(key);
  }

  /**
   * The source scan for this harness has begun (whitlockk review, ISS-4917). Emitted
   * to the log BEFORE the scan blocks — `listSources` plus `loadExistingSessionIds`
   * plus `collectPendingSources` all run before the first `beginPass`, so a
   * freeze in there previously left main.log with no start record and no
   * no-progress record at all. Arms the shared sweep so the frozen scan reports.
   */
  markPreparing(key: string): void {
    if (this.preparing.has(key)) {
      return;
    }
    this.preparing.add(key);
    this.preparingStartedAt.set(key, this.clock.now());
    this.log(`session backfill [${key}]: preparing — scanning source files`);
    this.armStallWatch();
  }

  clearPreparing(key: string): void {
    this.preparing.delete(key);
    this.preparingStartedAt.delete(key);
    this.preparingStallLoggedAt.delete(key);
    this.disarmStallWatchWhenIdle();
  }

  /**
   * First-pass gate: a harness that already finished its first pass is not
   * re-tracked (callers AND this with `lowDutyImport`).
   */
  isFirstPassPending(key: string): boolean {
    return !this.firstPassDone.has(key);
  }

  /**
   * Record the first-pass population for a harness and announce the pass ONCE.
   * ISS-4917: EVERY first pass announces, regardless of source count — the count
   * only decides whether the slow-first-launch hint is appended.
   *
   * `total` is the RECOMPUTED REMAINING population at this (re-)entry, not a
   * fresh pass total, so a yield/resume calls in with a smaller number than the
   * announce. ISS-4715 reconciles it into the existing lifecycle rather than
   * replacing it: the difference against `total - processed` is either work a
   * live watcher completed while this pass was yielded (which advances the
   * numerator) or newly-discovered files (which grow the denominator). Progress
   * therefore never moves backwards.
   *
   * ISS-5028: that reconciliation is only sound because `durable` means exactly
   * "this source
   * will NOT be returned by a later `collectPendingSources`" (see {@link
   * advance}'s `durable`, and `willSourceBeRescanned`). The two failure modes are
   * symmetric, and each would corrupt the reconciliation above in a different
   * direction. Both are ruled out at the call sites:
   *   - counting a source that DOES come back makes `total - processed` too
   *     small, so the retry reads as newly-discovered and adds one to `total` on
   *     every attempt, walking the denominator above the real population (the
   *     ticket's "68 of the announced 67"). A parse timeout that stays
   *     retryable, a mid-write parse throw, and a snapshot `markSourceImported`
   *     refused are therefore all reported non-durable;
   *   - NOT counting a source that will never come back makes it too large, so
   *     the source silently leaving `pending` reads as work completed while
   *     yielded. The parse timeout that crosses the quarantine threshold is
   *     therefore reported DURABLE (ISS-4444 filters a quarantined source out of
   *     every later scan), and so is the `InvalidTokenCountError` cache-mark
   *     whose row already exists.
   *
   * Re-entry also un-suspends the pass and restarts its no-progress window: the
   * yielded interval was not time spent stuck.
   *
   * ISS-8346: `pendingBytes` is the same recomputed remaining population in
   * bytes, and is SET rather than reconciled for exactly the reason the count
   * cannot be — the scan sizes the sources it is about to import, so the sum it
   * arrives with is already the remainder, with no numerator to protect from
   * moving backwards. `null` means the population could not be measured, which
   * is what a batch collector's pass always reports.
   */
  beginPass(
    key: string,
    total: number,
    pendingBytes: number | null = null
  ): void {
    const entry = this.progress.get(key);
    const previousTotal = entry?.total ?? total;
    const expectedRemaining = entry
      ? Math.max(0, entry.total - entry.processed)
      : total;
    // The lifecycle entry this pass reports against, held as a reference: it is
    // either the reconciled existing one or the one created here, so the
    // discovery log below never has to re-read what it already has.
    let current: { total: number; processed: number };
    if (entry) {
      // ISS-4715: a cooperative yield re-enters with the number of files still
      // pending, not a fresh pass total. Replacing the entry here made the UI
      // jump from 1/10 back to 0/9 on every yield. Reconcile the remaining
      // population into the existing lifecycle instead: work completed by a
      // live watcher advances the numerator, while newly-discovered files grow
      // the denominator without ever moving progress backwards.
      if (total > expectedRemaining) {
        entry.total += total - expectedRemaining;
      } else if (total < expectedRemaining) {
        entry.processed += expectedRemaining - total;
      }
      current = entry;
    } else {
      current = { total, processed: 0 };
      this.progress.set(key, current);
    }
    this.processedSinceResume.set(key, 0);
    this.pendingBytes.begin(key, pendingBytes);
    const now = this.clock.now();
    this.suspended.delete(key);
    this.lastAdvancedAt.set(key, now);
    this.stallLoggedAt.delete(key);
    this.armStallWatch();
    const initiallyAnnounced = this.announcedTotal.get(key);
    if (initiallyAnnounced === undefined) {
      this.startedAt.set(key, now);
      this.progressLoggedAt.set(key, now);
      this.announcedTotal.set(key, total);
      const hint = total >= INGEST_LOG_MIN_SOURCES ? SLOW_LAUNCH_HINT : "";
      this.log(
        `session backfill [${key}]: importing ${total} source file(s)${hint}`
      );
      return;
    }
    if (total === expectedRemaining) {
      return;
    }
    // A pass that expands ABOVE the threshold after announcing below it earns
    // the slow-launch hint at the point the larger population becomes known.
    const hint =
      current.total >= INGEST_LOG_MIN_SOURCES &&
      previousTotal < INGEST_LOG_MIN_SOURCES
        ? SLOW_LAUNCH_HINT
        : "";
    if (total > expectedRemaining) {
      const discovered = total - expectedRemaining;
      this.log(
        `session backfill [${key}]: resuming with ${total} source file(s) still pending; ${discovered} newly discovered (${current.processed}/${current.total} complete)${hint}`
      );
      return;
    }
    const completedWhileYielded = expectedRemaining - total;
    this.log(
      `session backfill [${key}]: resuming with ${total} source file(s) still pending; ${completedWhileYielded} completed while yielded (${current.processed}/${current.total} complete)${hint}`
    );
  }

  /**
   * One source reached a TERMINAL outcome for this pass — emit a time-throttled
   * progress line (at most one per INGEST_LOG_INTERVAL_MS). The parse/import
   * totals feed the per-source averages, divided by the source ATTEMPTS since
   * the current resume because those totals reset with it. Completing a source
   * also clears this harness's no-progress state.
   *
   * ISS-5028: `durable` says whether this source will be absent from every later
   * pending scan, not merely that the loop finished with it (a parse timeout and
   * a mid-write parse throw both leave the source unmarked on purpose, so it
   * comes back). Only a durable outcome advances the cumulative `processed`,
   * because a retried source is still in the remaining population that the next
   * {@link beginPass} reconciles against: counting it here would make
   * `total - processed` one too small, the retry would read as a NEWLY DISCOVERED
   * source, and `total` would gain one per attempt — the ticket's "68 of the
   * announced 67".
   *
   * The two populations are therefore different, and the line SAYS so rather
   * than hiding it under one label (bot review): the fraction reports sources
   * FINISHED, while the averages divide by ATTEMPTS since the current resume,
   * because the millisecond totals they average reset with that resume and
   * include the time a retried source cost.
   *
   * ISS-8346: `sourceBytes` leaves the byte remainder on the same condition and
   * for the same reason — a source left for retry is still in the population the
   * next {@link beginPass} will re-sum, so subtracting it here would make the
   * remainder short by that file on every attempt. A source nothing could size
   * passes 0, which is consistent with the total it was never added to.
   */
  advance(
    key: string,
    parseMsTotal: number,
    importMsTotal: number,
    durable = true,
    sourceBytes = 0
  ): void {
    const entry = this.progress.get(key);
    if (!entry) {
      return;
    }
    if (durable) {
      entry.processed += 1;
      this.pendingBytes.consume(key, sourceBytes);
    }
    if (!this.startedAt.has(key)) {
      return;
    }
    // Below the `startedAt` guard so a late advance for an already-settled pass
    // (a deferred import landing after `forgetPass` deleted the divisor) cannot
    // re-seed an entry that nothing will clear until the next stop.
    const sinceResume = (this.processedSinceResume.get(key) ?? 0) + 1;
    this.processedSinceResume.set(key, sinceResume);
    const now = this.clock.now();
    this.suspended.delete(key);
    this.lastAdvancedAt.set(key, now);
    this.lastSourceCompletedAt.set(key, now);
    this.stallLoggedAt.delete(key);
    const lastLoggedAt = this.progressLoggedAt.get(key) ?? 0;
    if (now - lastLoggedAt < INGEST_LOG_INTERVAL_MS) {
      return;
    }
    this.progressLoggedAt.set(key, now);
    const parseAvgMs = Math.round(parseMsTotal / sinceResume);
    const importAvgMs = Math.round(importMsTotal / sinceResume);
    this.log(
      `session backfill [${key}]: ${entry.processed}/${entry.total} source file(s) (avg over ${sinceResume} attempt(s) since resume: parse ${parseAvgMs}ms, import ${importAvgMs}ms)`
    );
  }

  /**
   * This pass is parked BY DESIGN — at the user's backfill pause or returned
   * early to service live-watcher events — so the no-progress watch mutes it.
   * Called by the import loop at the moment it actually parks/returns, so an
   * operation still in flight when the pause was REQUESTED keeps reporting.
   */
  noteSuspended(key: string): void {
    if (!this.startedAt.has(key)) {
      return;
    }
    this.suspended.add(key);
    this.stallLoggedAt.delete(key);
  }

  /** The pass resumed: the suspended interval is not time spent stuck. */
  noteResumed(key: string): void {
    if (!this.suspended.delete(key)) {
      return;
    }
    this.lastAdvancedAt.set(key, this.clock.now());
    this.stallLoggedAt.delete(key);
  }

  /**
   * First full pass for a harness finished — settle its bar to 100%, set the
   * gate so later catch-ups are not re-tracked, and close out an announced
   * backfill with a duration (correct across yield/resume; start time set once).
   * The count reported is the final discovered total, so a pass that grows while
   * it is running never claims completion of only its initial population — and
   * so it is the same number the last periodic line rendered (bot review,
   * ISS-5028: reporting the ANNOUNCE here made the 67 → 74 case print `74/74`
   * and then "complete: 67" in the same log stream).
   */
  settlePass(key: string): void {
    // ISS-5808: a pass that finished is evidence the harness is healthy, so the
    // consecutive-abandon budget starts fresh. Only an UNBROKEN run of
    // abandonments can exhaust it, which is what makes the bound describe a
    // wedged harness rather than an unlucky lifetime.
    this.consecutiveAbandons.delete(key);
    this.firstPassDone.add(key);
    const entry = this.progress.get(key);
    if (entry) {
      // ISS-5281 (whitlockk review): PRESERVE the real shortfall before settling the
      // bar. `completeSource(..., false)` leaves a timed-out, thrown, or
      // snapshot-refused source retryable and out of `processed`, and the
      // first-pass gate set above means this boot will not come back to it — so
      // overwriting `processed` with `total` here is the only record of it, and
      // an aggregate `processed >= total` read afterwards would promote genuinely
      // unfinished work to Ready. The count feeds {@link isDrained}; the bar
      // still settles, because the PASS did end.
      this.unfinished.set(key, Math.max(0, entry.total - entry.processed));
      entry.processed = entry.total;
    }
    const startedAt = this.startedAt.get(key);
    if (startedAt !== undefined) {
      const seconds = Math.max(
        1,
        Math.round((this.clock.now() - startedAt) / 1000)
      );
      const completedTotal = entry?.total ?? this.announcedTotal.get(key) ?? 0;
      // ISS-7306: the bar settles to 100% whether or not the pass left sources
      // behind, so a bare "complete: N" was the only record a reader got — and
      // it read identically for a clean pass and for one that finished with a
      // third of its input unaccounted for. The shortfall preserved just above
      // is named here, so a terminal pass either reconciles or says it did not.
      // Says only what the tracker can prove. `firstPassDone` stops these being
      // re-TRACKED as first-pass progress, which is not the same as never being
      // retried: they stay in the pending population, so a later catch-up pass
      // or the next launch still picks them up. Claiming otherwise here would
      // be the same class of untrue line this change exists to remove.
      const shortfall = this.unfinished.get(key) ?? 0;
      const shortfallNote =
        shortfall > 0
          ? `; ${shortfall} left unfinished, for a later pass to retry`
          : "";
      this.log(
        `session backfill [${key}] first pass complete: ${completedTotal} source file(s) in ${seconds}s${shortfallNote}`
      );
    }
    this.forgetPass(key);
    this.disarmStallWatchWhenIdle();
  }

  /**
   * The pass terminated WITHOUT completing (codex review, ISS-4917): the import
   * rejected after `beginPass`, so the manager caught it and moved on. Drop the
   * bookkeeping — otherwise the entry stays in `startedAt` and the shared sweep
   * reports a "not advancing" line every window for the rest of the manager's
   * life, about a pass that already ended. Deliberately does NOT set the
   * first-pass gate and does NOT log a completion: the pass did not finish, so
   * the next one re-tracks from scratch.
   */
  abandonPass(key: string, reason: string): boolean {
    this.clearPreparing(key);
    const abandons = (this.consecutiveAbandons.get(key) ?? 0) + 1;
    this.consecutiveAbandons.set(key, abandons);
    const redriveBudgeted = abandons <= MAX_CONSECUTIVE_ABANDON_REDRIVES;
    if (!redriveBudgeted) {
      // Emitted BEFORE the early return below: a pass that rejected ahead of
      // `beginPass` has `startedAt` unset, so the rest of this method is
      // skipped — but the budget it just exhausted is exactly the case a reader
      // most needs to see named.
      this.log(
        `session backfill [${key}] re-drive budget exhausted after ${abandons} consecutive abandoned pass(es); leaving the rest to the next launch`
      );
    }
    if (!this.startedAt.has(key)) {
      return redriveBudgeted;
    }
    const entry = this.progress.get(key);
    // ISS-5281: a pass that ended WITHOUT completing left its whole remainder
    // behind, and the progress entry is dropped below, so record the shortfall
    // before it goes. At minimum 1 — an abandon is never a drained outcome, even
    // when the counters happened to reach the total before the rejection.
    this.unfinished.set(
      key,
      Math.max(1, (entry?.total ?? 0) - (entry?.processed ?? 0))
    );
    this.log(
      `session backfill [${key}] abandoned at ${entry?.processed ?? 0}/${entry?.total ?? 0} source file(s): ${reason}`
    );
    this.progress.delete(key);
    this.forgetPass(key);
    this.disarmStallWatchWhenIdle();
    return redriveBudgeted;
  }

  /**
   * No-progress sweep (ISS-4917). Reports every source scan that has not
   * finished and every RUNNING first pass that has completed no source for
   * INGEST_STALL_WARN_MS, re-throttled at the same cadence so a long wedge keeps
   * reporting. Suspended passes (paused / yielded) are muted. Public so the
   * behavior is testable without driving the scheduler.
   */
  checkStalls(): void {
    const now = this.clock.now();
    for (const [key, scanStartedAt] of this.preparingStartedAt) {
      if (!this.isScanFrozen(key, now)) {
        continue;
      }
      if (
        !this.shouldReport(
          now,
          scanStartedAt,
          this.preparingStallLoggedAt.get(key)
        )
      ) {
        continue;
      }
      this.preparingStallLoggedAt.set(key, now);
      this.log(
        `session backfill [${key}] NOT ADVANCING: the source scan has not finished after ${Math.round((now - scanStartedAt) / 1000)}s`
      );
    }
    for (const [key, startedAt] of this.startedAt) {
      if (!this.isNotAdvancing(key, now)) {
        continue;
      }
      const lastAdvancedAt = this.lastAdvancedAt.get(key) ?? startedAt;
      if (
        !this.shouldReport(now, lastAdvancedAt, this.stallLoggedAt.get(key))
      ) {
        continue;
      }
      this.stallLoggedAt.set(key, now);
      const entry = this.progress.get(key);
      const stalledSeconds = Math.round((now - lastAdvancedAt) / 1000);
      const elapsedSeconds = Math.round((now - startedAt) / 1000);
      this.log(
        `session backfill [${key}] NOT ADVANCING: no source completed in the last ${stalledSeconds}s at ${entry?.processed ?? 0}/${entry?.total ?? 0} source file(s) (elapsed ${elapsedSeconds}s; the current source may still be inside its bounded parse/import window)`
      );
    }
  }

  /**
   * stop() cleanup. Drop the stranded progress entries (a restart that finds zero
   * pending sources otherwise strands a settled {total, processed} pair that
   * getIngestProgress keeps reporting) and the console-log bookkeeping (so a
   * restart re-announces from a clean slate), and preserve the first-pass gate
   * for every harness that FINISHED: re-arming it on an in-process restart of an
   * already-imported machine would make a routine catch-up surface as a false
   * "Importing your history" state. A harness that did not finish is re-armed —
   * see the loop below for why that is both the honest banner and the only way
   * the ISS-6116 counters survive a restart.
   */
  resetForStop(): void {
    // ISS-6116 (whitlockk review): re-arm the gate for harnesses that did NOT
    // finish, BEFORE the ledger those harnesses are read from is cleared below.
    // Preserving it unconditionally kept the banner honest on an already-
    // imported machine, but it also meant `trackProgress` stayed false for the
    // rest of the process lifetime — and the backfill telemetry reads the same
    // ledger, so a retry that wedged in parse/import after a collector restart
    // emitted neither `sources_remaining` nor `harness_not_advancing`. A harness
    // still carrying sources that never landed is not "already imported", so
    // re-arming it is also what makes the banner tell the truth.
    for (const key of this.harnessesWithOutstandingWork()) {
      this.firstPassDone.delete(key);
    }
    this.suspended.clear();
    this.preparing.clear();
    this.preparingStartedAt.clear();
    this.preparingStallLoggedAt.clear();
    this.startedAt.clear();
    this.progressLoggedAt.clear();
    this.announcedTotal.clear();
    this.lastAdvancedAt.clear();
    this.lastSourceCompletedAt.clear();
    this.stallLoggedAt.clear();
    this.progress.clear();
    this.processedSinceResume.clear();
    this.unfinished.clear();
    this.consecutiveAbandons.clear();
    this.pendingBytes.clear();
    this.disarmStallWatch();
  }

  /**
   * ISS-6116: source files this harness has not durably finished.
   *
   * The live counters are authoritative WHILE a pass is running. Once it has
   * ended they are not: {@link settlePass} overwrites `processed` with `total`
   * to settle the bar to 100% and {@link abandonPass} drops the entry outright,
   * so a boot that gave up on 500 sources reads as a clean zero (or as nothing
   * at all) — the erasure ISS-5281 preserved `unfinished` to survive, and
   * exactly the "healthy during the outage" lie this counter exists to stop.
   *
   * The order matters both ways. `unfinished` is boot-scoped and survives
   * {@link abandonPass}, which does NOT set the first-pass gate — so a harness
   * whose pass was abandoned and re-begun has a stale shortfall recorded beside
   * a live pass, and reading it in preference would report the old number.
   */
  private remainingSources(key: string): number | undefined {
    const entry = this.progress.get(key);
    if (entry && this.startedAt.has(key)) {
      return Math.max(0, entry.total - entry.processed);
    }
    const shortfall = this.unfinished.get(key);
    if (shortfall !== undefined) {
      return shortfall;
    }
    // A harness still in its source scan has no denominator yet. Undefined, not
    // zero: nobody has measured the population.
    return entry ? Math.max(0, entry.total - entry.processed) : undefined;
  }

  /**
   * ISS-6116: harnesses whose ledger still shows source files that never landed
   * — a live pass caught mid-flight, a settled pass that preserved a shortfall,
   * or an abandoned one. Reads {@link remainingSources}, so "outstanding" means
   * exactly what the telemetry counter means by it; a harness that finished
   * cleanly reports zero and is deliberately absent.
   *
   * Only valid BEFORE {@link resetForStop} clears the ledger it reads.
   */
  private harnessesWithOutstandingWork(): string[] {
    const keys = new Set([...this.progress.keys(), ...this.unfinished.keys()]);
    return [...keys].filter((key) => (this.remainingSources(key) ?? 0) > 0);
  }

  /**
   * ISS-6116: the running-pass half of the not-advancing condition, split out of
   * {@link checkStalls} so the telemetry counter and the log line share one
   * definition. True only for a pass that is RUNNING (`startedAt` is the
   * in-flight set, cleared at settle/abandon), is not parked by design, and has
   * completed no source for a full {@link INGEST_STALL_WARN_MS} window. The
   * frozen-SCAN half, which `checkStalls` reports in its own words because there
   * is no processed/total yet, is {@link isScanFrozen}.
   *
   * Each of those three exclusions is a way "no forward progress" can be true
   * without anything being wrong: a settled or abandoned pass has no work left
   * to advance, a suspended one is paused or yielded on purpose, and a pass that
   * just began has `lastAdvancedAt` seeded at its start so the window has to
   * elapse before it can report. A harness the source scan found nothing for
   * never enters `progress` at all and so is never asked.
   */
  private isNotAdvancing(key: string, now: number): boolean {
    if (this.suspended.has(key)) {
      return false;
    }
    const sinceAdvance = this.msSinceAdvance(key, now);
    return sinceAdvance !== undefined && sinceAdvance >= INGEST_STALL_WARN_MS;
  }

  /**
   * How long this pass has gone without forward progress, or `undefined` if it
   * has no running pass. Reads {@link lastAdvancedAt}, so a begin, a re-entry,
   * or a resume counts — right for {@link isNotAdvancing}'s warn line, which is
   * an observation and not a failure claim. The wedge claim is a stricter
   * question and reads {@link lastSourceCompletedAt} instead.
   */
  private msSinceAdvance(key: string, now: number): number | undefined {
    const startedAt = this.startedAt.get(key);
    if (startedAt === undefined) {
      return undefined;
    }
    return now - (this.lastAdvancedAt.get(key) ?? startedAt);
  }

  /**
   * ISS-6116: the source scan for this harness has been running longer than the
   * no-progress window. The other way a harness stops advancing, and the one
   * with no denominator to report — `listSources`/`collectPendingSources` run
   * before the first {@link beginPass}, so a freeze there produces no progress
   * entry at all (ISS-4917).
   */
  private isScanFrozen(key: string, now: number): boolean {
    const scanStartedAt = this.preparingStartedAt.get(key);
    if (scanStartedAt === undefined) {
      return false;
    }
    return now - scanStartedAt >= INGEST_STALL_WARN_MS;
  }

  /** Whether a not-advancing line is due for `since`, given its last report. */
  private shouldReport(
    now: number,
    since: number,
    lastLoggedAt: number | undefined
  ): boolean {
    if (now - since < INGEST_STALL_WARN_MS) {
      return false;
    }
    return (
      lastLoggedAt === undefined || now - lastLoggedAt >= INGEST_STALL_WARN_MS
    );
  }

  /** Drop one pass's console/no-progress bookkeeping (not the progress entry). */
  private forgetPass(key: string): void {
    this.startedAt.delete(key);
    this.progressLoggedAt.delete(key);
    this.announcedTotal.delete(key);
    this.lastAdvancedAt.delete(key);
    this.lastSourceCompletedAt.delete(key);
    this.stallLoggedAt.delete(key);
    this.suspended.delete(key);
    this.processedSinceResume.delete(key);
  }

  /** Arms the shared sweep once; later passes reuse the same timer. */
  private armStallWatch(): void {
    if (this.cancelStallWatch) {
      return;
    }
    this.cancelStallWatch = this.clock.schedule(
      () => this.checkStalls(),
      INGEST_STALL_CHECK_MS
    );
  }

  /** Drops the shared sweep once no scan and no first pass is in flight. */
  private disarmStallWatchWhenIdle(): void {
    if (this.startedAt.size === 0 && this.preparing.size === 0) {
      this.disarmStallWatch();
    }
  }

  private disarmStallWatch(): void {
    this.cancelStallWatch?.();
    this.cancelStallWatch = null;
  }
}

const defaultIngestProgressClock: IngestProgressClock = {
  now: () => Date.now(),
  schedule: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    // Never hold the main process open just for the no-progress sweep.
    handle.unref?.();
    return () => clearInterval(handle);
  },
};

/**
 * ISS-6116: one harness's backfill state as a settled telemetry window sees it.
 * `harness` is the collector key (a `Harness` value), typed `string` because
 * this tracker is harness-agnostic; the emit site maps it onto the telemetry
 * contract's closed label set.
 */
export type IngestHarnessProgressReport = {
  harness: string;
  /**
   * Source files this harness has not durably finished. Zero is a real answer;
   * ABSENT means no population has been measured yet, which is the state of a
   * harness still inside its source scan.
   */
  remaining?: number;
  notAdvancing: boolean;
};

/**
 * What {@link IngestProgressTracker} plus the three lifecycles the collector
 * manager owns beside it report together — `CollectorManager.getIngestProgress`
 * builds exactly this. Composed off {@link IngestProgressSnapshot} rather than
 * re-listing its fields, so a field added there cannot silently go unreported.
 *
 * Homed here rather than in `collector-manager.ts` (ISS-6116): the snapshot half
 * of this type is already owned by this module, and the manager has no entry in
 * the `noExcessiveLinesPerFile` grandfather list, so the 1,000-line ceiling is
 * enforced on it.
 */
export type IngestProgressReport = IngestProgressSnapshot & {
  importParked: boolean;
  complete: boolean;
  timedOut: boolean;
  retriesExhausted: boolean;
  quarantinedCount: number;
  quarantinedByStage: QuarantinedStageCounts;
};

/**
 * Fold the manager-owned lifecycle facts onto this tracker's snapshot.
 *
 * The three boot fields are DISTINCT claims and are reported separately on
 * purpose (ISS-6207): `complete` means every harness finished its work;
 * `timedOut` means the bound elapsed on an import still running; and
 * `retriesExhausted` means it stopped with source files outstanding after their
 * bounded automatic re-drive budget was spent. Collapsing either degraded claim
 * into `complete` is what let a readiness state be reported over sessions that
 * were never imported. The two degraded claims can both hold at once and neither
 * is the negation of the other — read them through `isBootImportDegraded`.
 */
export function composeIngestProgressReport(input: {
  snapshot: IngestProgressSnapshot;
  /**
   * ISS-5115 (whitlockk review): the import loop has ACKNOWLEDGED a pause by parking
   * on the gate. Distinct from `isImportPaused()`, which is true from the instant
   * the user asks and stays true through a whole source-discovery scan the loop
   * cannot interrupt. The startup panel says "Pausing" until this flips, rather
   * than claiming work already stopped.
   */
  importParked: boolean;
  bootComplete: boolean;
  bootTimedOut: boolean;
  bootRetriesExhausted: boolean;
  /**
   * ISS-4444 / ISS-6115: how many transcripts have been QUARANTINED (their parse
   * wedged or their import exceeded its bound repeatedly, so they are no longer
   * retried). The boot import still COMPLETES with these skipped — this count
   * lets the UI honestly surface "N sessions couldn't be imported" instead of
   * silently under-counting.
   */
  quarantinedCount: number;
  /**
   * ISS-6115 (whitlockk review): the same population split by the stage that
   * quarantined it. `quarantinedCount` alone changed meaning when the import
   * bound started charging the store, and every renderer went on saying the
   * transcript "couldn't be read" — which is false for an import stall, since the
   * file was read and it is the WRITE that did not finish.
   */
  quarantinedByStage: QuarantinedStageCounts;
}): IngestProgressReport {
  return {
    ...input.snapshot,
    importParked: input.importParked,
    complete: input.bootComplete,
    timedOut: input.bootTimedOut,
    retriesExhausted: input.bootRetriesExhausted,
    quarantinedCount: input.quarantinedCount,
    quarantinedByStage: input.quarantinedByStage,
  };
}
