import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";

import { ApiError } from "@/lib/api-error";

/**
 * Parses an unknown error to extract a ComputeTargetConflictBody if the error
 * is a 409 conflict response with multiple compute targets available.
 */
export function parseComputeTargetConflict(
  error: unknown
): ComputeTargetConflictBody | null {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    Array.isArray(
      (error.data as ComputeTargetConflictBody | undefined)?.availableTargets
    )
  ) {
    return error.data as ComputeTargetConflictBody;
  }

  return null;
}
