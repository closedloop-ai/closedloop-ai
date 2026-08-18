/**
 * ISS-4758: the timer mechanics behind the desktop sync lanes' background poll,
 * split out of the (shrink-only, grandfathered) `agent-session-sync-service.ts`
 * so the scheduling concern — and the `unref` discipline in particular — lives
 * in exactly one place instead of being restated at each `setInterval` /
 * `setTimeout` site.
 *
 * ## Why every handle here is `unref`'d
 *
 * A background poll must never be the reason a process stays alive. Owners
 * still call {@link SyncPollTimers.clearAll} from their `stop()`; `unref` only
 * removes the handle's hold on the event loop. That turns a missed `stop()`
 * from an unkillable process into an ordinary visible failure — which is the
 * whole ISS-4758 outage: an assertion threw between `start()` and `stop()` in a
 * test, stranding a referenced 5s interval, and because `node --test` bounds a
 * TEST but never a test FILE's process, the run hung until the 30-minute CI cap
 * cancelled it with no summary and no JUnit upload.
 *
 * In production these services run in the Electron main process, whose loop
 * Electron's own handles keep alive, so polling cadence is unaffected.
 */
export class SyncPollTimers {
  private poll: NodeJS.Timeout | null = null;
  private drain: NodeJS.Timeout | null = null;

  /** Arm the repeating poll. No-op when already armed, so callers stay idempotent. */
  startPoll(intervalMs: number, onTick: () => void): void {
    if (this.poll) {
      return;
    }
    this.poll = setInterval(onTick, intervalMs);
    this.poll.unref();
  }

  stopPoll(): void {
    if (!this.poll) {
      return;
    }
    clearInterval(this.poll);
    this.poll = null;
  }

  /** True while a self-continue drain is already queued (callers coalesce on this). */
  get drainScheduled(): boolean {
    return this.drain !== null;
  }

  /**
   * Queue a single immediate follow-up tick. Coalesced: a second call while one
   * is pending is a no-op, so a caller cannot stack drains.
   */
  scheduleDrain(onDrain: () => void): void {
    if (this.drain) {
      return;
    }
    this.drain = setTimeout(() => {
      this.drain = null;
      onDrain();
    }, 0);
    this.drain.unref();
  }

  clearDrain(): void {
    if (!this.drain) {
      return;
    }
    clearTimeout(this.drain);
    this.drain = null;
  }

  clearAll(): void {
    this.stopPoll();
    this.clearDrain();
  }
}
