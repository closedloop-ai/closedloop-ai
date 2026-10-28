import { Observability } from "./observability.js";
import type {
  DbHostRejectedReplyOp,
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
 * literal.
 */
export const DB_HOST_REPLY_REJECTED_CATEGORY: TelemetryCategory =
  "desktop.db_host.reply_rejected";

/**
 * Report on the monitored path that main refused a db-host reply because it did
 * not match that op's boundary schema.
 *
 * Emits at most once per op per {@link DB_HOST_REPLY_REJECTION_THROTTLE_MS}, and
 * writes nothing locally — see this file's Cadence section for what that costs
 * and why the window is keyed by op alone.
 *
 * Never throws and returns nothing: this is called from inside a degradation
 * path that must complete. A reporter that could take down its caller would turn
 * a graceful degradation back into the crash the boundary schema exists to
 * prevent.
 */
export function reportRejectedDbHostReply(input: {
  op: DbHostRejectedReplyOp;
}): void {
  const { op } = input;
  if (!claimMonitoredRejectionSlot(op)) {
    return;
  }
  const message = `db-host reply boundary: refused the child's reply to ${op} because it did not match this build's schema for that op; the caller degraded to its "not established" answer`;
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: DB_HOST_REPLY_REJECTED_CATEGORY,
    message,
    trace,
    diagnostics: { dbHostReplyRejected: { op } },
  });
}

/**
 * How long one op stays quiet on the monitored path after it has been reported.
 *
 * Short enough that a wedge stays visible as a live, recurring signal rather
 * than a single event an operator has to have been watching for; long enough
 * that a 5s sync tick cannot turn one fault into the whole facet.
 */
export const DB_HOST_REPLY_REJECTION_THROTTLE_MS = 5 * 60 * 1000;

/** Last monitored emit per op. Bounded by the op enum — see the Cadence section. */
const lastMonitoredRejectionMsByOp = new Map<DbHostRejectedReplyOp, number>();

/**
 * May this op emit on the monitored path now? Records the claim when it may.
 *
 * A negative elapsed — the wall clock moved backwards — emits rather than
 * suppresses: a clock jump must not be able to silence a wedge for the length
 * of the jump.
 */
function claimMonitoredRejectionSlot(op: DbHostRejectedReplyOp): boolean {
  const nowMs = Date.now();
  const lastMs = lastMonitoredRejectionMsByOp.get(op);
  if (lastMs !== undefined) {
    const elapsedMs = nowMs - lastMs;
    if (elapsedMs >= 0 && elapsedMs < DB_HOST_REPLY_REJECTION_THROTTLE_MS) {
      return false;
    }
  }
  lastMonitoredRejectionMsByOp.set(op, nowMs);
  return true;
}

/**
 * Clear the per-op throttle.
 *
 * The throttle is module-level state that outlives any one test, so a suite
 * asserting a SECOND rejection of the same op reads the first case's claim
 * unless it clears this in `beforeEach` — the shape root AGENTS.md names as a
 * test that passes in file order and fails run alone.
 *
 * Deliberately NOT folded into `Observability.reset()`, which clears the
 * TRANSPORT's own cadence latches: this window belongs to the reporter that
 * decides the cadence, and `observability.ts` cannot reach it without importing
 * the module that imports it. The sibling `sync-freshness-lag-telemetry.ts` keeps
 * `REPORTED_ANOMALIES` outside that chokepoint the same way, and exports no reset
 * at all.
 */
export function resetDbHostReplyRejectionThrottle(): void {
  lastMonitoredRejectionMsByOp.clear();
}
