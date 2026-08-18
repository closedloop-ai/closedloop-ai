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
import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/** Report a sync tick that ended in `error`, under the lane's `tag`. */
export function logSyncTickFailure(tag: string, error: unknown): void {
  if (isDbHostShutdownError(error)) {
    gatewayLog.debug(
      tag,
      "sync abandoned: db-host shutting down (retries on next launch)"
    );
    return;
  }
  gatewayLog.warn(tag, `sync failed: ${errorMessage(error)}`);
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
