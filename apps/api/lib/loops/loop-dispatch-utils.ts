/**
 * Shared dispatch-failure classification helpers.
 *
 * Used by launch-plan-loop and launch-bootstrap-loop to classify relay
 * dispatch errors into actionable error codes for the route layer.
 */

import { isDispatchError } from "./loop-desktop";

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

export function classifyLaunchFailure(
  error: unknown
): "callback_unavailable" | "launch_failed" {
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
