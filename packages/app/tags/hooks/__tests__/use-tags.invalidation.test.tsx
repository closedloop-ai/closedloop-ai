import { TagEntityType } from "@repo/api/src/types/tag";
import type { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
// These cross-feature keys prove generic tag mutations invalidate the Branch and
// Session records that project those same associations.
import { agentSessionKeys } from "../../../agents/hooks/agent-session-keys";
import { branchRowQueryKeys } from "../../../branches/hooks/branch-query-keys";
import { documentKeys } from "../../../documents/hooks/document-keys";
import { projectTreeKeys } from "../../../projects/hooks/project-tree-keys";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "../../../shared/test-utils";
import {
  tagKeys,
  useApplyTag,
  useBatchApplyTag,
  useCreateTag,
  useRemoveTag,
  useUpdateTag,
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
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(sessionTagQueryKeys)
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
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(sessionTagQueryKeys)
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
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(sessionTagQueryKeys)
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
    // ISS-8712: a rejected write must not refresh Sessions either — invalidating
    // there would refetch the rows and re-render the pre-write chips, which reads
    // to a user as the change being applied and then reverted.
    for (const queryKey of sessionTagQueryKeys) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey });
    }
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
    expect(invalidatedQueryKeys(invalidateSpy)).toEqual(
      expect.arrayContaining(sessionTagQueryKeys)
    );
  });
});

// ISS-12452: Branches on desktop caches its reads in a client of its own
// (`useBranchesQueryContext`), distinct from the ambient one these mutations
// default to. A write that reaches only the injected client leaves the
// picker's own tag list and every Document/Session chip stale; one that
// reaches only the ambient client is indistinguishable from a tag click doing
// nothing. A tag write spans both, so both are invalidated (marisolashgrove
// review, PR #8793).
describe("use-tags mutations invalidate the ambient client AND an injected one (ISS-12452)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useApplyTag invalidates the injected client's branch keys and the ambient client's families", async () => {
    mockApiClient.post.mockResolvedValueOnce({ applied: true });
    const ambientClient = createTestQueryClient();
    const injectedClient = createTestQueryClient();
    const ambientInvalidateSpy = vi.spyOn(ambientClient, "invalidateQueries");
    const injectedInvalidateSpy = vi.spyOn(injectedClient, "invalidateQueries");

    const { result } = renderHook(
      () => useApplyTag({ queryClient: injectedClient }),
      { wrapper: createWrapperWithClient(ambientClient) }
    );
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityId: "branch-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedQueryKeys(injectedInvalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
    expect(invalidatedQueryKeys(ambientInvalidateSpy)).toEqual(
      expect.arrayContaining(ambientOnlyTagQueryKeys)
    );
  });

  test("useRemoveTag invalidates the injected client's branch keys and the ambient client's families", async () => {
    mockApiClient.delete.mockResolvedValueOnce(undefined);
    const ambientClient = createTestQueryClient();
    const injectedClient = createTestQueryClient();
    const ambientInvalidateSpy = vi.spyOn(ambientClient, "invalidateQueries");
    const injectedInvalidateSpy = vi.spyOn(injectedClient, "invalidateQueries");

    const { result } = renderHook(
      () => useRemoveTag({ queryClient: injectedClient }),
      { wrapper: createWrapperWithClient(ambientClient) }
    );
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityId: "branch-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedQueryKeys(injectedInvalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
    expect(invalidatedQueryKeys(ambientInvalidateSpy)).toEqual(
      expect.arrayContaining(ambientOnlyTagQueryKeys)
    );
  });

  // `useTags` — the list the picker renders — takes no client override, so a
  // rename or recolour driven from a Branch row has to reach the ambient
  // client's tag list or the picker and every chip keep the old name.
  test("useUpdateTag invalidates the ambient client's tag list", async () => {
    mockApiClient.patch.mockResolvedValueOnce({ id: "tag-1", name: "renamed" });
    const ambientClient = createTestQueryClient();
    const injectedClient = createTestQueryClient();
    const ambientInvalidateSpy = vi.spyOn(ambientClient, "invalidateQueries");
    const injectedInvalidateSpy = vi.spyOn(injectedClient, "invalidateQueries");

    const { result } = renderHook(
      () => useUpdateTag({ queryClient: injectedClient }),
      { wrapper: createWrapperWithClient(ambientClient) }
    );
    result.current.mutate({ id: "tag-1", name: "renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedQueryKeys(ambientInvalidateSpy)).toEqual(
      expect.arrayContaining([tagKeys.lists(), ...ambientOnlyTagQueryKeys])
    );
    expect(invalidatedQueryKeys(injectedInvalidateSpy)).toEqual(
      expect.arrayContaining(branchTagQueryKeys)
    );
  });

  test("useApplyTag falls back to the ambient client when none is injected", async () => {
    // The default, unchanged behaviour every other surface (Sessions,
    // Documents) relies on — omitting the option must not become "invalidate
    // nothing".
    mockApiClient.post.mockResolvedValueOnce({ applied: true });
    const ambientClient = createTestQueryClient();
    const ambientInvalidateSpy = vi.spyOn(ambientClient, "invalidateQueries");

    const { result } = renderHook(() => useApplyTag(), {
      wrapper: createWrapperWithClient(ambientClient),
    });
    result.current.mutate({
      tagId: "tag-1",
      entityType: TagEntityType.Artifact,
      entityId: "session-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(ambientInvalidateSpy).toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.lists,
    });
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

// ISS-8712: the Sessions families that project the same `TagArtifact` join. The
// Sessions tag cell reads `appliedTags` off the cached row, so a write that does
// not invalidate these leaves the chips stale until an unrelated refetch.
const sessionTagQueryKeys = [
  agentSessionKeys.lists(),
  agentSessionKeys.pageDataRoot(),
  agentSessionKeys.details(),
];

// ISS-12452: the families a Branch-owned client never caches. Only the ambient
// client can answer these, so they are what a write routed to the injected
// client alone would leave stale.
const ambientOnlyTagQueryKeys = [documentKeys.all, ...sessionTagQueryKeys];
