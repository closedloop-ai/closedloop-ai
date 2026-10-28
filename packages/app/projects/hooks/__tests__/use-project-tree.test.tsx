import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type MoveArtifactRequest,
  type MoveArtifactResponse,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import {
  PROJECT_TREE_CATEGORY_PARAM,
  PROJECT_TREE_CHILD_CURSOR_PARAM,
  PROJECT_TREE_CHILD_LIMIT_PARAM,
  PROJECT_TREE_CONTRACT_VERSION,
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_HIERARCHY_PARAM,
  PROJECT_TREE_HIERARCHY_REVISION_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_MAX_VISIBLE_LEVELS,
  PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM,
  PROJECT_TREE_ROOT_CURSOR_PARAM,
  ProjectTreeCategory,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeResponse,
  type TreeNode,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryCacheScopeOf } from "../../../shared/query/query-cache-scope";
import {
  makeQueryClient,
  setQueryCacheScope,
} from "../../../shared/query/query-client";
import { projectTreeKeys } from "../project-tree-keys";
import {
  applyMoveToTree,
  useMoveArtifact,
  useProjectTree,
  useProjectTreeExpansionBatch,
  useProjectTreeRootPages,
  useProjectTreeWithDetails,
} from "../use-project-tree";

function createWrapperWithClient(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/**
 * Variant of `createTestQueryClient` that keeps inactive queries in cache so
 * tests can inspect `getQueryData` after a mutation settles without a
 * `useQuery` subscriber. The default `gcTime: 0` evicts the entry the moment
 * its last observer unsubscribes.
 */
function createInspectableQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const CONTRIBUTOR_USER_ID = "33333333-3333-7333-8333-333333333333";
const ORG_A = queryCacheScopeOf("user-1", "org-a");
const ORG_B = queryCacheScopeOf("user-1", "org-b");

function makeNode(id: string, name: string, sortOrder: number): TreeNode {
  const artifact: Artifact = {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-10-19T00:00:00.000Z"),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id,
    name,
    organizationId: "22222222-2222-7222-8222-222222222222",
    priority: null,
    projectId: PROJECT_ID,
    slug: null,
    sortOrder,
    status: "BACKLOG",
    subtype: null,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-19T00:00:00.000Z"),
  };
  return { root: artifact, children: [] };
}

function makeTree(...nodes: TreeNode[]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

const A_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const B_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const C_ID = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyMoveToTree", () => {
  const original = [
    makeNode(A_ID, "A", 1000),
    makeNode(B_ID, "B", 2000),
    makeNode(C_ID, "C", 3000),
  ];

  it("moves a node to the top", () => {
    const result = applyMoveToTree(original, {
      artifactId: B_ID,
      position: MovePosition.Top,
    });
    expect(result.map((n) => n.root.id)).toEqual([B_ID, A_ID, C_ID]);
  });

  it("moves a node to the bottom", () => {
    const result = applyMoveToTree(original, {
      artifactId: A_ID,
      position: MovePosition.Bottom,
    });
    expect(result.map((n) => n.root.id)).toEqual([B_ID, C_ID, A_ID]);
  });

  it("inserts before a reference", () => {
    const result = applyMoveToTree(original, {
      artifactId: C_ID,
      position: MovePosition.Before,
      referenceArtifactId: A_ID,
    });
    expect(result.map((n) => n.root.id)).toEqual([C_ID, A_ID, B_ID]);
  });

  it("inserts after a reference", () => {
    const result = applyMoveToTree(original, {
      artifactId: A_ID,
      position: MovePosition.After,
      referenceArtifactId: B_ID,
    });
    expect(result.map((n) => n.root.id)).toEqual([B_ID, A_ID, C_ID]);
  });

  it("is a no-op when artifactId is not in the tree", () => {
    const result = applyMoveToTree(original, {
      artifactId: "99999999-9999-7999-8999-999999999999",
      position: MovePosition.Top,
    });
    expect(result).toBe(original);
  });

  it("is a no-op when reference is missing on before/after", () => {
    const result = applyMoveToTree(original, {
      artifactId: A_ID,
      position: MovePosition.Before,
      referenceArtifactId: "99999999-9999-7999-8999-999999999999",
    });
    expect(result).toBe(original);
  });
});

