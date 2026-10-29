/**
 * @file historical-import-bounds.ts
 * @description The wall-clock bounds of the first-launch historical import, in
 * the one place BOTH processes can read them.
 *
 * ISS-8059: the renderer's import splash and the main-process import loop each
 * owned a private no-movement number, and they disagreed — the renderer called
 * failure at 120s over a source the main process was still granting up to 210s.
 * `120_000` appeared in `bounded-import-session.ts` meaning "keep waiting, this
 * is fine" and in the splash meaning "give up, call it failed". A bound one
 * process honors and another contradicts is a single contract, so it lives here
 * and is imported, never restated.
 *
 * This module is deliberately a LEAF: it imports nothing, so the renderer can
 * read it without pulling main-process code into its bundle.
 */

/**
 * ISS-4444: default per-source wall-clock bound for the historical parse await.
 *
 * The boot-import loop `await`s `parseSource(source)` once per transcript. The
 * ISS-4410 fix bounded the *write* (`importSession`); this is the sibling bound
 * for the *parse*. Two real failure modes never THROW, so the loop's existing
 * try/catch dead-letter `continue` never fires and the whole 1545-source import
 * wedges at `1/1545`:
 *
 * 1. A catastrophic-regex-backtrack / CPU-spin inside a parser on a pathological
 *    transcript — the parse promise never settles, and the parser pegs a CPU
 *    core indefinitely.
 * 2. (The import-write hang — bounded separately by ISS-4410.)
 *
 * A `setTimeout` alone cannot preempt a synchronous CPU-spin in the SAME isolate.
 * In production `parseSource` runs in the Electron utility-process worker turn
 * (`historicalParseRunner`), which is separately abandonable and killable — so the
 * manager can move on even while the worker turn is still spinning, and (via the
 * optional `onTimeout` abort hook) signal the worker to kill that turn so the pegged
 * core is reclaimed. When the runner is absent (tests, golden mode) the parse runs
 * in-process and this bound cannot preempt a synchronous spin; it still lets the
 * loop advance once the turn yields (the residual is documented on the manager).
 *
 * Generous enough that a legitimately large single-transcript parse completes well
 * within it. Tests pin it small; `null` disables the bound (restores the prior
 * unbounded await). 90 seconds — comfortably under the 5-minute utility-process
 * worker timeout so the manager gives up (and abandons/aborts the turn) before the
 * worker's own kill fires.
 */
export const HISTORICAL_PARSE_TIMEOUT_MS = 90_000;

/**
 * ISS-4410: default per-session bound for the historical import write. Generous
 * enough that a legitimately large single-session write (a long transcript's
 * event/token/artifact rows through the DB-host write queue, plus its throttled
 * WAL checkpoint) completes well within it, so the bound only ever fires when a
 * single session's write has genuinely wedged — a DB-host write that is accepted
 * but never completes — and would otherwise stall the entire boot import at the
 * first of N sessions. 2 minutes.
 */
export const HISTORICAL_IMPORT_SESSION_TIMEOUT_MS = 2 * 60_000;

/**
 * ISS-8059: the longest ONE source may legitimately occupy the import loop
 * without the aggregate `processed` count moving — its sanctioned parse bound
 * followed by its sanctioned write bound, back to back. Below this, no-movement
 * is not evidence of anything: the loop is inside a budget it granted on purpose.
 *
 * Derived, never restated. Raising either bound above moves this with it, which
 * is the whole reason both give-ups read it instead of a private literal.
 */
export const SANCTIONED_SOURCE_STALL_MS =
  HISTORICAL_PARSE_TIMEOUT_MS + HISTORICAL_IMPORT_SESSION_TIMEOUT_MS;

/** How often the splash's no-movement watcher samples the aggregate count. */
export const IMPORT_STALL_CHECK_INTERVAL_MS = 10_000;

/**
 * ISS-8058 / ISS-8059: the no-movement window after which a still-running import
 * may be called WEDGED rather than merely slow — the shared give-up both the
 * splash's stall latch and the main-process boot watchdog measure against.
 *
 * One sample interval past the sanctioned per-source budget, so it is the
 * smallest window that cannot fire while a single source is still inside bounds
 * the main process granted it. The margin is the poll granularity and nothing
 * more: a give-up any tighter is arithmetically guaranteed to accuse a healthy
 * import, and a wider one is a product judgment about how long a user should
 * wait, which is not this bound's to make.
 */
export const IMPORT_NO_MOVEMENT_GIVE_UP_MS =
  SANCTIONED_SOURCE_STALL_MS + IMPORT_STALL_CHECK_INTERVAL_MS;
