/**
 * Shared dispatch-failure classification helpers.
 *
 * Used by launch-plan-loop and launch-bootstrap-loop to classify relay
 * dispatch errors into actionable error codes for the route layer.
 */

import { log } from "@repo/observability/log";
import { isDispatchError } from "./loop-desktop";
import { launchLoop } from "./loop-orchestrator";

export type DispatchErrorCode = "callback_unavailable" | "launch_failed";

export const CALLBACK_UNAVAILABLE_DISPATCH_REASONS = new Set([
  "callback_unavailable",
  "callback_unreachable",
  "cloud_callback_unavailable",
  "cloud_callback_unreachable",
]);

export function isCallbackUnavailableDispatchReason(
  reason: string | undefined
): boolean {
  if (!reason || typeof reason !== "string") {
    return false;
  }
  const normalizedReason = reason.trim().toLowerCase();
  if (CALLBACK_UNAVAILABLE_DISPATCH_REASONS.has(normalizedReason)) {
    return true;
  }
  return (
    normalizedReason.includes("callback") &&
    (normalizedReason.includes("unavailable") ||
      normalizedReason.includes("unreachable") ||
      normalizedReason.includes("not_reachable") ||
      normalizedReason.includes("not reachable"))
  );
}

export function classifyLaunchFailure(error: unknown): DispatchErrorCode {
  // Backward compatibility: older desktop/relay versions may not provide a
  // structured dispatchReason. In that case, degrade to generic launch_failed
  // instead of requiring a matched desktop rollout.
  if (
    isDispatchError(error) &&
    isCallbackUnavailableDispatchReason(error.dispatchReason)
  ) {
    return "callback_unavailable";
  }
  return "launch_failed";
}

export type DispatchAndClassifyResult =
  | { ok: true }
  | { ok: false; error: DispatchErrorCode };

export async function dispatchAndClassify(
  loopId: string,
  organizationId: string,
  logPrefix: string,
  extraLogFields?: Record<string, unknown>
): Promise<DispatchAndClassifyResult> {
  try {
    await launchLoop(loopId, organizationId);
    return { ok: true };
  } catch (error) {
    const launchError = classifyLaunchFailure(error);
    log.error(`[${logPrefix}] Failed to launch loop`, {
      loopId,
      error: error instanceof Error ? error.message : String(error),
      dispatchReason:
        isDispatchError(error) && error.dispatchReason
          ? error.dispatchReason
          : undefined,
      launchError,
      ...extraLogFields,
    });
    return { ok: false, error: launchError };
  }
}
