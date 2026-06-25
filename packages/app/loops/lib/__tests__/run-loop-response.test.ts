/**
 * Unit tests for handleRunLoopResponse.
 *
 * Covers the 429 rate-limit branch added alongside the existing 409 conflict
 * routing, plus non-regression for the original multiple_targets and
 * backend_mismatch discriminants.
 */

import { ApiError } from "@repo/app/shared/api/api-error";
import { toast } from "@repo/design-system/components/ui/sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRunLoopResponse } from "../run-loop-response";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const mockToastError = toast.error as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockToastError.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeSuccessResponse = () => ({
  loopId: "loop-123",
  status: "running",
});

/** Wraps a conflict body in the ApiResult shape apiFetch stores in ApiError.data */
const wrapInApiResult = (conflictBody: unknown) => ({
  success: false,
  error: "Conflict",
  data: conflictBody,
});

const makeMultipleTargetsBody = () =>
  wrapInApiResult({
    error: "multiple_targets" as const,
    message: "Multiple compute targets available",
    availableTargets: [
      { id: "ct-1", machineName: "Mikes-MacBook", status: "online" },
      { id: "ct-2", machineName: "Office-Desktop", status: "offline" },
    ],
  });

const makeBackendMismatchBody = () =>
  wrapInApiResult({
    error: "backend_mismatch" as const,
    message: "Backend differs from artifact's last loop",
    originalComputeTargetId: "ct-old",
    originalComputeTargetName: "Old Machine",
    preferredComputeTargetId: "ct-new",
    documentId: "artifact-abc",
  });

// ---------------------------------------------------------------------------
// 429 rate-limit branch
// ---------------------------------------------------------------------------

