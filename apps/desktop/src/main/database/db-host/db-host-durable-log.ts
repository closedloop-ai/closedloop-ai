/**
 * @file db-host-durable-log.ts
 * @description ISS-7882 — the DB-host child's end of the durable-log relay.
 *
 * `initializePersistentLogging` has exactly one production call site,
 * `startup.ts`, which runs only in the main process. This worker never calls it,
 * so every `writePersistentLog` line raised in here was taken by
 * `PreInitLogBuffer.capture` and never drained — `drain()` is reachable only
 * from the initializer — and past the 500-line cap was dropped outright. The
 * warnings that lane produces (the hydration planner's per-column sizing
 * degradations among them) therefore reached no file at all, while the call
 * sites' comments said they were "surfaced on the durable main-process log".
 *
 * The sink below is what makes that claim true: it posts the already-formatted
 * line to main, which appends it to `main.log` on this process's behalf. Same
 * shape as the ISS-7109 telemetry relay next door, and for the same reason —
 * main is the only side holding an initialised transport.
 *
 * It lives here rather than inline in `db-host-worker.ts` because that module
 * registers a `process.parentPort` listener at import and so can never be loaded
 * by a test. A relay whose only proof of correctness is that someone read the
 * worker is the same unverified claim this ticket is about.
 */

import type { DurableLogSink } from "../../logging/durable-log-sink.js";
import {
  type DbHostDurableLogResponse,
  DbHostResponseKind,
} from "./db-host-protocol.js";

export type DbHostDurableLogRelayDeps = {
  /** Posts to main. In the worker this is `process.parentPort.postMessage`. */
  post: (message: DbHostDurableLogResponse) => void;
};

/**
 * Build the sink this process installs with `routeDurableLogsToSink`.
 *
 * Never throws, and swallows the failure without a fallback local write. The
 * only remaining channel would be `childLog`, which posts down the SAME
 * parentPort that just failed; a durable log line must never become the failure
 * of the DB work that happened to raise it, and `persistent-log` already
 * promises that logging "must never affect Desktop control flow".
 */
export function createDbHostDurableLogRelay(
  deps: DbHostDurableLogRelayDeps
): DurableLogSink {
  return (level, line) => {
    try {
      deps.post({ kind: DbHostResponseKind.DurableLog, level, line });
    } catch {
      // The port is gone (shutdown teardown, a killed child). Nowhere left to
      // report to, and the caller must not learn about it.
    }
  };
}
