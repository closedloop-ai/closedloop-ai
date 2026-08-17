/**
 * @file collector-manager-low-duty-pacing.ts
 * @description How the LOW-DUTY historical import pass paces itself: the
 * cooperative per-source / per-session pauses, and the gate that decides when the
 * pass may return early to service queued live-watcher events.
 *
 * Extracted from collector-manager.ts (grandfathered shrink-only under the root
 * AGENTS.md line-count contract) so this one cohesive concern — "how hard may the
 * backfill run, and when must it step aside" — lives in a module that can own its
 * own contract and its own tests.
 *
 * ISS-5028: the live-event yield had NO anti-starvation floor. The predicate the
 * watcher supplies is simply `pendingEvents.length > 0`, so a SINGLE queued
 * filesystem event parked the pass after one source. On a machine actively
 * running the very harness being imported (Claude Code appends to a session JSONL
 * on every assistant turn and writes a fresh transcript per sub-agent), the queue
 * is never empty for long, so the pass yielded after every source indefinitely.
 * Each resume also pays a full source re-scan (listSources + existing-id load +
 * collectPendingSources), so throughput collapsed to roughly one source per
 * re-scan while the source population kept growing underneath it — an operator
 * watched 67 sources oscillate between 67 and 68 pending for 15+ minutes and
 * never finish.
 *
 * The fix is a minimum work quantum, NOT removal of the yield (which exists to
 * keep live capture responsive): the pass honors the yield only once it has
 * completed at least `MIN_SOURCES_PER_LIVE_YIELD_QUANTUM` sources — OR spent at
 * least `MAX_MS_PER_LIVE_YIELD_QUANTUM` working — since it last resumed. That
 * turns an unbounded starvation into a bounded delay in both directions:
 *   - the pass now needs at most ceil(pending / quantum) resumes rather than one
 *     resume per source, so it converges even while the population grows;
 *   - a live event waits at most one quantum, and is queued — or, on watcher
 *     overflow, coalesced into a full historical sweep — never silently lost.
 * The renderer stays responsive within a quantum through the cooperative pauses
 * below and the per-session `cooperativeDelay(0)` in the import loop; the yield
 * is about servicing watcher EVENTS, not about unblocking the main thread.
 *
 * ## The quantum counts sessions and working time, not just sources
 *
 * A source-only floor is not actually a bound on how long a live event waits,
 * and for one harness shape it is not a bound at all:
 *
 *   - Per-source work is bounded by `HISTORICAL_PARSE_TIMEOUT_MS` (90s) and a
 *     per-session import timeout, so ten sources is worst-case many minutes.
 *     The pre-existing yield after a parse timeout (see `collector-manager.ts`,
 *     the ISS-4444 note) exists precisely so a live event does not wait one
 *     ~90s timeout window; a source-only floor would make it wait ten.
 *   - A BATCH harness (OpenCode) is one source by construction: `listSources()`
 *     returns a single store sentinel and `parse()` loads every session from it
 *     (see `types.ts`, `BatchHarnessCollector`). Completed SOURCES therefore
 *     stay at 0 for the entire multi-thousand-session import, so a source-only
 *     floor would make both yield sites unreachable and service zero live
 *     events for the whole run.
 *
 * So the quantum counts three kinds of progress — sources completed, sessions
 * imported, and time actually spent working — and the two yield sites do NOT
 * accept the same ones (see below). The starvation this file exists to fix came
 * from sources that complete in milliseconds (a re-scan per source), and those
 * still accrue the 10-source floor long before either other term opens.
 *
 * ## The clock measures WORKING time, not wall time
 *
 * The user can PAUSE the first-launch backfill from the import banner, and that
 * park happens inside the same loop this gate paces. Counting it as quantum
 * time would mean any pause longer than the quantum leaves the gate already
 * open on resume, so the pass yields after a single source and pays a full
 * re-scan for it — the starvation this module exists to prevent, reached by way
 * of the pause button. `noteParked`/`noteUnparked` therefore discount parked
 * time, so "elapsed" really is time spent importing (bot review, ISS-5028).
 *
 * ## Why a MID-SOURCE yield may not use the time escape
 *
 * The two yield sites are not equivalent, because only one of them has a
 * checkpoint. Yielding at a SOURCE boundary keeps everything the pass did: the
 * source is marked seen / its snapshot committed, so the next resume skips it.
 * Yielding from INSIDE a source's session loop has nothing to resume from — the
 * source is deliberately left unmarked, so the next pass re-lists, re-scans and
 * re-PARSES that whole source from session zero. For a batch harness that is
 * the entire store.
 *
 * A time escape at that site is therefore self-defeating: on a machine whose
 * watcher queue never drains, a store whose parse alone approaches the quantum
 * would yield after the first session of every resume, re-parse the whole store,
 * and never finish — ISS-5028 again, one layer down (wongk review). The
 * mid-source gate consequently requires a real, DURABLE batch of imported
 * sessions (`MIN_SESSIONS_PER_LIVE_YIELD_QUANTUM`) and nothing else, which
 * bounds a batch import at ceil(sessions / quantum) resumes rather than leaving
 * it unbounded. Sessions already imported are committed to the database, so
 * that work survives the yield even though the source-level marker does not.
 *
 * That bound only holds if the sessions imported after a resume are NEW ones,
 * which is what `BatchResumeCursors` (in the sibling
 * `collector-manager-batch-resume.ts`, where ISS-5161 also made it durable
 * across a restart) provides: without it the
 * re-parsed source replays from session zero and every resume imports the same
 * prefix. The session floor and the cursor are one mechanism — the floor makes
 * each quantum do a batch of work, the cursor makes it a batch of DIFFERENT
 * work.
 */

