import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_PATH,
  type ProjectTreeResponse,
  type TreeNode,
} from "@repo/api/src/types/project-tree";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignedArtifactTreeKeys,
  assignedArtifactTreePath,
  useAssignedArtifactTree,
} from "../use-assigned-artifact-tree";
import { useMergedProjectTrees } from "../use-merged-project-trees";
import { projectTreeKeys } from "../use-project-tree";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const ASSIGNEE_ID = "11111111-1111-7111-8111-111111111111";
const PROJECT_A = "22222222-2222-7222-8222-222222222222";
const PROJECT_B = "33333333-3333-7333-8333-333333333333";
const PROJECT_C = "44444444-4444-7444-8444-444444444444";
const NODE_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function makeNode(id: string): TreeNode {
  const artifact = {
    id,
    name: id,
    sortOrder: 1000,
    type: ArtifactType.Document,
  } as unknown as Artifact;
  return { root: artifact, children: [] };
}

function makeTree(...nodes: TreeNode[]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

describe("useAssignedArtifactTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the merged assignee tree from the single assigned-tree endpoint", async () => {
    const queryClient = createTestQueryClient();
    const response = makeTree(makeNode(NODE_ID));
    mockApiClient.get.mockResolvedValue(response);

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `${ASSIGNED_ARTIFACT_TREE_PATH}?${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`
    );
    expect(assignedArtifactTreePath(ASSIGNEE_ID)).toBe(
      `${ASSIGNED_ARTIFACT_TREE_PATH}?${ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM}=${ASSIGNEE_ID}`
    );
    expect(
      queryClient.getQueryData(assignedArtifactTreeKeys.detail(ASSIGNEE_ID))
    ).toEqual(response);
  });

  it("issues no request and reports null data when disabled", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(makeTree());

    const { result } = renderHook(
      () => useAssignedArtifactTree(ASSIGNEE_ID, { enabled: false }),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("issues no request without an assignee to scope to", async () => {
    const queryClient = createTestQueryClient();

    const { result } = renderHook(() => useAssignedArtifactTree(null), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it("surfaces a failed read as an error rather than an empty tree", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeNull();
  });

  it("rejects a malformed 200 instead of caching a body the board would crash on", async () => {
    const queryClient = createTestQueryClient();
    // A 200 whose body lost its arrays — a deploy skew or a proxy that
    // swallowed the payload. Cached unvalidated, this crashes the board on
    // `treeData.nodes.filter`.
    mockApiClient.get.mockResolvedValue({});

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeNull();
    expect(
      queryClient.getQueryData(assignedArtifactTreeKeys.detail(ASSIGNEE_ID))
    ).toBeUndefined();
  });

  it("accepts a payload carrying server fields this client does not know", async () => {
    const queryClient = createTestQueryClient();
    // Version skew in the additive direction must NOT be rejected.
    const response = {
      ...makeTree(makeNode(NODE_ID)),
      truncation: {
        anchorsIncluded: 500,
        anchorsMatchedAtLeast: 501,
        reasons: ["anchor_cap"],
      },
      someFutureField: true,
    };
    mockApiClient.get.mockResolvedValue(response);

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(response);
    });
    expect(result.current.isError).toBe(false);
  });

  it("nests its cache key under the canonical project-tree prefix the mutations invalidate", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(makeTree(makeNode(NODE_ID)));

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    // Exactly what `use-artifact-links` / `use-tags` do after a document edit or
    // a reparent. If this key sat outside the prefix, the cached tree would
    // still be fresh here and My Tasks would render stale rows.
    queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });

    expect(
      queryClient.getQueryState(assignedArtifactTreeKeys.detail(ASSIGNEE_ID))
        ?.isInvalidated
    ).toBe(true);
  });
});

/**
 * FEA-1651 headline acceptance criterion: the tree read is ONE request, not one
 * per project. Both hooks are driven here against the same counting client so
 * the before/after request count is asserted side by side — this doubles as the
 * permanent revert-proof for the fan-out the endpoint replaces.
 */
describe("assigned-artifact tree request count vs. the per-project fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires one request per project through the fan-out it replaces", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(makeTree(makeNode(NODE_ID)));

    const { result } = renderHook(
      () => useMergedProjectTrees([PROJECT_A, PROJECT_B, PROJECT_C]),
      { wrapper: createWrapper(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockApiClient.get).toHaveBeenCalledTimes(3);
  });

  it("fires exactly one request through the assigned-tree endpoint", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(makeTree(makeNode(NODE_ID)));

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockApiClient.get).toHaveBeenCalledWith(
      assignedArtifactTreePath(ASSIGNEE_ID)
    );
  });
});