describe("useMoveArtifact", () => {
  function setup(seed: ProjectTreeResponse) {
    const queryClient = createInspectableQueryClient();
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), seed);
    const wrapper = createWrapperWithClient(queryClient);
    return { queryClient, wrapper };
  }

  function setupScoped(seed: ProjectTreeResponse) {
    const queryClient = makeQueryClient({
      gcTime: Number.POSITIVE_INFINITY,
    });
    setQueryCacheScope(queryClient, ORG_A);
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), seed);
    const wrapper = createWrapperWithClient(queryClient);
    return { queryClient, wrapper };
  }

  it("optimistically applies the new order, then settles on server response", async () => {
    const seed = makeTree(
      makeNode(A_ID, "A", 1000),
      makeNode(B_ID, "B", 2000),
      makeNode(C_ID, "C", 3000)
    );
    const { queryClient, wrapper } = setup(seed);

    const serverResponse: MoveArtifactResponse = {
      moved: true,
      newSortOrder: 0,
    };
    mockApiClient.post.mockResolvedValue(serverResponse);

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });

    const body: MoveArtifactRequest = {
      artifactId: B_ID,
      position: MovePosition.Top,
    };
    await act(async () => {
      await result.current.mutateAsync(body);
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/move`,
      body
    );

    // onSettled invalidated the query — but until a refetch fires, the
    // optimistic value is what's in the cache.
    const post = queryClient.getQueryData<ProjectTreeResponse>(
      projectTreeKeys.detail(PROJECT_ID)
    );
    expect(post?.nodes.map((n) => n.root.id)).toEqual([B_ID, A_ID, C_ID]);
  });

  it("rolls back the optimistic update when the mutation fails", async () => {
    const seed = makeTree(
      makeNode(A_ID, "A", 1000),
      makeNode(B_ID, "B", 2000),
      makeNode(C_ID, "C", 3000)
    );
    const { queryClient, wrapper } = setup(seed);

    mockApiClient.post.mockRejectedValue(new Error("Server down"));

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current
        .mutateAsync({ artifactId: B_ID, position: MovePosition.Top })
        .catch(() => {
          // Expected — assertion is on the rollback below.
        });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const post = queryClient.getQueryData<ProjectTreeResponse>(
      projectTreeKeys.detail(PROJECT_ID)
    );
    expect(post?.nodes.map((n) => n.root.id)).toEqual([A_ID, B_ID, C_ID]);
  });

  it("applies the optimistic move to the with-details variant cache too", async () => {
    const seed = makeTree(
      makeNode(A_ID, "A", 1000),
      makeNode(B_ID, "B", 2000),
      makeNode(C_ID, "C", 3000)
    );
    const { queryClient, wrapper } = setup(seed);
    const withDetailsSeed: ProjectTreeDetailsResponse = makeTree(
      makeNode(A_ID, "A", 1000),
      makeNode(B_ID, "B", 2000),
      makeNode(C_ID, "C", 3000)
    );
    queryClient.setQueryData(
      projectTreeKeys.withDetails(PROJECT_ID),
      withDetailsSeed
    );

    mockApiClient.post.mockResolvedValue({ moved: true, newSortOrder: 0 });

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        artifactId: B_ID,
        position: MovePosition.Top,
      });
    });

    const variant = queryClient.getQueryData<ProjectTreeDetailsResponse>(
      projectTreeKeys.withDetails(PROJECT_ID)
    );
    expect(variant?.nodes.map((n) => n.root.id)).toEqual([B_ID, A_ID, C_ID]);
  });

  it("rolls back both cache entries when the mutation fails", async () => {
    const seed = makeTree(makeNode(A_ID, "A", 1000), makeNode(B_ID, "B", 2000));
    const { queryClient, wrapper } = setup(seed);
    const withDetailsSeed: ProjectTreeDetailsResponse = makeTree(
      makeNode(A_ID, "A", 1000),
      makeNode(B_ID, "B", 2000)
    );
    queryClient.setQueryData(
      projectTreeKeys.withDetails(PROJECT_ID),
      withDetailsSeed
    );

    mockApiClient.post.mockRejectedValue(new Error("Server down"));

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });
    await act(async () => {
      await result.current
        .mutateAsync({ artifactId: B_ID, position: MovePosition.Top })
        .catch(() => {
          // Expected — assertion is on the rollback below.
        });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const detail = queryClient.getQueryData<ProjectTreeResponse>(
      projectTreeKeys.detail(PROJECT_ID)
    );
    const variant = queryClient.getQueryData<ProjectTreeDetailsResponse>(
      projectTreeKeys.withDetails(PROJECT_ID)
    );
    expect(detail?.nodes.map((n) => n.root.id)).toEqual([A_ID, B_ID]);
    expect(variant?.nodes.map((n) => n.root.id)).toEqual([A_ID, B_ID]);
  });

  it("does not resurrect org A's project entry in org B after a late rollback", async () => {
    const seed = makeTree(makeNode(A_ID, "A", 1000), makeNode(B_ID, "B", 2000));
    const { queryClient, wrapper } = setupScoped(seed);
    const request = deferred<MoveArtifactResponse>();
    mockApiClient.post.mockReturnValue(request.promise);

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });
    let mutation: Promise<MoveArtifactResponse> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        artifactId: B_ID,
        position: MovePosition.Top,
      });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
    const pendingMutation = queryClient.getMutationCache().getAll()[0];
    expect(pendingMutation).toBeDefined();
    const onError = vi.spyOn(pendingMutation!.options, "onError");
    expect(
      queryClient
        .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
        ?.nodes.map((node) => node.root.id)
    ).toEqual([B_ID, A_ID]);

    setQueryCacheScope(queryClient, ORG_B);
    queryClient.clear();
    await act(async () => {
      request.reject(new Error("Server down"));
      await mutation?.catch(() => {
        // Expected — assertion is on the cache after the late rollback.
      });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toEqual(new Error("Server down"));
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toBeUndefined();
  });

  it("restores org A's project entry when a pending mutation fails without a switch", async () => {
    const seed = makeTree(makeNode(A_ID, "A", 1000), makeNode(B_ID, "B", 2000));
    const { queryClient, wrapper } = setupScoped(seed);
    const request = deferred<MoveArtifactResponse>();
    mockApiClient.post.mockReturnValue(request.promise);

    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });
    let mutation: Promise<MoveArtifactResponse> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        artifactId: B_ID,
        position: MovePosition.Top,
      });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(
      queryClient
        .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
        ?.nodes.map((node) => node.root.id)
    ).toEqual([B_ID, A_ID]);

    await act(async () => {
      request.reject(new Error("Server down"));
      await mutation?.catch(() => {
        // Expected — assertion is on the restored cache below.
      });
    });

    expect(
      queryClient
        .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
        ?.nodes.map((node) => node.root.id)
    ).toEqual([A_ID, B_ID]);
  });

  it("does not read or write departed-scope trees while cancellation settles", async () => {
    const seed = makeTree(makeNode(A_ID, "A", 1000), makeNode(B_ID, "B", 2000));
    const { queryClient, wrapper } = setupScoped(seed);
    const cancellation = deferred<void>();
    const cancel = vi
      .spyOn(queryClient, "cancelQueries")
      .mockReturnValue(cancellation.promise);
    const read = vi.spyOn(queryClient, "getQueriesData");
    const write = vi.spyOn(queryClient, "setQueriesData");
    mockApiClient.post.mockResolvedValue({ moved: true, newSortOrder: 0 });
    const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
      wrapper,
    });
    let mutation: Promise<MoveArtifactResponse> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        artifactId: B_ID,
        position: MovePosition.Top,
      });
    });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    // Leave A resident: the render-time scope changes before the shell effect clears it.
    setQueryCacheScope(queryClient, ORG_B);
    await act(async () => {
      cancellation.resolve();
      await mutation;
    });
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toBeUndefined();
    setQueryCacheScope(queryClient, ORG_A);
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toEqual(seed);
  });

  it.each([C_ID, B_ID])(
    "does not roll back later successful move %s when an older move rejects",
    async (laterArtifactId) => {
      const seed = makeTree(
        makeNode(A_ID, "A", 1000),
        makeNode(B_ID, "B", 2000),
        makeNode(C_ID, "C", 3000)
      );
      const { queryClient, wrapper } = setupScoped(seed);
      queryClient.setQueryData(projectTreeKeys.withDetails(PROJECT_ID), seed);
      const first = deferred<MoveArtifactResponse>();
      const second = deferred<MoveArtifactResponse>();
      mockApiClient.post
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const { result } = renderHook(() => useMoveArtifact(PROJECT_ID), {
        wrapper,
      });
      let older: Promise<MoveArtifactResponse> | undefined;
      let newer: Promise<MoveArtifactResponse> | undefined;
      act(() => {
        older = result.current.mutateAsync({
          artifactId: B_ID,
          position: MovePosition.Top,
        });
      });
      await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
      expect(
        queryClient
          .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
          ?.nodes.map((node) => node.root.id)
      ).toEqual([B_ID, A_ID, C_ID]);
      act(() => {
        newer = result.current.mutateAsync({
          artifactId: laterArtifactId,
          position: MovePosition.Top,
        });
      });
      await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(2));
      await act(async () => {
        second.resolve({ moved: true, newSortOrder: 0 });
        await newer;
      });
      const later = queryClient.getQueryData<ProjectTreeResponse>(
        projectTreeKeys.detail(PROJECT_ID)
      );
      const expectedOrder =
        laterArtifactId === C_ID ? [C_ID, B_ID, A_ID] : [B_ID, A_ID, C_ID];
      expect(later?.nodes.map((node) => node.root.id)).toEqual(expectedOrder);
      await act(async () => {
        first.reject(new Error("Older move failed"));
        await older?.catch(() => {
          /* Expected rejection; inspect the surviving order below. */
        });
      });
      expect(queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))).toBe(
        later
      );
      expect(
        queryClient
          .getQueryData<ProjectTreeResponse>(
            projectTreeKeys.withDetails(PROJECT_ID)
          )
          ?.nodes.map((node) => node.root.id)
      ).toEqual(expectedOrder);
    }
  );
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the Promise executor below.
  };
  let reject: (reason: Error) => void = () => {
    // Replaced synchronously by the Promise executor below.
  };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useProjectTree", () => {
  it("serializes contributor filters and isolates the query cache key", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const filters = { contributorUserId: CONTRIBUTOR_USER_ID };
    const response = makeTree(makeNode(A_ID, "A", 1000));
    mockApiClient.get.mockResolvedValue(response);

    const { result } = renderHook(
      () => useProjectTree(PROJECT_ID, { filters }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM}=${CONTRIBUTOR_USER_ID}`
    );
    expect(queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))).toBe(
      undefined
    );
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID, filters))
    ).toEqual(response);
  });

  it("serializes hierarchy child-page filters onto the request", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    mockApiClient.get.mockResolvedValue(makeTree());

    renderHook(
      () =>
        useProjectTree(PROJECT_ID, {
          filters: {
            childCursor: "25",
            childLimit: 25,
            hierarchy: true,
            parentArtifactId: A_ID,
          },
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_HIERARCHY_PARAM}=true&${PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM}=${A_ID}&${PROJECT_TREE_CHILD_CURSOR_PARAM}=25&${PROJECT_TREE_CHILD_LIMIT_PARAM}=25`
      );
    });
  });

  it("rejects malformed tree payloads instead of caching plausible partial data", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    mockApiClient.get.mockResolvedValue({
      externalParents: [],
      nodes: [{ children: [], root: { id: "" } }],
    });

    const { result } = renderHook(() => useProjectTree(PROJECT_ID), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toBeUndefined();
  });
});

describe("useProjectTreeWithDetails", () => {
  it("fetches the detail-enriched tree from the include=details endpoint", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const response: ProjectTreeDetailsResponse = makeTree(
      makeNode(A_ID, "A", 1000)
    );
    mockApiClient.get.mockResolvedValue(response);

    const { result } = renderHook(() => useProjectTreeWithDetails(PROJECT_ID), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}`
    );
    expect(
      queryClient.getQueryData(projectTreeKeys.withDetails(PROJECT_ID))
    ).toEqual(response);
  });

  it("requests the hierarchy revision with the detailed tree and separates its cache", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    mockApiClient.get.mockResolvedValue({
      ...makeTree(),
      hierarchyRevision: "rendered-v1",
      projectVersion: "documents-v1",
    });
    renderHook(
      () =>
        useProjectTreeWithDetails(PROJECT_ID, {
          filters: { includeHierarchyRevision: true },
        }),
      { wrapper }
    );
    await waitFor(() => {
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_HIERARCHY_REVISION_PARAM}=true`
      );
    });
    expect(
      projectTreeKeys.withDetails(PROJECT_ID, {
        includeHierarchyRevision: true,
      })
    ).not.toEqual(projectTreeKeys.withDetails(PROJECT_ID));
  });
});

describe("useProjectTreeExpansionBatch", () => {
  it("follows every opaque cursor for each expanded parent", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const hierarchy = {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
        mutationVersion: "version-4",
      },
      childCount: 2,
      contractVersion: PROJECT_TREE_CONTRACT_VERSION,
      diagnostics: [],
      diagnosticsComplete: true,
      parentArtifactId: A_ID,
    };
    const firstPage: ProjectTreeDetailsResponse = {
      ...makeTree(makeNode(B_ID, "B", 1000)),
      hierarchy: { ...hierarchy, nextCursor: "opaque-cursor" },
    };
    const secondPage: ProjectTreeDetailsResponse = {
      ...makeTree(makeNode(C_ID, "C", 2000)),
      hierarchy,
    };
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const { result } = renderHook(
      () => useProjectTreeExpansionBatch(PROJECT_ID, [A_ID, A_ID]),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current[0]?.data).toEqual([firstPage, secondPage]);
    });
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      1,
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_HIERARCHY_PARAM}=true&${PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM}=${A_ID}`
    );
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      2,
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_HIERARCHY_PARAM}=true&${PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM}=${A_ID}&${PROJECT_TREE_CHILD_CURSOR_PARAM}=opaque-cursor`
    );
    expect(result.current).toHaveLength(1);
  });
});

describe("useProjectTree root pagination", () => {
  it("returns one bounded root page without draining its next cursor", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const hierarchy = {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
        mutationVersion: "version-4",
        rootPaging: true,
      },
      contractVersion: PROJECT_TREE_CONTRACT_VERSION,
      diagnostics: [],
      diagnosticsComplete: true,
    };
    const firstPage: ProjectTreeDetailsResponse = {
      ...makeTree(makeNode(A_ID, "A", 1000)),
      hierarchy: { ...hierarchy, rootNextCursor: "root-cursor" },
      truncation: {
        anchorsIncluded: 1,
        anchorsMatchedAtLeast: 2,
        reasons: [TreeTruncationReason.AnchorCap],
      },
    };
    mockApiClient.get.mockResolvedValueOnce(firstPage);

    const { result } = renderHook(
      () =>
        useProjectTreeWithDetails(PROJECT_ID, {
          filters: { hierarchy: true },
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.data).toEqual(firstPage);
    });
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_HIERARCHY_PARAM}=true`
    );
    expect(result.current.data?.truncation?.reasons).toContain(
      TreeTruncationReason.AnchorCap
    );
    expect(result.current.data?.hierarchy?.rootNextCursor).toBe("root-cursor");
  });

  it("keeps the first 500 roots partial until the next root page is requested", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const hierarchy = {
      capabilities: {
        childPaging: true,
        exactPlacement: true,
        maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
        mutationVersion: "version-4",
        rootPaging: true,
      },
      contractVersion: PROJECT_TREE_CONTRACT_VERSION,
      diagnostics: [],
      diagnosticsComplete: false,
    };
    const firstNodes = Array.from({ length: 500 }, (_, index) =>
      makeNode(
        `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
        `Root ${index}`,
        index
      )
    );
    const firstPage: ProjectTreeDetailsResponse = {
      ...makeTree(...firstNodes),
      hierarchy: { ...hierarchy, rootNextCursor: "root-cursor" },
      truncation: {
        anchorsIncluded: 500,
        anchorsMatchedAtLeast: 501,
        reasons: [TreeTruncationReason.AnchorCap],
      },
    };
    const lastNode = makeNode(C_ID, "Root 501", 501);
    const secondPage: ProjectTreeDetailsResponse = {
      ...makeTree(lastNode),
      hierarchy,
    };
    mockApiClient.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const { result } = renderHook(
      () => useProjectTreeRootPages(PROJECT_ID, { enabled: true }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(500));
    expect(result.current.data?.hierarchy?.rootNextCursor).toBe("root-cursor");
    expect(result.current.data?.truncation?.reasons).toContain(
      TreeTruncationReason.AnchorCap
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(501));
    expect(result.current.data?.nodes.at(-1)?.root.id).toBe(C_ID);
    expect(result.current.data?.hierarchy?.rootNextCursor).toBeUndefined();
    expect(result.current.data?.truncation).toBeUndefined();
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      2,
      `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_HIERARCHY_PARAM}=true&${PROJECT_TREE_ROOT_CURSOR_PARAM}=root-cursor`
    );
  });
});

describe("useProjectTreeWithDetails — bounded read (ISS-5307)", () => {
  it("sends the root bound on the wire when a limit is supplied", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    const response: ProjectTreeDetailsResponse = makeTree(
      makeNode(A_ID, "A", 1000)
    );
    mockApiClient.get.mockResolvedValue(response);

    renderHook(
      () => useProjectTreeWithDetails(PROJECT_ID, { filters: { limit: 25 } }),
      { wrapper }
    );

    // The bound must reach the SERVER — a limit the client keeps to itself
    // would leave the payload exactly as unbounded as before.
    await waitFor(() => {
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_LIMIT_PARAM}=25`
      );
    });
  });

  it("omits the parameter entirely when no limit is supplied", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    mockApiClient.get.mockResolvedValue(makeTree());

    renderHook(() => useProjectTreeWithDetails(PROJECT_ID), { wrapper });

    await waitFor(() => {
      expect(mockApiClient.get).toHaveBeenCalledWith(
        expect.not.stringContaining(PROJECT_TREE_LIMIT_PARAM)
      );
    });
  });

  it("caches a bounded read separately from an unbounded one", () => {
    // Two different node sets under one key would let a bounded read serve the
    // page that asked for everything, or the reverse.
    expect(projectTreeKeys.withDetails(PROJECT_ID, { limit: 25 })).not.toEqual(
      projectTreeKeys.withDetails(PROJECT_ID)
    );
    expect(projectTreeKeys.withDetails(PROJECT_ID, { limit: 25 })).not.toEqual(
      projectTreeKeys.withDetails(PROJECT_ID, { limit: 50 })
    );
  });

  it("separates every hierarchy and child-page response shape", () => {
    const legacy = projectTreeKeys.withDetails(PROJECT_ID);
    const hierarchy = projectTreeKeys.withDetails(PROJECT_ID, {
      hierarchy: true,
    });
    const firstChildPage = projectTreeKeys.withDetails(PROJECT_ID, {
      childLimit: 25,
      hierarchy: true,
      parentArtifactId: A_ID,
    });
    const nextChildPage = projectTreeKeys.withDetails(PROJECT_ID, {
      childCursor: "opaque-cursor",
      childLimit: 25,
      hierarchy: true,
      parentArtifactId: A_ID,
    });

    expect(
      new Set(
        [legacy, hierarchy, firstChildPage, nextChildPage].map((key) =>
          JSON.stringify(key)
        )
      )
    ).toHaveProperty("size", 4);
    expect(firstChildPage).not.toEqual(
      projectTreeKeys.withDetails(PROJECT_ID, {
        childLimit: 50,
        hierarchy: true,
        parentArtifactId: A_ID,
      })
    );
    expect(firstChildPage).not.toEqual(
      projectTreeKeys.withDetails(PROJECT_ID, {
        childLimit: 25,
        hierarchy: true,
        parentArtifactId: B_ID,
      })
    );
  });

  it("keeps a bounded query under the detail-key prefix the move mutation invalidates", () => {
    const bounded = projectTreeKeys.withDetails(PROJECT_ID, { limit: 25 });
    const invalidationPrefix = projectTreeKeys.detail(PROJECT_ID);

    // Stack-rank reorder invalidates by prefix; a bounded query outside that
    // prefix would keep rendering the pre-move order after a drag.
    expect(bounded.slice(0, invalidationPrefix.length)).toEqual(
      invalidationPrefix
    );
  });
});