// Cooperative pause after each source in a large-backlog pass: at least this
// long, at most this long, otherwise proportional to what the source just cost.
const MIN_COOPERATIVE_IMPORT_PAUSE_MS = 10;
const MAX_COOPERATIVE_IMPORT_PAUSE_MS = 100;
const MIN_HISTORICAL_SESSION_IMPORT_PAUSE_MS = 0;
// FEA-2038: the heavy import writes now run in the DB host utilityProcess, not
// on the main thread, so the backfill no longer needs the old 3x/1.5s pause to
// keep the UI alive. We keep only a setTimeout(0) yield between sessions (so the
// import loop still interleaves live watcher events) and let the per-session
// `await importSession` IPC round-trip pace throughput against child write speed.
const MAX_HISTORICAL_SESSION_IMPORT_PAUSE_MS = 50;
const HISTORICAL_SESSION_IMPORT_PAUSE_MULTIPLIER = 0;

/**
 * ISS-5028: minimum sources a low-duty pass must complete after (re)entering
 * before it may honor the live-event yield. Sized so a resume's fixed cost (the
 * full source re-scan) is amortized over real work, while a live event still
 * waits only a handful of sources.
 */
export const MIN_SOURCES_PER_LIVE_YIELD_QUANTUM = 10;

/**
 * ISS-5028: the time escape on that floor, at the SOURCE-BOUNDARY yield site
 * only. Once a pass has been working this long since it last resumed, it may
 * honor the live-event yield even though it has not completed
 * `MIN_SOURCES_PER_LIVE_YIELD_QUANTUM` sources — the case of a handful of very
 * slow sources, where waiting for ten of them would make a live event wait ten
 * bounded parse windows. Sized well above a normal source's cost so the source
 * floor, not the clock, governs the fast-source starvation this fixes.
 *
 * Deliberately NOT accepted by {@link LiveYieldGate.shouldYieldMidSource}: that
 * site has no checkpoint, so a single slow re-parse could consume the escape and
 * yield having imported nothing. See the file header.
 */
