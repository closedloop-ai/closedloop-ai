import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type MoveArtifactRequest,
  type MoveArtifactResponse,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import {
  PROJECT_TREE_INCLUDE_PARAM,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeResponse,
  type TreeNode,
} from "@repo/api/src/types/project-tree";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMoveToTree,
  projectTreeKeys,
  useMoveArtifact,
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

function makeNode(id: string, name: string, sortOrder: number): TreeNode {
  const artifact = {
    id,
    name,
    sortOrder,
    type: ArtifactType.Document,
  } as unknown as Artifact;
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
});
