import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import {
  ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS,
  ASSIGNED_ARTIFACT_TREE_PATH,
  type ProjectTreeResponse,
  type TreeNode,
} from "@repo/api/src/types/project-tree";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectTreeKeys } from "../project-tree-keys";
import {
  assignedArtifactTreeKeys,
  assignedArtifactTreePath,
  useAssignedArtifactTree,
} from "../use-assigned-artifact-tree";

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
const NODE_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

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
      wrapper: createWrapperWithClient(queryClient),
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
      { wrapper: createWrapperWithClient(queryClient) }
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
      wrapper: createWrapperWithClient(queryClient),
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
      wrapper: createWrapperWithClient(queryClient),
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
      wrapper: createWrapperWithClient(queryClient),
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
      wrapper: createWrapperWithClient(queryClient),
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
      wrapper: createWrapperWithClient(queryClient),
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
 * FEA-1651 headline acceptance criterion: the tree read is ONE request, however
 * many projects the assignee has work in. The fan-out it replaced was deleted
 * with `my-tasks-own-work-tree` (ISS-12637), so this is the surviving half of
 * the before/after pair — the count claim itself, not a comparison.
 */
describe("assigned-artifact tree request count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires exactly one request through the assigned-tree endpoint", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(makeTree(makeNode(NODE_ID)));

    const { result } = renderHook(() => useAssignedArtifactTree(ASSIGNEE_ID), {
      wrapper: createWrapperWithClient(queryClient),
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

describe("assignedArtifactTreePath facets (ISS-10472)", () => {
  const PAGED = { limit: 50, offset: 0, search: "" } as const;

  function paramsOf(request: Parameters<typeof assignedArtifactTreePath>[1]) {
    return new URLSearchParams(
      assignedArtifactTreePath(ASSIGNEE_ID, request).split("?")[1]
    );
  }

  it("appends no facet params when none are selected", () => {
    const params = paramsOf({ ...PAGED });

    expect(params.has("status")).toBe(false);
    expect(params.has("priority")).toBe(false);
    expect(params.has("tagId")).toBe(false);
    expect(params.has("favoritesOnly")).toBe(false);
    expect(params.has("hideCompletedItems")).toBe(false);
    expect(params.has("dateField")).toBe(false);
  });

  // REPEATED occurrences, not a comma-joined list: that is the multi-value
  // shape the route parses, and a joined list would arrive as one element it
  // cannot decode. Two values, because one cannot tell the two apart.
  it("repeats a multi-value facet once per value", () => {
    const params = paramsOf({
      ...PAGED,
      facets: {
        status: [IssueStatus.Todo, IssueStatus.Done],
        tagId: ["tag-a", "tag-b"],
      },
    });

    expect(params.getAll("status")).toEqual([
      IssueStatus.Todo,
      IssueStatus.Done,
    ]);
    expect(params.getAll("tagId")).toEqual(["tag-a", "tag-b"]);
  });

  it("sends an empty facet array as no occurrence at all", () => {
    // `?status=` is a value that failed to spell itself, and the route 400s on
    // it rather than widening to the whole population.
    const params = paramsOf({ ...PAGED, facets: { status: [] } });

    expect(params.has("status")).toBe(false);
  });

  it("omits a false boolean facet, which narrows nothing just as omission does", () => {
    const params = paramsOf({
      ...PAGED,
      facets: { favoritesOnly: false, hideCompletedItems: true },
    });

    expect(params.has("favoritesOnly")).toBe(false);
    expect(params.get("hideCompletedItems")).toBe("true");
  });

  it("sends the date window as ISO instants", () => {
    const params = paramsOf({
      ...PAGED,
      facets: {
        dateField: ArtifactDateField.UpdatedAt,
        dateFrom: new Date("2026-07-23T12:00:00.000Z"),
        dateTo: new Date("2026-10-21T12:00:00.000Z"),
      },
    });

    expect(params.get("dateField")).toBe(ArtifactDateField.UpdatedAt);
    expect(params.get("dateFrom")).toBe("2026-07-23T12:00:00.000Z");
    expect(params.get("dateTo")).toBe("2026-10-21T12:00:00.000Z");
  });

  // All three or none. The route reads them independently, so a field with one
  // bound would narrow on an end the caller never chose.
  it("sends no window at all when a bound is missing", () => {
    const params = paramsOf({
      ...PAGED,
      facets: {
        dateField: ArtifactDateField.UpdatedAt,
        dateFrom: new Date("2026-07-23T12:00:00.000Z"),
      },
    });

    expect(params.has("dateField")).toBe(false);
    expect(params.has("dateFrom")).toBe(false);
  });

  it("keys the cache on the facets, so one selection cannot serve another", () => {
    const base = assignedArtifactTreeKeys.page(ASSIGNEE_ID, { ...PAGED });
    const narrowed = assignedArtifactTreeKeys.page(ASSIGNEE_ID, {
      ...PAGED,
      facets: { status: [IssueStatus.Todo] },
    });

    expect(narrowed).not.toEqual(base);
  });
});

describe("assigned-tree tag-facet cap (marisolashgrove, PR #9091)", () => {
  // The route 400s past this bound, which on a server-paged board is the
  // load-failed state — so a persisted selection wider than the cap is held to
  // it rather than sent to be refused.
  const OVER_CAP = Array.from(
    { length: ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS + 7 },
    (_unused, index) =>
      `0a0a0a0a-0a0a-7a0a-8a0a-${String(index).padStart(12, "0")}`
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.get.mockResolvedValue(makeTree());
  });

  it("sends no more tag values than the route accepts", async () => {
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          facets: { tagId: OVER_CAP },
          paging: { limit: 50, offset: 0 },
        }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    const requested = mockApiClient.get.mock.calls.at(-1)?.[0] as string;
    const sent = new URLSearchParams(requested.split("?")[1]).getAll("tagId");
    expect(sent).toHaveLength(ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS);
    // The kept values are the head of the selection, not an arbitrary subset.
    expect(sent).toEqual(OVER_CAP.slice(0, ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS));
  });

  it("leaves a selection inside the cap whole", async () => {
    const inside = OVER_CAP.slice(0, 3);
    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          facets: { tagId: inside },
          paging: { limit: 50, offset: 0 },
        }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    const requested = mockApiClient.get.mock.calls.at(-1)?.[0] as string;
    expect(
      new URLSearchParams(requested.split("?")[1]).getAll("tagId")
    ).toEqual(inside);
  });
});