export const MAX_MS_PER_LIVE_YIELD_QUANTUM = 30_000;

/**
 * ISS-5028 (wongk review): minimum sessions a low-duty pass must have DURABLY
 * imported this quantum before it may yield from INSIDE a source's session loop.
 * The only term that gate accepts — see the file header for why neither the
 * source floor (a mid-source yield means the current source has not completed)
 * nor the time escape (a single re-parse can consume it whole, so the pass would
 * yield having imported nothing) can bound that site. Sized to amortize the full
 * re-list + re-scan + re-parse that a mid-source resume pays, while still
 * bounding a multi-thousand-session batch store at a small number of resumes.
 */
export const MIN_SESSIONS_PER_LIVE_YIELD_QUANTUM = 100;

/**
 * The low-duty pass's live-event yield decision, with the ISS-5028 starvation
 * floor applied. One gate per `importSources` invocation, so "this quantum" means
 * "since this pass entered or last resumed".
 */
export type LiveYieldGate = {
  /** A source reached a TERMINAL outcome (imported, dead-lettered, or skipped). */
  noteSourceCompleted(): void;
  /**
   * The pass parked at the user's backfill pause. Wall time spent parked is NOT
   * time spent working, so it is excluded from the quantum's time escape.
   */
  noteParked(): void;
  /** The pass resumed from the user's backfill pause. */
  noteUnparked(): void;
  /** One session was durably imported (committed to the database). */
  noteSessionImported(): void;
  /**
   * Whether the pass may return early — at a SOURCE boundary, where the source
   * just finished is marked/committed and the next resume skips it.
   */
  shouldYield(): boolean;
  /**
   * Whether the pass may return early from INSIDE a source's session loop, where
   * the source is left unmarked and will be re-parsed in full. Accepts only the
   * durable-session floor; see the file header.
   */
  shouldYieldMidSource(): boolean;
  /**
   * Sources completed since this pass entered or last resumed. A gate is built
   * per `importSources` invocation and every `shouldYield() === true` is
   * immediately followed by a return, so a gate only ever spans one quantum.
   * Exposed for the pacing tests.
   */
  sourcesThisQuantum(): number;
  /** Sessions durably imported since this pass entered or last resumed. */
  sessionsThisQuantum(): number;
  /** Milliseconds this quantum has spent WORKING (parked time excluded). */
  workingMsThisQuantum(): number;
};

export function computeCooperativeImportPauseMs(
  sourceDurationMs: number
): number {
  return Math.min(
    MAX_COOPERATIVE_IMPORT_PAUSE_MS,
    Math.max(MIN_COOPERATIVE_IMPORT_PAUSE_MS, sourceDurationMs)
  );
}

export function computeHistoricalSessionImportPauseMs(
  sessionImportDurationMs: number
): number {
  return Math.min(
    MAX_HISTORICAL_SESSION_IMPORT_PAUSE_MS,
    Math.max(
      MIN_HISTORICAL_SESSION_IMPORT_PAUSE_MS,
      sessionImportDurationMs * HISTORICAL_SESSION_IMPORT_PAUSE_MULTIPLIER
    )
  );
}

/**
 * The two cooperative pauses the import loop takes, bound to the manager's stop
 * flag and its injected delay. Both are "sleep for as long as the unit of work
 * just cost, clamped — unless the manager already stopped", so a stop() during a
 * long backfill is not made to wait out one more pause before the loop unwinds.
 */
export type ImportPauses = {
  /** After finishing a source, while the backlog is large. */
  afterLargeBacklogSource(sourceStartedAt: number): Promise<void>;
  /** Between two historical sessions parsed from the same source. */
  afterHistoricalSession(sessionImportStartedAt: number): Promise<void>;
};

