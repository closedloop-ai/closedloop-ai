import { EngineerRoutingMode } from "@repo/api/src/types/relay";
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

  if (
    routing.mode === EngineerRoutingMode.LocalElectron ||
    routing.mode === EngineerRoutingMode.CloudRelay
  ) {
    if (!routing.computeTargetId) {
      return {
        ok: false,
        error:
          "No compute target configured. Connect a desktop gateway in Engineer Settings before starting planning.",
      };
    }
    return { ok: true, computeTargetId: routing.computeTargetId };
  }

  // Fallback for any future routing modes — require explicit configuration
  return {
    ok: false,
    error:
      "Start Planning requires a desktop compute target. Configure one in Engineer Settings.",
  };
}
