/**
 * @file agent-session-sync-tick-failure-log.ts
 * @description ISS-5262 — how the agent-session sync lane reports a tick that
 * did not finish, extracted out of the grandfathered
 * `agent-session-sync-service.ts` (over the 1,000-line ceiling) so the decision
 * lives in a directly unit-testable sibling instead of growing that file.
 *
 * The distinction it owns: `sync failed: db-host exited (code: 0)` used to land
 * immediately AFTER `shutdown sequence end: clean`, which made the shutdown
 * verdict a lie. The lane did not fail — the user quit while a db-host-backed
 * read was in flight. A graceful teardown is therefore reported as ABANDONMENT
 * at debug (verbose-only, so a normal quit is quiet but the reason is still
 * recoverable), while every genuine failure keeps its warn and its message.
 *
 * Nothing is swallowed. The durable outbox still holds the batch's rows — they
 * are cleared only on a verified ack — so an abandoned tick is retried on the
 * next launch rather than lost, and the outbox-clear failure itself
 * (`failed to clear N acked outbox row(s)`, in `agent-session-outbox-writers.ts`)
 * is deliberately NOT routed through here: an acked-but-uncleared row is durable
 * corruption risk and must stay a warning whatever the cause.
 */
import { isUnrecoverableDbHostExitError } from "../../shared/db-host-exit-error.js";
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  SyncCapabilityDowngrade,
  type SyncPreSendDeferral,
} from "./agent-session-sync-capabilities.js";

/** Report a sync tick and return whether it is a genuine failure. */
export function logSyncTickFailure(tag: string, error: unknown): boolean {
  if (isDbHostShutdownError(error)) {
    gatewayLog.debug(
      tag,
      "sync abandoned: db-host shutting down (retries on next launch)"
    );
    return false;
  }
  // ISS-8776: the db-host restart ladder has GIVEN UP, so every read this lane
  // attempts rejects identically on every tick for the rest of the session.
  // Same shape of answer as the shutdown arm above and for the same reason —
  // the lane did not fail, its store is gone, and the outbox still holds the
  // rows for the next launch. Nothing is swallowed: the terminal state is
  // reported ONCE on the monitored `desktop.db_host.restart_exhausted` event
  // and once to the user through the Agent Monitor notification. Re-warning
  // every 5 s would bury that single real signal under a repeat of itself.
  if (isUnrecoverableDbHostExitError(error)) {
    gatewayLog.debug(
      tag,
      "sync abandoned: db-host is unavailable and will not restart (retries on next launch)"
    );
    return false;
  }
  gatewayLog.warn(tag, `sync failed: ${errorMessage(error)}`);
  return true;
}

/**
 * ISS-4578: a FRESH batch was sized under the gzip cap, then the server
 * reconnected without gzip mid-tick. The send is skipped and the candidates
 * (never dequeued — only an ack advances them) re-prepare under identity
 * encoding next tick. Same family as the failure line above: what the lane says
 * about a tick that did not complete.
 */
export function logCompressionDowngradeDeferral(
  tag: string,
  sessionCount: number
): void {
  gatewayLog.info(
    tag,
    `deferring ${sessionCount} gzip-sized session(s) after sync compression capability downgrade mid-tick; ` +
      "re-preparing under identity encoding on the next tick"
  );
}

/**
 * ISS-4578: the activity-chunking twin of {@link logCompressionDowngradeDeferral}
 * — the socket reconnected to a server that REPLACE-ALLs the tiling, so sending
 * chunk 0 would leave it holding a partial tiling.
 */
export function logActivityChunkingDowngradeDeferral(
  tag: string,
  sessionCount: number
): void {
  gatewayLog.info(
    tag,
    `deferring ${sessionCount} activity-chunked session(s) after sync activity-chunking capability downgrade mid-tick; ` +
      "re-preparing with the tiling whole in the base on the next tick"
  );
}

/**
 * ISS-9859: the PR-ref twin of {@link logActivityChunkingDowngradeDeferral} —
 * the socket reconnected to a server that REPLACES a session's PR links with
 * whatever slice each part carries, so shipping the pinned parts would leave it
 * holding one slice instead of the whole set.
 */
export function logPrRefChunkingDowngradeDeferral(
  tag: string,
  sessionCount: number
): void {
  gatewayLog.info(
    tag,
    `deferring ${sessionCount} PR-ref-chunked session(s) after sync PR-ref-chunking capability downgrade mid-tick; ` +
      "re-preparing with the PR refs whole in the base on the next tick"
  );
}

/**
 * ISS-5850: the span-extent twin. The payload is fine either way — the extent is
 * additive and an older server just drops it — so what this names is the ACK
 * becoming worth less than the batch was prepared for: an ack from a server that
 * strips the extent would dequeue these rows under a watermark this lane may
 * already have stamped at the extent-bearing revision.
 */
export function logSpanExtentDowngradeDeferral(
  tag: string,
  sessionCount: number
): void {
  gatewayLog.info(
    tag,
    `deferring ${sessionCount} session(s) after the sync span-extent capability was downgraded mid-tick; ` +
      "re-preparing once the connected server's extent support is known"
  );
}

/**
 * Log the deferral for whichever capability went away.
 *
 * `MonitoredActivity` is deliberately SILENT and that silence is preserved, not
 * an oversight: it is a cursor-identity change rather than a payload the server
 * would reject, it flips on ordinary renegotiation, and the batch it defers is
 * re-prepared on the very next tick. The other five each name a tick whose
 * OUTCOME would have been wrong — a payload shaped for a server that is gone, or
 * (ISS-5850) an ack that no longer proves what the cursor would claim — which is
 * worth a line.
 */
function logSyncCapabilityDowngradeDeferral(
  tag: string,
  downgrade: SyncCapabilityDowngrade,
  sessionCount: number
): void {
  if (downgrade === SyncCapabilityDowngrade.Compression) {
    logCompressionDowngradeDeferral(tag, sessionCount);
    return;
  }
  if (downgrade === SyncCapabilityDowngrade.ActivityChunking) {
    logActivityChunkingDowngradeDeferral(tag, sessionCount);
    return;
  }
  if (downgrade === SyncCapabilityDowngrade.PrRefChunking) {
    logPrRefChunkingDowngradeDeferral(tag, sessionCount);
    return;
  }
  if (downgrade === SyncCapabilityDowngrade.SpanExtent) {
    logSpanExtentDowngradeDeferral(tag, sessionCount);
    return;
  }
  if (downgrade === SyncCapabilityDowngrade.TokenEventOwner) {
    gatewayLog.info(
      tag,
      `deferring ${sessionCount} session(s) after sync token-event-owner capability downgrade mid-tick; re-preparing without token-event owners on the next tick`
    );
  }
}

/**
 * ISS-7775: report a pre-send deferral, whichever dimension went stale.
 *
 * The level change IS logged, unlike the silent `MonitoredActivity` case above:
 * it is a user-initiated privacy choice taking effect on work already in flight,
 * so a reader diagnosing "why did this session not upload for a tick" should be
 * able to see the reason rather than infer it.
 */
export function logSyncPreSendDeferral(
  tag: string,
  deferral: SyncPreSendDeferral,
  sessionCount: number
): void {
  if (deferral.kind === "capability") {
    logSyncCapabilityDowngradeDeferral(tag, deferral.capability, sessionCount);
    return;
  }
  gatewayLog.info(
    tag,
    `deferring ${sessionCount} session(s): the data-sync level changed from ${deferral.captured} to ${deferral.current} while this batch was being prepared; re-preparing under the current level on the next tick`
  );
}
