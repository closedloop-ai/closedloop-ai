/**
 * @file connection-lifecycle-reporter.ts
 * @description ISS-7710: owns everything observability does with a cloud-socket
 * connection, and emits the connect-time events on the OPEN side of the
 * observability send gate.
 *
 * `CloudSocketService` dispatches `onHelloAck` and only THEN calls
 * `notifyStatus({ state: "online" })`. That order is load-bearing for the
 * gateway — the online branch consumes the session-sync capabilities the ack
 * handler sets — so it is not the thing to change. But
 * `observability-lane-router` gates every analytics AND telemetry send on the
 * APPLIED online status, so anything emitted from inside `onHelloAck` is
 * evaluated while the app still believes it is offline and is silently dropped.
 * That is why every `desktop_connection_established` /
 * `desktop_reconnection_resumed` vanished from PostHog while
 * `agent_session_sync_batch_failed`, emitted later in steady state with the gate
 * open, kept flowing from the same clients. So the ack's facts are latched here
 * and reported from the applied online status, without reordering the handshake.
 *
 * ISS-8687: `reportLost` / `reportDegraded` ARE delivered now. They were not
 * when this file was written — the same gate dropped any send made while the
 * app was not online, which by definition it is not when the link is down, so
 * the two events describing a lost connection were the two the transport could
 * never carry. Their analytics half now resolves the RETAINED compute-target
 * identity instead (`offline-deliverable-analytics-events.ts`), which is a
 * scoped exemption for this family and not a general loosening of the gate.
 *
 * The DIAGNOSTICS half is still strict-online and still dropped while offline.
 * That is deliberate: the relay logs every teardown with its reason server-side,
 * so Datadog is not blind to disconnect causes the way PostHog was.
 *
 * Delivering `reportDegraded` is what makes its CADENCE matter. Nothing upstream
 * dedupes it — `notifyStatus` forwards, `onCloudSocketStatus` has no same-status
 * guard — so every failed reconnect re-reports the same degradation: three at
 * ~1s, then one per minute once `CONNECT_ERROR_BACKOFF_THRESHOLD` trips. Undelivered
 * that was harmless; delivered it would make the event a count of retry ticks
 * rather than of degradations (~480 per client per 8-hour relay outage, all
 * carrying one unbounded `error` string that grouping cannot rescue). So the
 * cause is latched here, at the one place every emit routes through.
 */
import { Observability } from "../telemetry/observability.js";
import type { DesktopHelloAckEvent } from "./cloud-protocol.js";

/** Matches the socket path's hello-derived reason for a replayed reconnect. */
const RELAY_RESUMED_REASON = "relay_resumed";

export type ConnectionLifecycleReporter = {
  /** Call from `onHelloAck`, the only callback holding the ack payload. */
  recordHelloAck(event: DesktopHelloAckEvent): void;
  /** Call from the applied-online-status branch, after the send gate opens. */
  reportOnline(computeTargetId: string): void;
  reportLost(reason?: string): void;
  /**
   * Report one degradation. Idempotent per cause until the next `reportOnline`,
   * so callers on a retry loop need no guard of their own.
   */
  reportDegraded(error: string): void;
};

export function createConnectionLifecycleReporter(): ConnectionLifecycleReporter {
  let pendingReplayCommandCount: number | null = null;
  let reportedDegradedError: string | null = null;

  return {
    recordHelloAck(event) {
      Observability.setTargetId(event.computeTargetId);
      if (event.sessionId) {
        Observability.setGatewaySessionId(event.sessionId);
      }
      // Always assigned, never only-on-resume: an ack carrying no resume must
      // CLEAR a count latched by an earlier ack that never reached an online
      // status, or that stale number is reported against this connection.
      pendingReplayCommandCount = event.resumeFromSequence
        ? Object.keys(event.resumeFromSequence).length
        : null;
    },
    reportOnline(computeTargetId) {
      // Recovery ends the degradation episode, so the next one reports even if
      // it fails for the same cause. Cleared here and nowhere else: a `lost`
      // belongs to the episode already in progress, not to a new one.
      reportedDegradedError = null;
      // Consume, so a second report for the same ack cannot claim the replay
      // twice. `recordHelloAck` is the only writer, and it fully determines the
      // latch on every ack, so nothing else needs to clear it.
      const replayCommandCount = pendingReplayCommandCount;
      pendingReplayCommandCount = null;
      if (replayCommandCount !== null) {
        Observability.reconnectionResumed(
          RELAY_RESUMED_REASON,
          replayCommandCount
        );
      }
      Observability.connectionEstablished(
        computeTargetId,
        process.env.NODE_ENV ?? "production"
      );
    },
    reportLost(reason) {
      Observability.connectionLost(reason);
    },
    reportDegraded(error) {
      // Keyed on the cause, not on a bare "already degraded" flag: a CHANGED
      // cause is a different degradation and reports immediately, which is what
      // keeps the bound from hiding a failure mode that moved mid-episode. Only
      // an immediate repeat of the same cause is suppressed, so an episode that
      // alternates between two causes still reports each alternation.
      if (error === reportedDegradedError) {
        return;
      }
      reportedDegradedError = error;
      Observability.connectionDegraded(error);
    },
  };
}
