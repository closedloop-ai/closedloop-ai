/**
 * @file local-read-failed-telemetry.ts
 * @description ISS-11351 — report that a local durable read the desktop depends
 * on FAILED, on the monitored telemetry path.
 *
 * Every read this covers already degrades safely: the Sessions aggregates reject
 * with a sanitized "unavailable" (ISS-10573 / ISS-10606), and the component lane
 * skips the tick and retries (ISS-10910). That is exactly why they need this —
 * the only record of the failure was a line in the machine's own log, and a raw
 * log is not an alert (root `AGENTS.md`, "Handling Bad or Nonsensical Data").
 *
 * ## What does not report
 * A cancellation (ISS-9802) is the caller's own abort, and a db-host lifecycle
 * failure — a restart in flight or an app shutdown — is transient and heals on
 * its own. So does a store-op deadline (ISS-8773): nothing exited and it is a
 * function of load, so a busy backfill must not spend a read's once-per-process
 * report and leave a later real failure on that read unreported. All are
 * positively classified here, so every call site gets the same answer from one
 * predicate.
 *
 * ## Cadence: PRESENCE, once per read per main process
 * Both families sit on a polled or ticking path, so a store that stays broken
 * would otherwise emit on every poll. The condition is a STATE of the install,
 * so it latches like `branch-trace-unreadable-items-telemetry.ts`: at most one
 * event per read, latched on ACCEPTANCE by main's send gate so a report raised
 * while that gate is closed is not spent. Alert on presence; a rate monitor over
 * this category is unsound.
 *
 * The two aggregates run in the db-host child, whose relay to main always
 * "accepts" while main's lane may still drop the event (no socket identity yet,
 * or signed out). So the child never latches: it forwards every failure, and
 * main latches in {@link relayLocalReadFailed}.
 */

import { isDbHostShutdownError } from "../../shared/db-host-shutdown-error.js";
import { isDbStoreOpDeadlineError } from "../../shared/db-store-op-deadline-error.js";
import { isReadCancelledError } from "../../shared/read-cancellation-contract.js";
import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import { buildDesktopClientVersionTrace } from "./desktop-client-version.js";
import type { LocalReadFailedRead } from "./local-read-failed-diagnostics.js";
import { Observability } from "./observability.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";
import type {
  TelemetryCategory,
  TelemetryEventPayload,
} from "./telemetry-protocol.js";
import { getTelemetryRelaySink } from "./telemetry-relay-sink.js";

/**
 * The category as a runtime value. Desktop spells {@link TelemetryCategory} as a
 * string union with no runtime const, so the annotation is the drift guard, and
 * tests import this rather than re-typing the literal.
 */
export const LOCAL_READ_FAILED_CATEGORY: TelemetryCategory =
  "desktop.local_read.failed";

/** Fixed and content-free: the driver error stays in the desktop-local log. */
const LOCAL_READ_FAILED_MESSAGE =
  "A local SQLite read the desktop depends on failed for a reason other than a cancellation or a db-host restart. The read degraded safely; the driver error is in the desktop-local log.";

const reported = new Set<LocalReadFailedRead>();

/**
 * Report that `read` failed with `error`, at most once per read per main
 * process. Returns without emitting for a cancellation, a db-host lifecycle
 * failure or a store-op deadline.
 */
export function reportLocalReadFailed(
  read: LocalReadFailedRead,
  error: unknown
): void {
  if (
    isReadCancelledError(error) ||
    isTransientDbHostError(error) ||
    isDbHostShutdownError(error) ||
    isDbStoreOpDeadlineError(error)
  ) {
    return;
  }
  emitOncePerRead(read, {
    severity: "error",
    category: LOCAL_READ_FAILED_CATEGORY,
    message: LOCAL_READ_FAILED_MESSAGE,
    trace: buildDesktopClientVersionTrace(),
    diagnostics: { localReadFailed: { read } },
  });
}

/**
 * Main's half of a report the db-host child relayed: stamp main's version (the
 * child never receives one) and apply the latch the child cannot. An event with
 * no `read` is forwarded unlatched rather than dropped.
 */
export function relayLocalReadFailed(event: TelemetryEventPayload): void {
  const stamped: TelemetryEventPayload = {
    ...event,
    trace: { ...event.trace, ...buildDesktopClientVersionTrace() },
  };
  const read = event.diagnostics?.localReadFailed?.read;
  if (read === undefined) {
    Observability.getTelemetryEmitter().emit(stamped);
    return;
  }
  emitOncePerRead(read, stamped);
}

/** Tests only: the latch is per-process by design and production never resets it. */
export function resetLocalReadFailedReports(): void {
  reported.clear();
}

/** Latches only where the send gate is main's own; see the module docstring. */
function emitOncePerRead(
  read: LocalReadFailedRead,
  event: TelemetryEventPayload
): void {
  if (reported.has(read)) {
    return;
  }
  Observability.getTelemetryEmitter().emit(event);
  if (getTelemetryRelaySink() === null && canDeliverTelemetry()) {
    reported.add(read);
  }
}
