import { TagEntityType } from "@repo/api/src/types/tag";
import type { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
// This cross-feature key proves generic tag mutations invalidate the Branch
// records that project those same associations.
import { branchRowQueryKeys } from "../../../branches/hooks/branch-query-keys";
import { projectTreeKeys } from "../../../projects/hooks/use-project-tree";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "../../../shared/test-utils";
import {
  useApplyTag,
  useBatchApplyTag,
  useCreateTag,
  useRemoveTag,
} from "../use-tags";

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

// FEA-2940: the project page's artifact grid renders rows (and their tag chips)
// from the project-tree query, so tag mutations must invalidate projectTreeKeys
// or a newly added/removed tag only shows after a full page reload.
describe("use-tags invalidation refreshes the project-tree grid (FEA-2940)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useApplyTag invalidates the project-tree query", async () => {
    mockApiClient.post.mockResolvedValueOnce({ applied: true });
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityId: "doc-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectTreeKeys.all,
    });
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
  });

  test("useRemoveTag invalidates the project-tree query", async () => {
    mockApiClient.delete.mockResolvedValueOnce(undefined);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRemoveTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityId: "doc-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectTreeKeys.all,
    });
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
  });

  test("useBatchApplyTag invalidates every tag-bearing Branch query family", async () => {
    mockApiClient.post.mockResolvedValueOnce({ appliedCount: 2 });
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: ["branch-1", "branch-2"],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
  });

  test("failed batch apply does not invalidate Branch queries", async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error("batch failed"));
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useBatchApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityIds: ["branch-1"],
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.lists,
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.details,
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.pageData,
    });
  });

  test("creating then applying a new tag invalidates the project-tree query", async () => {
    // handleCreate (tag-picker) creates the tag, then applies it — the apply is
    // what surfaces the chip in the grid, so the tree must end up invalidated.
    mockApiClient.post
      .mockResolvedValueOnce({ id: "tag-new", name: "new" }) // POST /tags
      .mockResolvedValueOnce({ applied: true }); // POST /entity-tags
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const applyHook = renderHook(() => useApplyTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    const createHook = renderHook(() => useCreateTag(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    createHook.result.current.mutate(
      { name: "new" },
      {
        onSuccess: (created) =>
          applyHook.result.current.mutate({
            tagId: created.id,
            entityType: TagEntityType.Artifact,
            entityId: "doc-1",
          }),
      }
    );

    await waitFor(() => expect(applyHook.result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectTreeKeys.all,
    });
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
  });
});

function invalidatedQueryKeys(invalidateSpy: {
  mock: { calls: Parameters<QueryClient["invalidateQueries"]>[] };
}) {
  return invalidateSpy.mock.calls.map(([filters]) => filters?.queryKey);
}

const branchTagQueryKeys = [
  branchRowQueryKeys.lists,
  branchRowQueryKeys.details,
  branchRowQueryKeys.pageData,
];
