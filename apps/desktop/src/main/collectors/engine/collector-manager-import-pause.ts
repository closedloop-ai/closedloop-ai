/**
 * @file collector-manager-import-pause.ts
 * @description Pause/resume gate for the long first-launch historical backfill,
 * extracted from collector-manager.ts (grandfathered shrink-only under the root
 * AGENTS.md line-count contract) alongside the sibling IngestProgressTracker and
 * BootImportLifecycle extractions.
 *
 * Behavior-preserving: the state is in-memory, so it resets on app restart and
 * is unaffected by window focus. While paused, the import loop awaits {@link
 * ImportPauseGate.wait}; `resume()` or the manager's `stop()` (via `resume()`)
 * releases every waiter. Only the historical (lowDuty) pass is pausable —
 * live-watcher imports are never paused.
 *
 * This gate stays the ONLY owner of the pause flag. ISS-4917's no-progress watch
 * deliberately does NOT read it: `pause()` flips the flag while a parse or DB
 * write is still in flight, so muting on the flag would hide a genuinely wedged
 * operation until it returned. The import loop instead tells the tracker when it
 * actually parks on {@link ImportPauseGate.wait} (wongk review, ISS-4917).
 */

export class ImportPauseGate {
  private paused = false;
  private parkedWaiters = 0;
  private gate: { promise: Promise<void>; resolve: () => void } | null = null;

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Whether the import loop has ACKNOWLEDGED the pause by actually parking on
   * {@link wait}, as opposed to `isPaused()`, which is true from the instant the
   * user asks. The two diverge for as long as the loop takes to reach its next
   * pause gate — during the first-launch source scan (`listSources` +
   * `loadExistingSessionIds` + `collectPendingSources` all run before the first
   * gate) that is the whole discovery pass. ISS-5115 (wongk review): the startup
   * panel reads this so it can say "Pausing" while work is still running and
   * only claim "paused" once it has genuinely stopped.
   *
   * Counted rather than derived from the gate promise, because `resume()` drops
   * the gate before its waiters have resumed.
   */
  isParked(): boolean {
    return this.parkedWaiters > 0;
  }

  pause(): void {
    this.paused = true;
  }

  /** Clear the pause and release every waiter. Idempotent. */
  resume(): void {
    this.paused = false;
    this.gate?.resolve();
    this.gate = null;
  }

  /**
   * Resolves immediately unless paused, in which case it awaits the next
   * `resume()`. Waiters share one gate promise.
   */
  wait(): Promise<void> {
    if (!this.paused) {
      return Promise.resolve();
    }
    if (!this.gate) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.gate = { promise, resolve };
    }
    this.parkedWaiters += 1;
    return this.gate.promise.finally(() => {
      this.parkedWaiters -= 1;
    });
  }
}
