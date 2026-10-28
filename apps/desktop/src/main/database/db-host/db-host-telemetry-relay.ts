/**
 * @file db-host-telemetry-relay.ts
 * @description ISS-7109 — the DB-host child's end of the telemetry relay.
 *
 * `Observability.init` runs in exactly one place, the main-process composition
 * root. This worker never calls it, so `Observability.telemetry` is null in here
 * and `telemetry?.emit(event)` returns having sent nothing. Every
 * `collector.records_dropped` event ISS-6417 raised from the live hook — which
 * runs in this process — was discarded that way, under a call-site comment
 * asserting the drop was monitored.
 *
 * The sink below is what makes the claim true: it posts the event to main, which
 * emits it on this process's behalf. Main is the only side with a transport, an
 * endpoint, and credentials, which is also why `reportDbHostExitedUnexpectedly`
 * is emitted by main watching the child rather than by the child itself.
 *
 * It lives here rather than inline in `db-host-worker.ts` because that module
 * registers a `process.parentPort` listener at import and so can never be loaded
 * by a test. A relay whose only proof of correctness is that someone read the
 * worker is the same kind of unverified claim this ticket is about.
 */

import type { TelemetryRelaySink } from "../../telemetry/telemetry-relay-sink.js";
import {
  DbHostResponseKind,
  type DbHostTelemetryResponse,
} from "./db-host-protocol.js";

export type DbHostTelemetryRelayDeps = {
  /** Posts to main. In the worker this is `process.parentPort.postMessage`. */
  post: (message: DbHostTelemetryResponse) => void;
  /** The child's local log line, forwarded to main's logger as a `Log` response. */
  log: (message: string) => void;
};

/**
 * Build the sink this process installs with `setTelemetryRelaySink`.
 *
 * Never throws. Callers emit telemetry as fire-and-forget from the middle of
 * unrelated DB work, so a transport failure here must not become that work's
 * failure — but it must not be silent either, so a failed post is stated on the
 * local log. Structured clone is the realistic failure: `diagnostics.extra` is a
 * `Record<string, unknown>`, so a caller can reach a non-cloneable value into an
 * event, and `postMessage` throws on it (the same hazard `DbHostDataCloneError`
 * handles for the main → child direction).
 */
export function createDbHostTelemetryRelaySink(
  deps: DbHostTelemetryRelayDeps
): TelemetryRelaySink {
  return (event) => {
    try {
      deps.post({ kind: DbHostResponseKind.Telemetry, event });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        deps.log(
          `db-host telemetry relay: could not post a ${event.category} event to main (${detail})`
        );
      } catch {
        // The reporting channel IS the channel that just failed: `log` is
        // `childLog`, which posts a `Log` response down the same parentPort. If
        // the port is gone (shutdown teardown, a killed child) the recovery
        // throws too, and letting THAT escape would be the worse bug by far —
        // this runs after the hook's transaction has already committed, so the
        // exception would surface a durably-written hook as a failed op. There
        // is nowhere left to report to; losing the telemetry is the correct
        // remaining outcome.
      }
    }
  };
}
