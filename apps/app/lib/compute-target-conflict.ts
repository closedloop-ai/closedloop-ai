import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";

import { ApiError } from "@/lib/api-error";

/**
 * Parses an unknown error to extract a ComputeTargetConflictBody if the error
 * is a 409 conflict response with multiple compute targets available.
 *
 * apiFetch throws ApiError with `data` set to the full ApiResult object
 * ({ success, error, data }), so the conflict body is nested at `error.data.data`.
 */
export function parseComputeTargetConflict(
  error: unknown
): ComputeTargetConflictBody | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }

  // error.data is the raw ApiResult: { success: false, error: string, data: ComputeTargetConflictBody }
  const apiResult = error.data as
    | { data?: ComputeTargetConflictBody }
    | undefined;
  const conflictBody = apiResult?.data;

  if (conflictBody && Array.isArray(conflictBody.availableTargets)) {
    return conflictBody;
  }

  return null;
}
