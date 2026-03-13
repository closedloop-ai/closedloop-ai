import { computeTargetsService } from "@/app/compute-targets/service";

export class ComputeTargetValidationError extends Error {
  readonly reason: "not_found" | "offline";
  constructor(reason: "not_found" | "offline") {
    super(
      reason === "not_found"
        ? "Compute target not found"
        : "Compute target offline"
    );
    this.reason = reason;
  }
}

/**
 * Validate a compute target: exists, belongs to org, and is online.
 * Throws on failure (caught by the route's try/catch).
 */
export async function assertComputeTargetValid(
  computeTargetId: string,
  organizationId: string
): Promise<void> {
  const target = await computeTargetsService.findById(computeTargetId);
  if (!target || target.organizationId !== organizationId) {
    throw new ComputeTargetValidationError("not_found");
  }
  if (!target.isOnline) {
    throw new ComputeTargetValidationError("offline");
  }
}
