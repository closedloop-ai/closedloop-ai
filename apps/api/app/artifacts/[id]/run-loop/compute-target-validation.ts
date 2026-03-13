import { computeTargetsService } from "@/app/compute-targets/service";

type ComputeTargetValidationResult =
  | { valid: true }
  | { valid: false; reason: "not_found" | "offline" };

/**
 * Validate a compute target: exists, belongs to org, and is online.
 * Returns a result object instead of throwing.
 */
export async function validateComputeTarget(
  computeTargetId: string,
  organizationId: string
): Promise<ComputeTargetValidationResult> {
  const target = await computeTargetsService.findById(computeTargetId);
  if (!target || target.organizationId !== organizationId) {
    return { valid: false, reason: "not_found" };
  }
  if (!target.isOnline) {
    return { valid: false, reason: "offline" };
  }
  return { valid: true };
}
