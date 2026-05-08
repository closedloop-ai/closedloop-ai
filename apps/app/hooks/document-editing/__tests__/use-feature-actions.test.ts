import { RunLoopCommand } from "@repo/api/src/types/loop";
import { toast } from "@repo/design-system/components/ui/sonner";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import { useFeatureActions } from "../use-feature-actions";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockPrepareConflictRefs = vi.fn();
const mockRouteConflictError = vi.fn();

vi.mock("@/hooks/document-editing/use-document-run-loop", () => ({
  useDocumentRunLoop: () => ({
    runLoop: {
      mutate: mockMutate,
      mutateAsync: vi.fn(),
      isPending: false,
    },
    prepareConflictRefs: mockPrepareConflictRefs,
    routeConflictError: mockRouteConflictError,
    makeRequestChangesHandler: vi.fn(() => vi.fn()),
    selectTarget: vi.fn(),
    confirmOriginalBackend: vi.fn(),
    confirmPreferredBackend: vi.fn(),
    dismissBackendMismatch: vi.fn(),
    multiTargetState: null,
    backendMismatchState: null,
    pendingConflictCommandRef: { current: null },
    pendingActionRef: { current: null },
    pendingMismatchActionRef: { current: null },
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFeatureActions", () => {
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

  describe("handleEvaluateFeature", () => {
    test("prepares conflict refs, dispatches EvaluateFeature, and routes errors", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleEvaluateFeature();
      });

      expect(mockPrepareConflictRefs).toHaveBeenCalledOnce();
      expect(mockPrepareConflictRefs).toHaveBeenCalledWith({
        command: RunLoopCommand.EvaluateFeature,
      });
      expect(mockMutate).toHaveBeenCalledOnce();
      expect(mockMutate).toHaveBeenCalledWith(
        { documentId: "doc-123", command: RunLoopCommand.EvaluateFeature },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        })
      );

      const onError = mockMutate.mock.calls[0][1].onError;
      const testError = new Error("conflict");
      act(() => {
        onError(testError);
      });

      expect(mockRouteConflictError).toHaveBeenCalledWith(testError);
    });

    test("onSuccess callback shows feature evaluation started toast", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleEvaluateFeature();
      });

      const onSuccess = mockMutate.mock.calls[0][1].onSuccess;
      act(() => {
        onSuccess();
      });

      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        "Feature evaluation started"
      );
    });
  });
});
