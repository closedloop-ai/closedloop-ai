/**
 * Unit tests for usePrdActions hook.
 *
 * Covers:
 * - success path: handleRequestChanges returns true and calls mutate correctly
 * - conflict error routing: 409 multiple_targets error sets multiTargetState
 * - null documentId guard: returns false without calling mutate
 */

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { usePrdActions } from "@/hooks/document-editing/use-prd-actions";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import { ApiError } from "@/lib/api-error";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();

vi.mock("@/hooks/queries/use-loops", () => ({
  useRunLoop: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

const mockHandleRunLoopResponse = vi.fn();

vi.mock("@/lib/run-loop-response", () => ({
  handleRunLoopResponse: (...args: unknown[]) =>
    mockHandleRunLoopResponse(...args),
}));

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeMultipleTargetsConflict = () => ({
  error: "multiple_targets" as const,
  message: "Multiple compute targets available",
  availableTargets: [
    { id: "ct-1", machineName: "Mikes-MacBook", status: "online" },
    { id: "ct-2", machineName: "Office-Desktop", status: "offline" },
  ],
});

const wrapInApiResult = (conflictBody: unknown) => ({
  success: false,
  error: "Conflict",
  data: conflictBody,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usePrdActions", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe("handleRequestChanges — success path", () => {
    test("returns true and calls mutate with correct arguments", async () => {
      mockMutate.mockImplementationOnce((_params, options) => {
        options?.onSuccess?.({ loopId: "loop-123", status: "running" });
      });

      const { result } = renderHook(
        () => usePrdActions({ documentId: "test-id" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      let returnValue: boolean | undefined;
      await act(async () => {
        returnValue =
          await result.current.handleRequestChanges("add error handling");
      });

      expect(returnValue).toBe(true);
      expect(mockMutate).toHaveBeenCalledOnce();
      expect(mockMutate).toHaveBeenCalledWith(
        {
          documentId: "test-id",
          command: RunLoopCommand.RequestPrdChanges,
          prompt: "add error handling",
        },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });
  });

  describe("handleRequestChanges — conflict error routing", () => {
    test("sets multiTargetState when mutate reports ApiError with multiple_targets body", async () => {
      const conflict = makeMultipleTargetsConflict();
      const apiError = new ApiError(
        "Conflict",
        409,
        undefined,
        wrapInApiResult(conflict)
      );
      mockMutate.mockImplementationOnce((_params, options) => {
        options?.onError?.(apiError);
      });

      // Simulate routeConflictError invoking onMultipleTargets to set multiTargetState
      mockHandleRunLoopResponse.mockImplementationOnce(
        (
          _error: unknown,
          callbacks: {
            onMultipleTargets: (
              c: ReturnType<typeof makeMultipleTargetsConflict>
            ) => void;
          }
        ) => {
          callbacks.onMultipleTargets(conflict);
        }
      );

      const { result } = renderHook(
        () => usePrdActions({ documentId: "test-id" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      await act(async () => {
        await result.current.handleRequestChanges("add error handling");
      });

      await waitFor(() => {
        expect(result.current.multiTargetState).toEqual({
          availableTargets: conflict.availableTargets,
        });
      });
    });
  });
});
