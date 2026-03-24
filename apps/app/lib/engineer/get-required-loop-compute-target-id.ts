import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { log } from "@repo/observability/log";
import { getEngineerRoutingSelection } from "@/lib/engineer/routing-store";

/**
 * Resolves the compute target ID required for Start Planning (desktop-only flow).
 *
 * Returns a result type (not throwing) so callers can show actionable UI errors.
 * LocalElectron and CloudRelay modes both require a compute target ID for loop dispatch.
 */
export function getRequiredLoopComputeTargetId():
  | { ok: true; computeTargetId: string }
  | { ok: false; error: string } {
  const routing = getEngineerRoutingSelection();

  log.debug("[engineer-debug] getRequiredLoopComputeTargetId", {
    mode: routing.mode,
    source: routing.source,
    computeTargetId: routing.computeTargetId,
  });

  if (
    routing.mode === EngineerRoutingMode.LocalElectron ||
    routing.mode === EngineerRoutingMode.CloudRelay
  ) {
    if (!routing.computeTargetId) {
      log.warn(
        "[engineer-debug] Loop compute target ID is null in routing store",
        {
          mode: routing.mode,
          source: routing.source,
          hint: "User may need to manually select a compute target in Engineer Settings when using hosted mode",
        }
      );
      return {
        ok: false,
        error:
          "No compute target configured. Connect a desktop gateway in Engineer Settings before starting planning.",
      };
    }
    return { ok: true, computeTargetId: routing.computeTargetId };
  }

  // Fallback for any future routing modes — require explicit configuration
  log.warn(
    "[engineer-debug] Unknown routing mode for loop compute target:",
    routing.mode
  );
  return {
    ok: false,
    error:
      "Start Planning requires a desktop compute target. Configure one in Engineer Settings.",
  };
}