describe("useProjectTreeWithDetails — category-scoped read", () => {
  it("sends category AND limit on the wire so the server filters before it bounds", async () => {
    const queryClient = createInspectableQueryClient();
    const wrapper = createWrapperWithClient(queryClient);
    mockApiClient.get.mockResolvedValue(makeTree());

    renderHook(
      () =>
        useProjectTreeWithDetails(PROJECT_ID, {
          filters: { category: ProjectTreeCategory.Prds, limit: 500 },
        }),
      { wrapper }
    );

    // The category must reach the SERVER: a client-side filter over a bounded
    // read is the filter-after-paginate defect this parameter fixes.
    await waitFor(() => {
      expect(mockApiClient.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/tree?${PROJECT_TREE_INCLUDE_PARAM}=${ProjectTreeInclude.Details}&${PROJECT_TREE_LIMIT_PARAM}=500&${PROJECT_TREE_CATEGORY_PARAM}=${ProjectTreeCategory.Prds}`
      );
    });
  });

  it("caches each category separately from the unfiltered tree and each other", () => {
    // A filtered population and the whole tree are different node sets; one
    // key would let the PRDs tab render the branches read, or the All tab a
    // category subset.
    const prds = projectTreeKeys.withDetails(PROJECT_ID, {
      category: ProjectTreeCategory.Prds,
      limit: 500,
    });
    expect(prds).not.toEqual(projectTreeKeys.withDetails(PROJECT_ID));
    expect(prds).not.toEqual(
      projectTreeKeys.withDetails(PROJECT_ID, {
        category: ProjectTreeCategory.Branches,
        limit: 500,
      })
    );
  });

  it("keeps a category query under the detail-key prefix the move mutation invalidates", () => {
    const category = projectTreeKeys.withDetails(PROJECT_ID, {
      category: ProjectTreeCategory.Plans,
      limit: 500,
    });
    const invalidationPrefix = projectTreeKeys.detail(PROJECT_ID);

    expect(category.slice(0, invalidationPrefix.length)).toEqual(
      invalidationPrefix
    );
  });
});
