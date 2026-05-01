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
const mockSelectTarget = vi.fn();
const mockConfirmOriginalBackend = vi.fn();
const mockConfirmPreferredBackend = vi.fn();
const mockDismissBackendMismatch = vi.fn();

let mockIsPending = false;
let mockMultiTargetState: { availableTargets: string[] } | null = null;
let mockBackendMismatchState: {
  originalComputeTargetId: string | null;
  preferredComputeTargetId: string | null;
} | null = null;

vi.mock("@/hooks/document-editing/use-document-run-loop", () => ({
  useDocumentRunLoop: () => ({
    runLoop: {
      mutate: mockMutate,
      mutateAsync: vi.fn(),
      isPending: mockIsPending,
    },
    prepareConflictRefs: mockPrepareConflictRefs,
    routeConflictError: mockRouteConflictError,
    makeRequestChangesHandler: vi.fn(() => vi.fn()),
    selectTarget: mockSelectTarget,
    confirmOriginalBackend: mockConfirmOriginalBackend,
    confirmPreferredBackend: mockConfirmPreferredBackend,
    dismissBackendMismatch: mockDismissBackendMismatch,
    multiTargetState: mockMultiTargetState,
    backendMismatchState: mockBackendMismatchState,
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
    mockIsPending = false;
    mockMultiTargetState = null;
    mockBackendMismatchState = null;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe("handleEvaluateFeature", () => {
    test("calls prepareConflictRefs with EvaluateFeature command", () => {
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
    });

    test("calls runLoop.mutate with documentId and EvaluateFeature command", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleEvaluateFeature();
      });

      expect(mockMutate).toHaveBeenCalledOnce();
      expect(mockMutate).toHaveBeenCalledWith(
        { documentId: "doc-123", command: RunLoopCommand.EvaluateFeature },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        })
      );
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

    test("onError callback routes to routeConflictError", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleEvaluateFeature();
      });

      const onError = mockMutate.mock.calls[0][1].onError;
      const testError = new Error("conflict");
      act(() => {
        onError(testError);
      });

      expect(mockRouteConflictError).toHaveBeenCalledWith(testError);
    });
  });

  describe("isEvaluating", () => {
    test("is false when runLoop is not pending", () => {
      mockIsPending = false;

      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(result.current.isEvaluating).toBe(false);
    });

    test("is true when runLoop is pending", () => {
      mockIsPending = true;

      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(result.current.isEvaluating).toBe(true);
    });
  });

  describe("conflict resolution passthrough", () => {
    test("exposes multiTargetState from useDocumentRunLoop", () => {
      mockMultiTargetState = { availableTargets: ["target-a", "target-b"] };

      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(result.current.multiTargetState).toEqual({
        availableTargets: ["target-a", "target-b"],
      });
    });

    test("selectTarget delegates to useDocumentRunLoop selectTarget", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.selectTarget("target-x");
      });

      expect(mockSelectTarget).toHaveBeenCalledWith("target-x");
    });

    test("exposes backendMismatchState from useDocumentRunLoop", () => {
      mockBackendMismatchState = {
        originalComputeTargetId: "orig-1",
        preferredComputeTargetId: "pref-2",
      };

      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(result.current.backendMismatchState).toEqual({
        originalComputeTargetId: "orig-1",
        preferredComputeTargetId: "pref-2",
      });
    });

    test("confirmOriginalBackend delegates to useDocumentRunLoop", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.confirmOriginalBackend();
      });

      expect(mockConfirmOriginalBackend).toHaveBeenCalledOnce();
    });

    test("confirmPreferredBackend delegates to useDocumentRunLoop", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.confirmPreferredBackend();
      });

      expect(mockConfirmPreferredBackend).toHaveBeenCalledOnce();
    });

    test("dismissBackendMismatch delegates to useDocumentRunLoop", () => {
      const { result } = renderHook(
        () => useFeatureActions({ documentId: "doc-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.dismissBackendMismatch();
      });

      expect(mockDismissBackendMismatch).toHaveBeenCalledOnce();
    });
  });
});
