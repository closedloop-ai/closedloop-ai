import { DocumentStatus } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import { usePlanActions } from "../use-plan-actions";

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Mock useRunLoop from use-loops — plan actions route loops through this hook
vi.mock("@/hooks/queries/use-loops", () => ({
  useRunLoop: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// Spies captured at module scope so handleRegenerate tests can assert on them
const mockMutate = vi.fn();
const mockPrepareConflictRefs = vi.fn();
const mockRunLoopWithPreLoopSystemCheck = vi.fn();

vi.mock("@/hooks/document-editing/use-document-run-loop", () => ({
  useDocumentRunLoop: () => ({
    runLoop: {
      mutate: mockMutate,
      mutateAsync: vi.fn(),
      isPending: false,
    },
    runLoopWithPreLoopSystemCheck: mockRunLoopWithPreLoopSystemCheck,
    isPreLoopExecutePending: false,
    prepareConflictRefs: mockPrepareConflictRefs,
    routeConflictError: vi.fn(),
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

describe("usePlanActions", () => {
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

  describe("handleApprove", () => {
    test("calls updateArtifact mutation with APPROVED status", async () => {
      mockApiClient.put.mockResolvedValueOnce(
        createMockDocument({
          id: "artifact-123",
          status: DocumentStatus.Approved,
          slug: "test-plan",
        })
      );

      const { result } = renderHook(
        () => usePlanActions({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleApprove();
      });

      await waitFor(() => {
        expect(mockApiClient.put).toHaveBeenCalledWith(
          "/documents/artifact-123",
          { status: DocumentStatus.Approved }
        );
      });
    });

    test("does not call mutation when documentId is null", () => {
      const { result } = renderHook(
        () => usePlanActions({ documentId: null }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleApprove();
      });

      expect(mockApiClient.put).not.toHaveBeenCalled();
    });
  });

  describe("handleRegenerate", () => {
    test("forwards additionalRepos to prepareConflictRefs and runLoop.mutate", () => {
      const additionalRepos: AdditionalRepoRef[] = [
        { fullName: "org/other-repo", branch: "main" },
      ];

      const { result } = renderHook(
        () => usePlanActions({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleRegenerate(additionalRepos);
      });

      const expectedParams = {
        command: RunLoopCommand.Plan,
        additionalRepos,
      };

      expect(mockPrepareConflictRefs).toHaveBeenCalledWith(expectedParams);
      expect(mockMutate).toHaveBeenCalledWith(
        { documentId: "artifact-123", ...expectedParams },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
    });

    test("calls with no additionalRepos when called with undefined", () => {
      const { result } = renderHook(
        () => usePlanActions({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleRegenerate();
      });

      const expectedParams = { command: RunLoopCommand.Plan };

      expect(mockPrepareConflictRefs).toHaveBeenCalledWith(expectedParams);
      expect(mockMutate).toHaveBeenCalledWith(
        { documentId: "artifact-123", ...expectedParams },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
      expect(mockPrepareConflictRefs).not.toHaveBeenCalledWith(
        expect.objectContaining({ additionalRepos: expect.anything() })
      );
    });
  });

  describe("handleExecute", () => {
    test("routes Execute through the pre-loop run-loop guard with additionalRepos", () => {
      const additionalRepos: AdditionalRepoRef[] = [
        { fullName: "org/other-repo", branch: "main" },
      ];

      const { result } = renderHook(
        () => usePlanActions({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleExecute(additionalRepos);
      });

      const expectedParams = {
        command: RunLoopCommand.Execute,
        additionalRepos,
      };

      expect(mockPrepareConflictRefs).toHaveBeenCalledWith(expectedParams);
      expect(mockRunLoopWithPreLoopSystemCheck).toHaveBeenCalledWith(
        { documentId: "artifact-123", ...expectedParams },
        expect.objectContaining({ onSuccess: expect.any(Function) })
      );
      expect(mockMutate).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: RunLoopCommand.Execute }),
        expect.anything()
      );
    });
  });
});
