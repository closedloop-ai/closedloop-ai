// FEA-4156: bounded lifecycle for the first-launch boot import.
//
// The boot import settles when every harness's first-import promise settles. A
// single wedged harness (e.g. a Claude Code import whose parse/write never
// resolves) would otherwise leave that `Promise.allSettled` pending forever and
// hang the first-launch import splash — the renderer's per-harness stall
// backstop can't help while OTHER harnesses keep advancing the aggregate count.
//
// Crucially the watchdog does NOT declare the import *complete* when it fires.
// Completion means "every harness actually settled", and it is what claims
// readiness — the cloud-read cutover. Instead the watchdog surfaces a distinct
// *timed out* (degraded) signal that unblocks the splash into its graceful
// partial-import outcome, while the still-running collectors keep filling the DB
// in the background.
//
// ISS-8601: what the timeout no longer does is DROP the post-boot maintenance
// pass (history rebuild + artifact-link backfill) for the whole launch. Running
// it at the moment the watchdog fires would re-queue onto the wedged boundary
// and strand the splash in the Compute stage, so the timeout arm re-arms it for
// the next renderer idle instead — by which point the splash has resolved. The
// re-armed run deliberately does NOT claim the import finished: maintenance
// only, never the readiness cutover. See `post-boot-maintenance-idle-reschedule.ts`.
//
// An intentional pause is not a wedge: while the backfill is paused the import
// loop is deliberately parked, so the watchdog re-arms instead of timing out.
// ISS-8058: neither is a still-advancing import, for the same reason and through
// the same re-arm — see `isAdvancing` below.
//
// This whole completion/timeout concern — the timer AND the terminal-state
// bookkeeping — lives here rather than in the collector-manager
// (AGENTS.md file-size discipline). The manager owns only the
// generation/stopped/paused facts and injects them through the hooks below; it
// delegates its boot-import completion state to `BootImportLifecycle`.

// How often the watchdog WAKES to ask whether the import is wedged — not a
// deadline the import has to beat.
//
// ISS-8058: it used to be that deadline, on the premise that a legitimately large
// first-launch backfill "finishes well within it". That premise was false. A real
// 10,366-transcript profile needs ~90 minutes at the collector's own measured
// pace, so a fixed 30-minute bound with no progress input could not tell WEDGED
// from BIG and fired on every large profile — declaring a healthy, still-climbing
// import failed on the first screen a new user ever sees. The wedge test is now
// `isAdvancing` and this is only the interval between asks. 30 minutes.
export const DEFAULT_BOOT_IMPORT_WATCHDOG_MS = 30 * 60_000;

export type BootImportLifecycleHooks = {
  // How long between wedge checks (defaults to 30 minutes).
  timeoutMs?: number;
  // True once the owning manager has been stopped/superseded; a fired timer for
  // a superseded generation is a no-op.
  isStopped: () => boolean;
  // The manager's current generation. A start()/stop() bumps it, so a stale
  // epoch's timer must not act on the live state.
  currentGeneration: () => number;
  // The backfill is intentionally paused: the import loop is parked on purpose,
  // so the watchdog re-arms rather than treating the park as a wedge.
  isPaused: () => boolean;
  // ISS-8058: a source completed recently enough that the import is still
  // moving. Same answer as `isPaused` for the same reason — it is not wedged —
  // and it takes the same re-arm. This is what makes the wedge test "no source
  // has landed in the window" rather than "the clock ran out", so corpus size
  // stops deciding whether a healthy import gets reported as a failure.
  isAdvancing: () => boolean;
  // Fired once when every harness's boot import actually settles having FINISHED
  // its work (all promises settled, nothing left behind). Triggers the post-boot
  // maintenance pass.
  onComplete: () => void;
  // Fired once when the bound elapses on a still-running, non-paused import: the
  // degraded/timedOut signal (NOT complete). The cloud-read cutover must NOT
  // run; ISS-8601 re-arms post-boot maintenance from this arm for the next
  // renderer idle, without claiming readiness.
  onTimeout: () => void;
  // ISS-6207: fired once when the boot import settles but at least one harness
  // stopped with sources outstanding after spending its bounded automatic
  // re-drive budget. Degraded, NOT complete — maintenance and the cloud-read
  // cutover must NOT run, but deferred best-effort startup work is released so a
  // partial import cannot hold it forever.
  onRetriesExhausted: () => void;
  // Structured log sink (the manager's `log`).
  log: (message: string) => void;
};