export function createImportPauses(options: {
  isStopped: () => boolean;
  delay: (ms: number) => Promise<void>;
}): ImportPauses {
  const pause = async (
    startedAt: number,
    computeMs: (elapsedMs: number) => number
  ): Promise<void> => {
    if (options.isStopped()) {
      return;
    }
    await options.delay(computeMs(Date.now() - startedAt));
  };
  return {
    afterLargeBacklogSource: (sourceStartedAt) =>
      pause(sourceStartedAt, computeCooperativeImportPauseMs),
    afterHistoricalSession: (sessionImportStartedAt) =>
      pause(sessionImportStartedAt, computeHistoricalSessionImportPauseMs),
  };
}

/**
 * Build the per-pass yield gate. A live-watcher (non low-duty) import never
 * yields, and an absent predicate (no watcher supplied controls) never yields —
 * both preserved exactly as before ISS-5028. The only behavior change is the
 * minimum-quantum floor applied to the low-duty pass.
 *
 * `minSourcesPerQuantum`, `maxQuantumMs`, `minSessionsPerQuantum`, and `now` are
 * injectable for tests; production always uses the exported constants and the
 * wall clock.
 */
export function createLiveYieldGate(
  lowDutyImport: boolean,
  shouldYieldToLiveEvents: (() => boolean) | undefined,
  minSourcesPerQuantum: number = MIN_SOURCES_PER_LIVE_YIELD_QUANTUM,
  maxQuantumMs: number = MAX_MS_PER_LIVE_YIELD_QUANTUM,
  now: () => number = Date.now,
  minSessionsPerQuantum: number = MIN_SESSIONS_PER_LIVE_YIELD_QUANTUM
): LiveYieldGate {
  let completed = 0;
  let sessionsImported = 0;
  const quantumStartedAt = now();
  // ISS-5028 (review): the time escape must measure time spent WORKING, which is
  // what the header claims and what makes it a proxy for "a live event has waited
  // long enough". The gate lives for the whole `importSources` invocation, and
  // that invocation can sit indefinitely at the user's backfill pause
  // (`this.pause.wait()`), so raw wall time would count a paused import as work:
  // after any pause longer than one quantum the gate is already open and the pass
  // yields on the very next source, paying a full re-scan for one source's worth
  // of progress. Parked intervals are subtracted instead.
  let parkedMsTotal = 0;
  let parkedAt: number | null = null;
  const workingMs = (): number => {
    const at = now();
    const parked = parkedMsTotal + (parkedAt === null ? 0 : at - parkedAt);
    return at - quantumStartedAt - parked;
  };
  return {
    noteSourceCompleted(): void {
      completed += 1;
    },
    noteSessionImported(): void {
      sessionsImported += 1;
    },
    noteParked(): void {
      parkedAt ??= now();
    },
    noteUnparked(): void {
      if (parkedAt === null) {
        return;
      }
      parkedMsTotal += now() - parkedAt;
      parkedAt = null;
    },
    shouldYield(): boolean {
      if (!lowDutyImport) {
        return false;
      }
      // The quantum is checked BEFORE the predicate so a starved pass does not
      // even ask: a queued event cannot park the pass until it is met. Met by
      // EITHER enough completed sources or enough elapsed work time — see the
      // file header for why the source floor alone is not a bound.
      if (completed < minSourcesPerQuantum && workingMs() < maxQuantumMs) {
        return false;
      }
      return shouldYieldToLiveEvents?.() === true;
    },
    shouldYieldMidSource(): boolean {
      if (!lowDutyImport) {
        return false;
      }
      // Deliberately NOT the source floor or the time escape: this site has no
      // checkpoint, so the only thing that makes a resume cheaper than a restart
      // is durable sessions already committed. See the file header.
      if (sessionsImported < minSessionsPerQuantum) {
        return false;
      }
      return shouldYieldToLiveEvents?.() === true;
    },
    sourcesThisQuantum(): number {
      return completed;
    },
    sessionsThisQuantum(): number {
      return sessionsImported;
    },
    workingMsThisQuantum(): number {
      return workingMs();
    },
  };
}
