import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import type {
  CreateLoopResponse,
  LoopAlreadyActiveBody,
} from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { z } from "zod";

import { ApiError, getErrorMessage } from "@/lib/api-error";

const createLoopResponseSchema = z.object({
  loopId: z.string(),
  status: z.string(),
});

type RunLoopResponseCallbacks = {
  onMultipleTargets: (targets: ComputeTargetConflictBody) => void;
  onBackendMismatch: (body: BackendMismatchBody) => void;
  onLoopAlreadyActive?: (payload: LoopAlreadyActiveBody) => void;
  onSuccess: (response: CreateLoopResponse) => void;
  onRateLimited?: (message: string) => void;
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
 * Unrecognized errors fall back to a toast so they are always surfaced to the user.
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

  // 429 rate limit: concurrent loop limit exceeded
  if (response instanceof ApiError && response.status === 429) {
    callbacks.onRateLimited?.(response.message);
    return;
  }

  // Error case: route 409 conflict responses by discriminant
  if (response instanceof ApiError && response.status === 409) {
    // 409 conflict bodies extend ApiResult<never> with an extra `data` field
    // carrying the conflict shape: { success: false, error, data: ConflictBody }.
    // This is non-canonical (canonical ApiResult.failure has no data field), so
    // the shape is described inline here rather than reusing ApiResult<T>.
    const apiResult = response.data as
      | {
          data?:
            | ComputeTargetConflictBody
            | BackendMismatchBody
            | LoopAlreadyActiveBody;
        }
      | undefined;
    const conflictBody = apiResult?.data;

    if (
      conflictBody?.error === "loop_already_active" &&
      callbacks.onLoopAlreadyActive
    ) {
      callbacks.onLoopAlreadyActive(conflictBody as LoopAlreadyActiveBody);
      return;
    }
    // If onLoopAlreadyActive is absent, fall through to the trailing toast.error.
    if (conflictBody?.error === "multiple_targets") {
      callbacks.onMultipleTargets(conflictBody as ComputeTargetConflictBody);
      return;
    }
    if (conflictBody?.error === "backend_mismatch") {
      callbacks.onBackendMismatch(conflictBody as BackendMismatchBody);
      return;
    }
  }

  toast.error(getErrorMessage(response));
}

function isCreateLoopResponse(value: unknown): value is CreateLoopResponse {
  return createLoopResponseSchema.safeParse(value).success;
}
