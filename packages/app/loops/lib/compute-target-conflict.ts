import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { computeTargetConflictBodyValidator } from "@repo/api/src/types/compute-target";
import { ApiError } from "@repo/app/shared/api/api-error";
import { z } from "zod";

// error.data is the raw ApiResult; the conflict body is nested at `.data`.
const conflictApiResultValidator = z.object({
  data: computeTargetConflictBodyValidator,
});

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

  const parsed = conflictApiResultValidator.safeParse(error.data);
  return parsed.success ? parsed.data.data : null;
}
