// FEA-4156: bounded lifecycle for the first-launch boot import.
//
// The boot import settles when every harness's first-import promise settles. A
// single wedged harness (e.g. a Claude Code import whose parse/write never
// resolves) would otherwise leave that `Promise.allSettled` pending forever and
// hang the first-launch import splash — the renderer's per-harness stall
// backstop can't help while OTHER harnesses keep advancing the aggregate count.
//
// Crucially the watchdog does NOT declare the import *complete* when it fires.
// Completion means "every harness actually settled", and it is what triggers the
// post-boot maintenance pass (history rebuild + artifact-link backfill). Firing
// maintenance against a still-wedged import host would just re-queue onto the
// wedged boundary and strand the splash in the Compute stage. Instead the
// watchdog surfaces a distinct *timed out* (degraded) signal that unblocks the
// splash into its graceful partial-import outcome, while the still-running
// collectors keep filling the DB in the background.
//
// An intentional pause is not a wedge: while the backfill is paused the import
// loop is deliberately parked, so the watchdog re-arms instead of timing out.
//
// This whole completion/timeout concern — the timer AND the terminal-state
// bookkeeping — lives here rather than in the grandfathered collector-manager
// (AGENTS.md file-size discipline). The manager owns only the
// generation/stopped/paused facts and injects them through the hooks below; it
// delegates its boot-import completion state to `BootImportLifecycle`.

// Default bound for the boot-import timeout. Generous enough that a legitimately
// large first-launch backfill of a year of history (staggered per-harness,
// cooperatively paced) finishes well within it, so the watchdog only ever fires
// when a harness's import has genuinely wedged and its first-import promise will
// never settle on its own. 30 minutes.
export const DEFAULT_BOOT_IMPORT_WATCHDOG_MS = 30 * 60_000;

export type BootImportLifecycleHooks = {
  // The wall-clock bound before the watchdog fires (defaults to 30 minutes).
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
  // Fired once when every harness's boot import actually settles (all promises
  // settled). Triggers the post-boot maintenance pass.
  onComplete: () => void;
  // Fired once when the bound elapses on a still-running, non-paused import: the
  // degraded/timedOut signal (NOT complete). Maintenance must NOT run.
  onTimeout: () => void;
  // Structured log sink (the manager's `log`).
  log: (message: string) => void;
};

/**
 * Owns the boot-import completion/timeout lifecycle for one manager: the bounded
 * timer plus the two terminal booleans (`complete`, `timedOut`). `arm(gen)`
 * starts a fresh bound; `complete(gen)` records a genuine settle (clearing the
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

  constructor(hooks: BootImportLifecycleHooks) {
    this.hooks = hooks;
  }

  /** True once every harness's boot import actually settled. */
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

  /** Clear every terminal fact and cancel any armed timer, for a fresh start(). */
  reset(): void {
    this.clear();
    this.completed = false;
    this.timedOut = false;
  }

  /**
   * Settle the boot-import completion exactly once for `generation`. Idempotent
   * (a no-op once already complete for the live generation) and generation-guarded
   * so a stale epoch's late settle can't double-fire `onComplete` or clobber a
   * newer start(). Clears the watchdog so a genuine settle cancels the pending
   * timeout.
   */
  complete(generation: number): void {
    if (
      this.hooks.isStopped() ||
      this.hooks.currentGeneration() !== generation
    ) {
      return;
    }
    this.clear();
    if (this.completed) {
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
   * deliberately does NOT flip `completed` and does NOT fire `onComplete` (which
   * would queue post-boot maintenance onto the still-wedged import boundary and
   * strand the splash in Compute). It flips the degraded `timedOut` signal
   * instead so the splash resolves into its graceful partial-import outcome; the
   * still-running collectors keep filling the DB.
   */
  private markTimedOut(): void {
    if (this.completed || this.timedOut) {
      return;
    }
    this.timedOut = true;
    this.hooks.log(
      "boot import watchdog fired; the import did not settle, surfacing the graceful partial-import state so the splash cannot hang (collectors keep running)"
    );
    this.hooks.onTimeout();
  }
}
