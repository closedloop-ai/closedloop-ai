import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";

const createLoopResponseSchema = z.object({
  loopId: z.string(),
  status: z.string(),
});

type RunLoopResponseCallbacks = {
  onMultipleTargets: (targets: ComputeTargetConflictBody) => void;
  onBackendMismatch: (body: BackendMismatchBody) => void;
  onSuccess: (response: CreateLoopResponse) => void;
};

/**
 * Routes a run-loop API response (success or error) to the appropriate callback
 * based on the `error` discriminant field in the response body.
 *
 * - `"multiple_targets"` → onMultipleTargets: multiple online compute targets match
 * - `"backend_mismatch"` → onBackendMismatch: resolved target differs from artifact's established backend
 * - undefined (success) → onSuccess: loop was created successfully
 *
 * 409 conflict responses are thrown as ApiError by apiFetch. The conflict body
 * is nested at `apiError.data.data` (ApiResult.data = conflict body).
 * Non-conflict errors are not handled and should be caught by the caller or
 * the global QueryClient mutations.onError toast handler.
 */
export function handleRunLoopResponse(
  response: unknown,
  callbacks: RunLoopResponseCallbacks
): void {
  // Success case: response is a CreateLoopResponse (has loopId + status)
  if (isCreateLoopResponse(response)) {
    callbacks.onSuccess(response);
    return;
  }

  // Error case: route 409 conflict responses by discriminant
  if (!(response instanceof ApiError) || response.status !== 409) {
    if (response instanceof ApiError) {
      console.warn(
        "[engineer-debug] run-loop error not handled by handleRunLoopResponse",
        {
          status: response.status,
          message: response.message,
          data: response.data,
        }
      );
    }
    return;
  }

  // ApiError.data is the raw ApiResult: { success: false, error: string, data: ConflictBody }
  const apiResult = response.data as
    | { data?: ComputeTargetConflictBody | BackendMismatchBody }
    | undefined;
  const conflictBody = apiResult?.data;

  if (!conflictBody) {
    return;
  }

  if (conflictBody.error === "multiple_targets") {
    callbacks.onMultipleTargets(conflictBody as ComputeTargetConflictBody);
  } else if (conflictBody.error === "backend_mismatch") {
    callbacks.onBackendMismatch(conflictBody as BackendMismatchBody);
  }
}

function isCreateLoopResponse(value: unknown): value is CreateLoopResponse {
  return createLoopResponseSchema.safeParse(value).success;
}
