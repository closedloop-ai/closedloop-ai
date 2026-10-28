/**
 * @file distribution-install-terminal-telemetry.ts
 * @description ISS-6170 — report that the required-plugin installer GAVE UP on a
 * cloud-assigned distribution, because this build can never install the pack it
 * names.
 *
 * ## Why a raw log is not enough
 *
 * Before the give-up landed, the only record was `gatewayLog.error`, repeated on
 * every reconcile. That reaches whoever is already sitting at that machine and
 * nobody else — the same argument `collector-records-dropped-telemetry.ts`
 * makes. The per-distribution `failed` the installer POSTs is real but is a
 * per-assignment field nobody alerts on, and the admin who pushed the pack is
 * the person who needs to know their team never received it. Silencing the
 * repeats without adding this would be worse than the noise: a permanently
 * skipped install that nothing counts is indistinguishable from one that
 * succeeded.
 *
 * ## Cadence
 *
 * NOT A RATE. This is a STATE — an install whose compiled-in catalog seed is
 * behind what its org distributes — so it latches to at most ONE event per
 * permanent error code per process, exactly like
 * `sync-lane-stall-clock-telemetry.ts`. Alert on PRESENCE.
 *
 * Content-free apart from that closed code: the pack id and the distribution id
 * are cloud-supplied strings and stay in the desktop-local log, where an
 * operator on that machine can act on them.
 */

import type { StreamRunErrorCode } from "../../shared/install-run-contract.js";
import { Observability } from "./observability.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";
import type { TelemetryTraceContext } from "./telemetry-protocol.js";

const GAVE_UP_MESSAGE =
  "The desktop installer gave up on a required distribution: it names a pack this build cannot install, so retrying can never succeed. This device will not converge until Closedloop Desktop is updated or the distribution is withdrawn.";

/**
 * Error codes already reported by this process. Bounded by construction — the
 * key space is `StreamRunErrorCode`, a closed six-member vocabulary, so it
 * cannot grow with the cloud-supplied pack ids that trigger it.
 */
const REPORTED_CODES = new Set<StreamRunErrorCode>();

/**
 * Report one permanent give-up, once per error code per process.
 *
 * Latches on ACCEPTANCE, not on the attempt: the lane drops silently when its
 * send gate is closed, so latching before the emit would let a give-up raised
 * during a disconnect burn the only report this process will ever make, and the
 * resulting silence reads as "every distribution here installed".
 */
export function reportDistributionInstallGaveUp(
  reason: StreamRunErrorCode
): void {
  if (REPORTED_CODES.has(reason)) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "distribution.install_gave_up",
    message: GAVE_UP_MESSAGE,
    trace,
    diagnostics: { distributionInstallGaveUp: { reason } },
  });
  if (canDeliverTelemetry()) {
    REPORTED_CODES.add(reason);
  }
}

/** Test seam: drop the per-process latch so cases cannot leak into each other. */
export function resetDistributionInstallGaveUpTelemetryForTests(): void {
  REPORTED_CODES.clear();
}