/**
 * Owns the boot-import terminal lifecycle for one manager: the bounded timer
 * plus the three terminal claims it can make — `complete` (finished all work),
 * `timedOut` (the bound elapsed on a still-running import), and
 * `retriesExhausted` (ISS-6207: it settled with sources outstanding after their
 * automatic re-drive budget was spent).
 *
 * `complete` excludes the other two: a finished import is neither degraded. The
 * two DEGRADED claims are not mutually exclusive and must not be forced to be —
 * the watchdog can give up on a slow harness and that harness can then settle
 * having spent its budget, and both statements are true. Consumers fold them
 * (`isBootImportDegraded`); nothing reads one as the negation of the other.
 *
 * `arm(gen)` starts a fresh bound;
 * `settle(gen)` resolves the terminal state for a genuine settle (clearing the
 * timer); the watchdog firing records a timeout. Re-arming always cancels the
 * prior timer first, so there is never more than one live timer. `reset()` clears
 * every terminal fact for a fresh start(); `clear()` cancels an armed timer
 * without touching the terminal state (used by stop()).
 */
export class BootImportLifecycle {
  private readonly hooks: BootImportLifecycleHooks;
  private timer: NodeJS.Timeout | null = null;
  private completed = false;
  private timedOut = false;
  private retriesExhausted = false;
  private sawRetriesExhausted = false;

  constructor(hooks: BootImportLifecycleHooks) {
    this.hooks = hooks;
  }

  /** True once every harness's boot import actually settled having finished. */
  isComplete(): boolean {
    return this.completed;
  }

  /**
   * True once the watchdog gave up without the import settling. Degraded, NOT
   * complete — no post-boot maintenance runs; the splash resolves into its
   * graceful partial-import outcome.
   */
  isTimedOut(): boolean {
    return this.timedOut;
  }

  /**
   * ISS-6207: true once the boot import SETTLED but left sources behind that its
   * bounded automatic re-drive budget could not recover. Degraded, NOT complete.
   * Deliberately the settled terminal only — the pending fact recorded by
   * {@link noteRetriesExhausted} is not reported, because an exhaustion observed
   * while OTHER harnesses are still importing is not yet a terminal state and
   * must not let a reader latch the boot import off early.
   */
  isRetriesExhausted(): boolean {
    return this.retriesExhausted;
  }

  /**
   * ISS-6207: record that one harness's pass stopped with work outstanding and
   * its automatic re-drive budget is spent. Only the branch that actually
   * exhausted a budget calls this.
   *
   * Generation-guarded like {@link arm} and {@link settle}: `runImportFor` is the
   * shared entry point for every full sweep, so a stale epoch's late rejection
   * (a `stop()`/`start()` restart does not await in-flight imports) must not vote
   * on the live epoch's terminal state.
   *
   * Ignored once a SETTLED terminal is recorded — a post-boot catch-up poll
   * exhausting its budget hours later says nothing about the BOOT import. NOT
   * ignored after a timeout: the watchdog firing does not end the import, so an
   * exhaustion that lands afterwards is still news, and swallowing it here is
   * what let the late `settle()` fall through to `onComplete` and re-open this
   * ticket's defect on the timeout-first path (review-soul).
   *
   * One-way within a generation, and deliberately so: a catch-up sweep that
   * later recovers the sources cannot clear it, so a boot that fully recovered
   * can still settle degraded and skip maintenance for that launch. That errs
   * toward under-claiming, which is the safe direction here and the opposite of
   * the defect this ticket fixes; clearing it would need per-harness bookkeeping
   * (one harness completing must not erase another's exhaustion). `reset()`
   * clears it on the next `start()`.
   */
  noteRetriesExhausted(generation: number): void {
    if (
      this.hooks.isStopped() ||
      this.hooks.currentGeneration() !== generation
    ) {
      return;
    }
    if (this.completed || this.retriesExhausted) {
      return;
    }
    this.sawRetriesExhausted = true;
  }

  /** Clear every terminal fact and cancel any armed timer, for a fresh start(). */
  reset(): void {
    this.clear();
    this.completed = false;
    this.timedOut = false;
    this.retriesExhausted = false;
    this.sawRetriesExhausted = false;
  }

