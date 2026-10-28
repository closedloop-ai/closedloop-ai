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
 * ISS-8776 — category for a db-host restart ladder that GAVE UP.
 *
 * Strictly rarer and strictly worse than the exit above: that one says a
 * replacement is coming, this one says none is. It is a separate `@category`
 * rather than a field on the exit event because a monitor on "the store is
 * permanently gone in a shipped app" must not be diluted by the ordinary
 * bounce, which is common and self-healing.
 *
 * The DIAGNOSTICS payload is deliberately the same `dbHostExit` shape. The wire
 * schema (`packages/observability/telemetry/schema.ts`) strips diagnostics keys
 * it has not been taught, so a fresh key would have validated away to nothing
 * until a companion change landed in that package — the exact silent-drop class
 * the strict-boundary lesson names. Every field it carries is meaningful here.
 */
const DB_HOST_RESTART_EXHAUSTED_CATEGORY =
  "desktop.db_host.restart_exhausted" as const;

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

export function reportDbHostRestartExhausted(
  input: DbHostExitDiagnostics
): void {
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: DB_HOST_RESTART_EXHAUSTED_CATEGORY,
    message: "Desktop db-host restart ladder exhausted",
    trace: {},
    diagnostics: { dbHostExit: input },
  });
}
