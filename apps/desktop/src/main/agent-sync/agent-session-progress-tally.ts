import {
  buildAgentSessionSyncProgress,
  type SessionProgressInput,
} from "./agent-session-sync-progress-counts.js";
import type { AgentSessionSyncProgress } from "./agent-session-sync-service-options.js";

/**
 * ISS-7099: the session lane's progress counters, owned for the lifetime of ONE
 * source identity.
 *
 * Both numbers a progress surface divides by live here rather than in the
 * renderer, and that placement is the fix, not a detail. A component-held total
 * is reborn at zero on every mount, so a card remounted mid-sync would divide
 * the deliveries it inherited by a backlog it had never seen — 30 delivered with
 * the last 10 parked reads as a full bar. The lane already knows the whole
 * story and already resets exactly when the identity changes, so it is the only
 * honest owner.
 */
export class SessionProgressTally {
  /**
   * Sessions this identity has DELIVERED — counted only where the server
   * verified the ack and the durable outbox clear committed, the one place
   * delivery is proven. It cannot be derived from a fall in the owed count: a
   * backoff, a withhold and a dead-letter are all such falls, and crediting them
   * is what made the bar advance for work that never uploaded.
   */
  private delivered = 0;

  /**
   * The largest `delivered + ready` this identity has reached — the denominator.
   *
   * A high-water mark, because `ready` SHRINKS when work is deferred, and a
   * denominator that shrinks on a deferral both advances the bar for work that
   * did not upload and fills it the moment the whole remainder is parked. Work
   * once counted as in flight stays in the job while it waits.
   */
  private inFlightHighWater = 0;

  /**
   * ISS-12529: the session ids of the batch on the wire, set as `sendBatch`
   * starts and cleared when the pass settles. The progress snapshot counts the
   * ones still queued as `sendingSessions`.
   */
  private sendingIds: readonly string[] = [];

  /** ISS-12529: the batch now on the wire, or `[]` once the pass settles. */
  noteSending(ids: readonly string[]): void {
    this.sendingIds = ids;
  }

  /** Record a verified ack. The only way the numerator moves. */
  noteDelivered(count: number): void {
    this.delivered += count;
  }

  /** A new source identity owes its own history; it inherits no numbers. */
  reset(): void {
    this.delivered = 0;
    this.inFlightHighWater = 0;
    this.sendingIds = [];
  }

  /**
   * Fold this poll in and return the snapshot.
   *
   * The high-water is SNAPPED when the lane reports itself caught up, and that
   * is the one legitimate shrink: caught-up means the queues are empty, so work
   * still sitting in the total left without being delivered — withheld as idle,
   * or dead-lettered — and is no longer owed by anyone. Without the snap a lane
   * that withheld its only session would render "Sessions synced" above a bar
   * reading `0 / 1`.
   */
  sample(
    input: Omit<
      SessionProgressInput,
      "delivered" | "inFlightHighWater" | "sendingIds"
    >
  ): AgentSessionSyncProgress {
    const progress = buildAgentSessionSyncProgress({
      ...input,
      sendingIds: this.sendingIds,
      delivered: this.delivered,
      inFlightHighWater: this.inFlightHighWater,
    });
    this.inFlightHighWater = progress.inFlightTotalSessions ?? 0;
    return progress;
  }
}
