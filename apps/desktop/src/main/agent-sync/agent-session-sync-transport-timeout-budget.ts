/**
 * @file agent-session-sync-transport-timeout-budget.ts
 * @description ISS-5088: the session lane's budget for the one failure class it
 * cannot classify at the moment it happens — a CLIENT-side request abort
 * (`transport_timeout`), where the local deadline fired and the server never
 * answered.
 *
 * That abort is LANE-WIDE when the machine's network stalled (the production
 * ISS-5088 windows show the session lane, the component lane, and the relay
 * socket's ping all timing out together), and ROW-ATTRIBUTABLE when one batch
 * genuinely cannot be delivered inside the deadline. `main/sync/AGENTS.md`
 * invariant 4 forbids the first from burning a row's budget; invariant 5 requires
 * the second to reach a terminal path. The lane cannot tell them apart when the
 * abort lands, so this budget resolves it from BOTH directions instead of
 * guessing:
 *
 * - **Suppress (level-triggered).** While the lane has observed connectivity
 *   loss with no verified ack since, {@link TransportTimeoutBudget.foldPolicy}
 *   returns `countsToward: false` and the fold defers with every budget intact
 *   rather than counting.
 * - **Refund (edge-triggered).** {@link noteLoss} hands back every charge taken
 *   BEFORE the loss was observed.
 *
 * Both halves are needed because the two events race: a relay ping timeout is
 * detected on socket.io's own schedule while the abort fires a fixed
 * `AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS` after ITS send, so a charge lands on
 * either side of the loss depending on where in the ping window the blackout
 * started.
 *
 * A server-answered HTTP 408 (`ack_timeout`) is NOT ambiguous and is deliberately
 * NOT tracked here — it keeps its ordinary row-attributable budget.
 */

import type { BoundedFailureFoldConfig } from "./agent-session-sync-ack-fold.js";
import {
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
  TRANSPORT_TIMEOUT_BACKOFF_MS,
} from "./agent-session-sync-backoff-policy.js";

/** The policy half of a `transport_timeout` bounded-failure fold. */
export type TransportTimeoutFoldPolicy = Omit<
  BoundedFailureFoldConfig,
  "ids" | "syncMode" | "payloadBytes"
>;

export class TransportTimeoutBudget {
  /** Consecutive client-abort count per session id. */
  private readonly countById = new Map<string, number>();
  private lossSinceLastAck = false;

  /**
   * The fold policy for one `transport_timeout` ack. `countsToward` is false
   * inside a known outage, which is what keeps a lane-wide stall off the row's
   * budget; outside one the charge lands and is bounded by
   * `MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS`.
   */
  foldPolicy(): TransportTimeoutFoldPolicy {
    const suppressed = this.lossSinceLastAck;
    return {
      counter: this.countById,
      maxConsecutive: MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
      reason: "transport_timeout",
      recoverable: true,
      backoffMs: TRANSPORT_TIMEOUT_BACKOFF_MS,
      recordOutboxOnDefer: false,
      countsToward: !suppressed,
      deferLabel: suppressed
        ? "transport_timeout (client abort during a known connectivity loss)"
        : "transport_timeout",
    };
  }

  /**
   * Record unambiguous connectivity loss and refund every charge taken before it
   * was observed. Reports through `log` only when something was actually
   * refunded, so a quiet offline period does not spam the gateway log.
   */
  noteLoss(cause: string, log: (message: string) => void): void {
    this.lossSinceLastAck = true;
    const refunded = this.countById.size;
    if (refunded === 0) {
      return;
    }
    this.countById.clear();
    log(
      `refunded the transport_timeout retry budget for ${refunded} session(s) after ${cause}; ` +
        "those client-side request aborts were lane-wide, so they must not count toward a dead-letter"
    );
  }

  /**
   * A verified server ack is the only real proof the transport recovered, so it
   * is what re-arms the budget after an outage.
   */
  noteVerifiedAck(): void {
    this.lossSinceLastAck = false;
  }

  /** Drop one session's charge (dead-letter, recovery, or verified ack). */
  clearFor(id: string): void {
    this.countById.delete(id);
  }

  /** Drop everything on an identity change or hard reset. */
  clearAll(): void {
    this.countById.clear();
    this.lossSinceLastAck = false;
  }
}