describe("assigned-tree paged response shapes (ISS-10472)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A SECTION-paged envelope, exactly as the route emits one: variable-height
   * pages have no row offset, so `offset` is OMITTED rather than sent as 0.
   */
  function sectionPagedTree() {
    return {
      ...makeTree(makeNode(NODE_ID)),
      page: {
        limit: 50,
        ordering: ArtifactSectionOrdering.Vocabulary,
        rowsBefore: 0,
        sections: [{ continued: false, rootIds: [NODE_ID], total: 1 }],
        total: 1,
        totalPages: 1,
      },
    };
  }

  // The regression this exists for: declaring `offset` required rejected every
  // grouped 200, so turning on Group by put the board in its error state. A
  // parse failure surfaces as `isError`, never as a thrown test, so asserting
  // the DATA is what catches it.
  it("accepts a grouped page whose envelope omits the row offset", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(sectionPagedTree());

    const { result } = renderHook(
      () =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          grouping: {
            groupBy: ArtifactGroupByMode.Status,
            pageIndex: 0,
          },
          paging: { limit: 50, offset: 0 },
        }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.page?.sections).toHaveLength(1);
    expect(result.current.data?.page?.offset).toBeUndefined();
  });

  // The row-paged half, so the optional `offset` above cannot be read as "this
  // field no longer matters": an ungrouped read still sends it and the footer
  // anchors its range on it.
  it("still accepts a row-paged page that sends the offset", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue({
      ...makeTree(makeNode(NODE_ID)),
      page: { limit: 50, offset: 50, total: 51 },
    });

    const { result } = renderHook(
      () =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          paging: { limit: 50, offset: 50 },
        }),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.page?.offset).toBe(50);
  });

  // The grouped request must carry the facets too. Every other facet case in
  // this file takes the row-offset arm, so moving `appendFacetParams` inside
  // that arm would drop every facet on a grouped board with nothing red.
  it("sends facets on a grouped request, not only a row-paged one", () => {
    const params = new URLSearchParams(
      assignedArtifactTreePath(ASSIGNEE_ID, {
        facets: { status: [IssueStatus.Todo] },
        groupBy: ArtifactGroupByMode.Status,
        limit: 50,
        pageIndex: 2,
        search: "",
      }).split("?")[1]
    );

    expect(params.get("groupBy")).toBe(ArtifactGroupByMode.Status);
    expect(params.get("pageIndex")).toBe("2");
    expect(params.has("offset")).toBe(false);
    expect(params.getAll("status")).toEqual([IssueStatus.Todo]);
  });
});

describe("paged tree placeholder (ISS-10472)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function pagedTree(id: string, offset: number) {
    return {
      ...makeTree(makeNode(id)),
      page: { limit: 50, offset, total: 100 },
    };
  }

  const OTHER_NODE_ID = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

  // Without this, turning a page reports `isLoading`, the board's
  // `isTotalSettled` goes false, and the footer unmounts mid-turn — taking the
  // pagination control the user just clicked.
  it("keeps the previous page mounted across a page turn", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(pagedTree(NODE_ID, 0));

    const { result, rerender } = renderHook(
      ({ offset }: { offset: number }) =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          paging: { limit: 50, offset },
        }),
      {
        initialProps: { offset: 0 },
        wrapper: createWrapperWithClient(queryClient),
      }
    );
    await waitFor(() => {
      expect(result.current.data?.page?.offset).toBe(0);
    });

    let release: (value: unknown) => void = () => undefined;
    mockApiClient.get.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    rerender({ offset: 50 });

    // Page 1's rows stand in while page 2 is in flight, and crucially the read
    // does NOT report itself as loading — that flag is what unmounted the
    // footer.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.page?.offset).toBe(0);

    release(pagedTree(OTHER_NODE_ID, 50));
    await waitFor(() => {
      expect(result.current.data?.page?.offset).toBe(50);
    });
  });

  // The other half, and the reason the placeholder is scoped: a page from a
  // different POPULATION is not an honest stand-in. Reusing it would render the
  // old narrowing's rows under a footer about to state a different total.
  it("drops the previous page when the narrowing changes", async () => {
    const queryClient = createTestQueryClient();
    mockApiClient.get.mockResolvedValue(pagedTree(NODE_ID, 0));

    const { result, rerender } = renderHook(
      ({ search }: { search: string }) =>
        useAssignedArtifactTree(ASSIGNEE_ID, {
          paging: { limit: 50, offset: 0 },
          search,
        }),
      {
        initialProps: { search: "" },
        wrapper: createWrapperWithClient(queryClient),
      }
    );
    await waitFor(() => {
      expect(result.current.data?.page?.offset).toBe(0);
    });

    mockApiClient.get.mockReturnValue(new Promise(() => undefined));
    rerender({ search: "narrowed" });

    expect(result.current.data).toBeNull();
  });
});
