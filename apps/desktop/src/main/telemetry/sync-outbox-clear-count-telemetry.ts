import { Observability } from "./observability.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";
import type {
  TelemetryCategory,
  TelemetryTraceContext,
} from "./telemetry-protocol.js";

/**
 * The category this reporter emits, as a runtime value.
 *
 * Desktop spells {@link TelemetryCategory} as a string union with no runtime
 * const, so this is the single owner on this side and the annotation is the
 * drift guard: renaming the union member fails `tsc` here rather than shipping a
 * category no monitor is querying. Tests import THIS rather than re-typing the
 * literal — otherwise a rename leaves the test asserting the old name while the
 * producer emits another valid one, and the alert-wiring test stays green while
 * proving nothing. Same pattern as
 * `DB_HOST_TELEMETRY_REFUSED_CATEGORY`.
 */
export const MALFORMED_OUTBOX_CLEAR_COUNT_CATEGORY: TelemetryCategory =
  "sync.outbox_clear_count.invalid";

/**
 * Fixed and content-free: no `sourceKey`, session id, or offending value is
 * interpolated. Those stay in the desktop-local log, where an operator can open
 * the store.
 */
const MALFORMED_CLEAR_COUNT_MESSAGE =
  "A durable agent-session outbox clear reported a deletedRowCount its own boundary schema rejects, so the rows-cleared burn-down count was omitted for reasons that are not version skew. Suspect db-host IPC corruption or a producer defect; the sourceKey and acked-id count are in the desktop-local log.";

/** Whether this process has already reported. Bounded by construction: one bit. */
let reported = false;

/**
 * Report one unbelievable durable-clear count, once per process.
 *
 * Latches on ACCEPTANCE, not on the attempt: the lane drops silently when its
 * send gate is closed, so latching before the emit would let a report raised
 * during a disconnect burn the only one this process will ever make, and the
 * resulting silence reads as "the clear counts here are sound".
 */
export function reportMalformedOutboxClearCount(): void {
  if (reported) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: MALFORMED_OUTBOX_CLEAR_COUNT_CATEGORY,
    message: MALFORMED_CLEAR_COUNT_MESSAGE,
    trace,
  });
  if (canDeliverTelemetry()) {
    reported = true;
  }
}
