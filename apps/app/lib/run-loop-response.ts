import type { ApiConflictBody } from "@repo/api/src/types/common";
import type {
  BackendMismatchBody,
  ComputePreferenceRequiredBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import {
  ComputePreferenceRequiredError,
  ComputePreferenceRequiredMessage,
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

  if (response instanceof ComputePreferenceRequiredClientError) {
    toast.error(ComputePreferenceRequiredMessage);
    return;
  }

  // Error case: route 409 conflict responses by discriminant.
  // The wire shape is `ApiConflictBody<F>` from @repo/api — a typed failure
  // body shared between server and client.
  if (response instanceof ApiError && response.status === 409) {
    const apiResult = response.data as
      | ApiConflictBody<
          | ComputeTargetConflictBody
          | ComputePreferenceRequiredBody
          | BackendMismatchBody
          | LoopAlreadyActiveBody
        >
      | undefined;
    const conflictBody = apiResult?.data;

    if (conflictBody?.error === ComputePreferenceRequiredError) {
      toast.error(ComputePreferenceRequiredMessage);
      return;
    }
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

/** Client-side representation of the server's compute preference conflict. */
export class ComputePreferenceRequiredClientError extends Error {
  readonly code = ComputePreferenceRequiredError;

  constructor() {
    super(ComputePreferenceRequiredMessage);
    this.name = "ComputePreferenceRequiredClientError";
  }
}

export function isComputePreferenceRequiredError(error: unknown): boolean {
  return (
    error instanceof ComputePreferenceRequiredClientError ||
    (error instanceof ApiError &&
      error.status === 409 &&
      (error.data as ApiConflictBody<ComputePreferenceRequiredBody> | undefined)
        ?.data?.error === ComputePreferenceRequiredError)
  );
}

function isCreateLoopResponse(value: unknown): value is CreateLoopResponse {
  return createLoopResponseSchema.safeParse(value).success;
}
