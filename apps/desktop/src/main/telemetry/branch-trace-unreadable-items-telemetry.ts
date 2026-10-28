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
 * literal, so a rename moves the producer and its assertion together. Same
 * pattern as `MALFORMED_OUTBOX_CLEAR_COUNT_CATEGORY`.
 */
export const BRANCH_TRACE_ITEMS_UNREADABLE_CATEGORY: TelemetryCategory =
  "branch_trace.items_unreadable";

/**
 * Fixed and content-free, for the reason the module docstring gives: no branch
 * id, session id, or count is interpolated.
 */
const BRANCH_TRACE_ITEMS_UNREADABLE_MESSAGE =
  "A locally synchronized Session produced trace items the merged-trace contract refused, so the served branch trace is a subset of what was built. Suspect a local collector or projection writing an unparseable extent; the branch and Session are visible in the desktop UI's own drop count.";

/** Whether this process has already reported. Bounded by construction: one bit. */
let reported = false;

/**
 * Report, once per process, that a branch trace dropped items it could not
 * parse.
 *
 * A zero is not reportable and never emitted: the caller tallies inside the
 * branch where the drop actually happened, and a reporter that fired on an empty
 * partition would alert on every healthy read.
 *
 * Latches on ACCEPTANCE, not on the attempt: the lane drops silently when its
 * send gate is closed, so latching before the emit would let a report raised
 * during a disconnect burn the only one this process will ever make, and the
 * resulting silence reads as "the traces here parse".
 */
export function reportBranchTraceItemsUnreadable(
  unreadableSessionCount: number
): void {
  if (unreadableSessionCount <= 0 || reported) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: BRANCH_TRACE_ITEMS_UNREADABLE_CATEGORY,
    message: BRANCH_TRACE_ITEMS_UNREADABLE_MESSAGE,
    trace,
  });
  if (canDeliverTelemetry()) {
    reported = true;
  }
}

/**
 * Exported for tests, which need the latch cleared between cases. Production has
 * no caller: the latch is per-process by design, and a reset reachable from the
 * app would be a way to turn one defect into the flood the cadence prevents.
 */
export function resetBranchTraceItemsUnreadableReport(): void {
  reported = false;
}
