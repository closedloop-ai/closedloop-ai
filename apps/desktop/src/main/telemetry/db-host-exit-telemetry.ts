/**
 * @file db-host-exit-telemetry.ts
 * @description ISS-5715 — the ALERTABLE signal for an UNEXPECTED db-host exit.
 *
 * The db-host utility process going away takes ingestion (the collector live
 * import, transcript sync) and the Sessions read path down together, and only
 * the read half is visible to a user. So the exit cannot be reported by a local
 * `onLog` line alone: that never leaves the machine, and ingestion stopping is
 * exactly the failure nobody would notice.
 *
 * SCOPE — WHAT THIS DOES NOT DO. Emitting here does not, by itself, page
 * anyone. The event travels desktop → gateway → `apps/api`
 * `handleTelemetryEvent`, which logs EVERY desktop telemetry event at
 * `log.info` regardless of `severity` — the severity below is a queryable
 * FIELD, not a log level, and no monitor keys on it. What this module buys is
 * that the exit becomes a first-class, bounded-cardinality Datadog facet
 * (`@category:desktop.db_host.exited_unexpectedly`, plus
 * `@diagnostics.dbHostExit.*`) on `service:cl-api`, which is the precondition
 * for an alert. The alert ITSELF is a `datadog_monitor` resource and monitors
 * live in `closedloop-ai/cl-tofu-aws-live`, not in this repo — see
 * `_modules/datadog/monitors/token-cost-pricing-miss-*.tf` for the same
 * desktop-telemetry-category pattern. Until that companion monitor lands this
 * signal is QUERYABLE but not PAGING; it is tracked as the follow-up on
 * ISS-5715 and called out in the PR body rather than implied to be done here.
 *
 * It lives beside `observability.ts` rather than inside it because that file is
 * at the 1,000 logical-line ceiling — a per-concern telemetry module is the
 * pattern the repo already uses for `loop-perf-telemetry.ts`. It emits through
 * `Observability.getTelemetryEmitter()`, so it shares the one transport and
 * inherits the same trace/envelope enrichment as every other event.
 *
 * Only the restart branch of `DbHostClient.handleExit` reaches here. An exit
 * inside the intentional-teardown window (ISS-4713) is expected and must stay
 * off this channel, or every quit would raise an alert.
 */

import { Observability } from "./observability.js";
import type { DbHostExitDiagnostics } from "./telemetry-protocol.js";

/**
 * Category for an unexpected db-host exit. Mirrors the shared telemetry schema,
 * and is the exact string a companion Datadog monitor must query as
 * `@category`.
 */
const DB_HOST_EXITED_UNEXPECTEDLY_CATEGORY =
  "desktop.db_host.exited_unexpectedly" as const;

/**
 * Report an unexpected db-host exit on the telemetry path.
 *
 * `input.exitCode` rides along but must not be read as a cause: Electron
 * reports `0` on the utility-process `exit` event whenever the mojo pipe
 * disconnects before the platform termination status is available
 * (electron/electron#42283), so a crashed host and a clean one are
 * indistinguishable from the code. The event's EXISTENCE is the signal;
 * `rejectedOps` is its blast radius.
 */
export function reportDbHostExitedUnexpectedly(
  input: DbHostExitDiagnostics
): void {
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: DB_HOST_EXITED_UNEXPECTEDLY_CATEGORY,
    message: "Desktop db-host exited unexpectedly",
    trace: {},
    diagnostics: { dbHostExit: input },
  });
}
