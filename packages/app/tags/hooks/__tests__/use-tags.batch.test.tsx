import { TagEntityType } from "@repo/api/src/types/tag";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useBatchApplyTag } from "../use-tags";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("useBatchApplyTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts to /entity-tags/batch with tag ID, entity type, and entity IDs", async () => {
    const responsePayload = { appliedCount: 3 };
    mockApiClient.post.mockResolvedValueOnce(responsePayload);

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: ["doc-1", "doc-2", "doc-3"],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith("/entity-tags/batch", {
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: ["doc-1", "doc-2", "doc-3"],
    });
    expect(result.current.data).toEqual({ appliedCount: 3 });
  });

  test("transitions to error state when the API call fails", async () => {
    const error = new Error("batch apply failed");
    mockApiClient.post.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: ["doc-1"],
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(error);
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
