import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { ProjectTreeCategory } from "@repo/api/src/types/project-tree";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectArtifactTreeReads } from "../use-project-artifact-tree-reads";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  flatRead: vi.fn(),
  rootPages: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTreeRootPages: (...args: unknown[]) => mocks.rootPages(...args),
  useProjectTreeWithDetails: (...args: unknown[]) => mocks.flatRead(...args),
}));
vi.mock("@repo/app/documents/lib/artifact-row-adapter", () => ({
  collectDocumentRowsFromTree: (...args: unknown[]) => mocks.collect(...args),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => true,
  useFeatureFlagGate: (key: string) => ({
    enabled: key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY,
    isReady: true,
  }),
}));

const HIERARCHY_TREE = {
  nodes: [{ root: { id: "ISS-1" }, children: [] }],
  externalParents: [],
};
const FLAT_ISSUES_TREE = {
  nodes: [
    { root: { id: "ISS-1" }, children: [] },
    { root: { id: "ISS-3", depth: 5 }, children: [] },
  ],
  externalParents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rootPages.mockReturnValue({
    data: HIERARCHY_TREE,
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isLoading: false,
    loadMore: vi.fn(),
    refetch: vi.fn(),
    refetchMerged: vi.fn(),
  });
  mocks.flatRead.mockImplementation(
    (_projectId: string, options: { filters?: { category?: string } }) => ({
      data: options.filters?.category ? FLAT_ISSUES_TREE : undefined,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    })
  );
  mocks.collect.mockImplementation(
    (tree?: typeof FLAT_ISSUES_TREE) =>
      tree?.nodes.map((node) => ({ id: node.root.id })) ?? []
  );
});

describe("Project Detail category read", () => {
  it("keeps a depth-five issue in flat Issues when hierarchy is enabled", () => {
    const { result } = renderHook(() =>
      useProjectArtifactTreeReads({
        filterCategory: "features",
        isOverview: false,
        isPaginationEnabled: false,
        isPaginationFlagReady: true,
        projectId: "project-1",
        rowProject: null,
      })
    );

    expect(result.current.tabDocuments.map((row) => row.id)).toEqual([
      "ISS-1",
      "ISS-3",
    ]);
    const categoryRead = mocks.flatRead.mock.calls.find(
      ([_id, options]) =>
        options.filters?.category === ProjectTreeCategory.Features
    );
    expect(categoryRead?.[1]).toEqual({
      enabled: true,
      filters: { category: ProjectTreeCategory.Features },
    });
    expect(mocks.rootPages).toHaveBeenCalledTimes(1);
    expect(result.current.hasMoreRootPages).toBe(false);
  });
});
