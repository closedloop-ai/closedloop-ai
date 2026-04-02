import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
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
        createMockArtifact({
          id: "artifact-123",
          status: ArtifactStatus.Approved,
          slug: "test-plan",
        })
      );

      const { result } = renderHook(
        () => usePlanActions({ artifactId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleApprove();
      });

      await waitFor(() => {
        expect(mockApiClient.put).toHaveBeenCalledWith(
          "/artifacts/artifact-123",
          { status: ArtifactStatus.Approved }
        );
      });
    });

    test("does not call mutation when artifactId is null", () => {
      const { result } = renderHook(
        () => usePlanActions({ artifactId: null }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.handleApprove();
      });

      expect(mockApiClient.put).not.toHaveBeenCalled();
    });
  });
});