  /**
   * Resolve the boot-import terminal state exactly once for `generation`.
   * Idempotent (a no-op once a settled terminal is recorded for the live
   * generation) and generation-guarded so a stale epoch's late settle can't
   * double-fire a hook or clobber a newer start(). Clears the watchdog so a
   * genuine settle cancels the pending timeout.
   *
   * ISS-6207: settling is not the same claim as completing. Every promise having
   * settled while a harness gave up on outstanding sources is a DEGRADED
   * outcome — it takes the `onRetriesExhausted` arm, which releases the deferred
   * startup work exactly as the timeout arm does but fires neither post-boot
   * maintenance nor the cloud-read completion gate over sources never imported.
   *
   * The same holds once the watchdog has already timed out: an ALREADY-DEGRADED
   * boot import is never upgraded to complete by a late settle, whether or not a
   * re-drive budget was also spent. Only a settle that reaches this method with
   * no degraded terminal recorded may claim `complete`.
   */
  settle(generation: number): void {
    if (
      this.hooks.isStopped() ||
      this.hooks.currentGeneration() !== generation
    ) {
      return;
    }
    this.clear();
    if (this.completed || this.retriesExhausted) {
      return;
    }
    if (this.sawRetriesExhausted) {
      this.retriesExhausted = true;
      this.hooks.log(
        "boot import settled with source files left behind after their re-drive budget was spent; surfacing the degraded partial-import state (no post-boot maintenance, no cloud-read cutover) — the catch-up poll and the next launch still retry them"
      );
      this.hooks.onRetriesExhausted();
      return;
    }
    if (this.timedOut) {
      // The watchdog already gave up on this boot import and the renderer was
      // already told it was degraded. A later clean settle does not retract that
      // — the harness the watchdog gave up on ran unbounded past the point we
      // stopped accounting for it, so "every promise settled" here is not
      // evidence every source was imported. Claiming `complete` would fire the
      // cloud-read cutover over that gap, which is this ticket's defect arriving
      // by the timeout-first path (davetho).
      //
      // ISS-8601 did not change this. Re-arming the REBUILD is safe; claiming the
      // import finished is not, and only the timeout arm re-arms — with the
      // readiness claim explicitly suppressed.
      this.hooks.log(
        "boot import settled after the watchdog had already given up on it; keeping the degraded timed-out terminal (no cloud-read cutover; maintenance is re-armed separately by the timeout arm) rather than upgrading a late settle to complete"
      );
      return;
    }
    this.completed = true;
    this.hooks.onComplete();
  }

  arm(generation: number): void {
    this.clear();
    const timeoutMs = this.hooks.timeoutMs ?? DEFAULT_BOOT_IMPORT_WATCHDOG_MS;
    let timer: NodeJS.Timeout;
    const onFire = () => {
      // Only drop the field if this timer still owns it (a re-arm/clear always
      // clears a superseded timer before arming a new one; this is defensive).
      if (this.timer === timer) {
        this.timer = null;
      }
      if (
        this.hooks.isStopped() ||
        this.hooks.currentGeneration() !== generation
      ) {
        return;
      }
      // An intentional pause is not a wedge: re-arm and wait out another window
      // rather than declaring the parked import timed out.
      if (this.hooks.isPaused()) {
        this.hooks.log(
          `boot import watchdog fired after ${Math.round(timeoutMs / 1000)}s while paused; re-arming (a deliberate pause is not a wedge)`
        );
        this.arm(generation);
        return;
      }
      // ISS-8058: still landing sources, so this is a large import rather than a
      // wedged one. Re-arm and ask again next window.
      if (this.hooks.isAdvancing()) {
        this.hooks.log(
          `boot import watchdog fired after ${Math.round(timeoutMs / 1000)}s while the import was still advancing; re-arming (a large first launch is not a wedge)`
        );
        this.arm(generation);
        return;
      }
      this.markTimedOut();
    };
    timer = setTimeout(onFire, timeoutMs);
    // Never keep the process alive solely for this watchdog.
    timer.unref?.();
    this.timer = timer;
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * The watchdog gave up — the import never settled within the window. This
   * deliberately does NOT flip `completed` and does NOT fire `onComplete`, which
   * would claim readiness over sources that were never imported AND would queue
   * post-boot maintenance onto the still-wedged boundary, stranding the splash in
   * Compute. It flips the degraded `timedOut` signal instead so the splash
   * resolves into its graceful partial-import outcome; the still-running
   * collectors keep filling the DB.
   *
   * ISS-8601: the maintenance half is re-armed by the `onTimeout` consumer for
   * the next renderer idle, which is a different moment and therefore a different
   * question — the splash is gone by then. The readiness claim is not re-armed
   * with it, and never is.
   */
  private markTimedOut(): void {
    if (this.completed || this.timedOut || this.retriesExhausted) {
      return;
    }
    this.timedOut = true;
    this.hooks.log(
      "boot import watchdog fired; the import did not settle, surfacing the graceful partial-import state so the splash cannot hang (collectors keep running)"
    );
    this.hooks.onTimeout();
  }
}
