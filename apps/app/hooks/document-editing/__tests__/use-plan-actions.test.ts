import { DocumentStatus } from "@repo/api/src/types/document";
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
});