describe("handleRunLoopResponse — 429 rate limit", () => {
  it("calls onRateLimited with error.message when ApiError status is 429", () => {
    const error = new ApiError("Too many concurrent loops", 429);
    const onRateLimited = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      onRateLimited,
    };

    handleRunLoopResponse(error, callbacks);

    expect(onRateLimited).toHaveBeenCalledOnce();
    expect(onRateLimited).toHaveBeenCalledWith("Too many concurrent loops");
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
  });

  it("does NOT call onRateLimited for ApiError with status 500", () => {
    const error = new ApiError("Internal Server Error", 500);
    const onRateLimited = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      onRateLimited,
    };

    handleRunLoopResponse(error, callbacks);

    expect(onRateLimited).not.toHaveBeenCalled();
  });

  it("does NOT call onRateLimited for ApiError with status 403", () => {
    const error = new ApiError("Forbidden", 403);
    const onRateLimited = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      onRateLimited,
    };

    handleRunLoopResponse(error, callbacks);

    expect(onRateLimited).not.toHaveBeenCalled();
  });

  it("does not throw when onRateLimited is omitted and status is 429", () => {
    const error = new ApiError("Rate limited", 429);
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      // onRateLimited intentionally omitted
    };

    expect(() => handleRunLoopResponse(error, callbacks)).not.toThrow();
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fallback toast for unhandled errors
// ---------------------------------------------------------------------------

describe("handleRunLoopResponse — fallback toast for unhandled errors", () => {
  const baseCallbacks = () => ({
    onMultipleTargets: vi.fn(),
    onBackendMismatch: vi.fn(),
    onSuccess: vi.fn(),
    onRateLimited: vi.fn(),
  });

  it("toasts the message for ApiError with status 500", () => {
    handleRunLoopResponse(
      new ApiError("Internal Server Error", 500),
      baseCallbacks()
    );

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Internal Server Error");
  });

  it("toasts the message for ApiError with status 403", () => {
    handleRunLoopResponse(new ApiError("Forbidden", 403), baseCallbacks());

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Forbidden");
  });

  it("toasts the message for a plain Error (network failure)", () => {
    handleRunLoopResponse(new Error("Network down"), baseCallbacks());

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Network down");
  });

  it("toasts a generic message for non-Error values", () => {
    handleRunLoopResponse("oops", baseCallbacks());

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("toasts when 409 has no conflict body", () => {
    handleRunLoopResponse(
      new ApiError("Conflict", 409, undefined, undefined),
      baseCallbacks()
    );

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Conflict");
  });

  it("does NOT toast for a successful response", () => {
    handleRunLoopResponse(
      { loopId: "loop-1", status: "running" },
      baseCallbacks()
    );

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("does NOT toast when onRateLimited handles a 429", () => {
    handleRunLoopResponse(new ApiError("Rate limited", 429), baseCallbacks());

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("does NOT toast when a 409 conflict body is routed to a callback", () => {
    handleRunLoopResponse(
      new ApiError("Conflict", 409, undefined, makeMultipleTargetsBody()),
      baseCallbacks()
    );

    expect(mockToastError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 409 loop_already_active branch
// ---------------------------------------------------------------------------

describe("handleRunLoopResponse — 409 loop_already_active", () => {
  const makeLoopAlreadyActiveBody = () =>
    wrapInApiResult({
      error: "loop_already_active" as const,
      loopId: "loop-existing-456",
      command: "EVALUATE_FEATURE",
      status: "RUNNING",
    });

  it("calls onLoopAlreadyActive with the payload when error is loop_already_active", () => {
    const error = new ApiError(
      "Conflict",
      409,
      undefined,
      makeLoopAlreadyActiveBody()
    );
    const onLoopAlreadyActive = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onLoopAlreadyActive,
      onSuccess: vi.fn(),
      onRateLimited: vi.fn(),
    };

    handleRunLoopResponse(error, callbacks);

    expect(onLoopAlreadyActive).toHaveBeenCalledOnce();
    expect(onLoopAlreadyActive).toHaveBeenCalledWith({
      error: "loop_already_active",
      loopId: "loop-existing-456",
      command: "EVALUATE_FEATURE",
      status: "RUNNING",
    });
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
  });

  it("does not throw when onLoopAlreadyActive is omitted and error is loop_already_active", () => {
    const error = new ApiError(
      "Conflict",
      409,
      undefined,
      makeLoopAlreadyActiveBody()
    );
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      // onLoopAlreadyActive intentionally omitted
    };

    expect(() => handleRunLoopResponse(error, callbacks)).not.toThrow();
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
  });

  it("does NOT call onLoopAlreadyActive for other 409 discriminants", () => {
    const error = new ApiError(
      "Conflict",
      409,
      undefined,
      makeMultipleTargetsBody()
    );
    const onLoopAlreadyActive = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onLoopAlreadyActive,
      onSuccess: vi.fn(),
      onRateLimited: vi.fn(),
    };

    handleRunLoopResponse(error, callbacks);

    expect(onLoopAlreadyActive).not.toHaveBeenCalled();
    expect(callbacks.onMultipleTargets).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 409 conflict routing — non-regression
// ---------------------------------------------------------------------------

describe("handleRunLoopResponse — 409 conflict routing (non-regression)", () => {
  it("routes multiple_targets discriminant to onMultipleTargets", () => {
    const error = new ApiError(
      "Conflict",
      409,
      undefined,
      makeMultipleTargetsBody()
    );
    const onMultipleTargets = vi.fn();
    const callbacks = {
      onMultipleTargets,
      onBackendMismatch: vi.fn(),
      onSuccess: vi.fn(),
      onRateLimited: vi.fn(),
    };

    handleRunLoopResponse(error, callbacks);

    expect(onMultipleTargets).toHaveBeenCalledOnce();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onRateLimited).not.toHaveBeenCalled();
  });

  it("routes backend_mismatch discriminant to onBackendMismatch", () => {
    const error = new ApiError(
      "Conflict",
      409,
      undefined,
      makeBackendMismatchBody()
    );
    const onBackendMismatch = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch,
      onSuccess: vi.fn(),
      onRateLimited: vi.fn(),
    };

    handleRunLoopResponse(error, callbacks);

    expect(onBackendMismatch).toHaveBeenCalledOnce();
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onRateLimited).not.toHaveBeenCalled();
  });

  it("routes a valid success response to onSuccess and does not invoke error callbacks", () => {
    const response = makeSuccessResponse();
    const onSuccess = vi.fn();
    const callbacks = {
      onMultipleTargets: vi.fn(),
      onBackendMismatch: vi.fn(),
      onSuccess,
      onRateLimited: vi.fn(),
    };

    handleRunLoopResponse(response, callbacks);

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(response);
    expect(callbacks.onMultipleTargets).not.toHaveBeenCalled();
    expect(callbacks.onBackendMismatch).not.toHaveBeenCalled();
    expect(callbacks.onRateLimited).not.toHaveBeenCalled();
  });
});
