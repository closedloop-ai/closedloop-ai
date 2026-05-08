import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import type { EngineerRoutingSelection } from "./routing-store";

/** Resolve a human-readable label for the active compute target. */
export function resolveTargetLabel(
  routing: Pick<EngineerRoutingSelection, "mode" | "computeTargetId">,
  targets: ComputeTarget[]
): string | undefined {
  if (
    routing.mode === EngineerRoutingMode.CloudRelay &&
    routing.computeTargetId
  ) {
    const target = targets.find((t) => t.id === routing.computeTargetId);
    return target?.machineName;
  }
  if (routing.mode === EngineerRoutingMode.LocalElectron) {
    return "localhost";
  }
  return undefined;
}
