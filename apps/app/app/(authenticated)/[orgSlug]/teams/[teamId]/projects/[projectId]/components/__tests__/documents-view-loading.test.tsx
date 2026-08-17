import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The loading branch under test (documents-view.tsx `isLoading && !hasAnyItems`)
// depends only on `documents`/`treeData` and `isLoading`. Everything below the
// selection is mocked to markers so this test asserts the branch decision, not
// the row/table internals — which have their own coverage.
const mocks = vi.hoisted(() => ({
  useProjectTree: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useSortParams: vi.fn(),
  useGroupExpansion: vi.fn(),
  useMergeDocuments: vi.fn(),
  useStackRanking: vi.fn(),
  useContextGroupExpansion: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTree: mocks.useProjectTree,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));
vi.mock("@repo/app/shared/hooks/use-group-expansion", () => ({
  useGroupExpansion: mocks.useGroupExpansion,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useMergeDocuments: mocks.useMergeDocuments,
}));
vi.mock("../../hooks/use-stack-ranking", () => ({
  useStackRanking: mocks.useStackRanking,
}));
vi.mock("../../hooks/use-context-group-expansion", () => ({
  useContextGroupExpansion: mocks.useContextGroupExpansion,
}));
vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

// Leaf render surfaces → markers so the test needs no navigation/DnD providers.
vi.mock("@repo/app/documents/components/table/document-table-skeleton", () => ({
  DocumentTableSkeleton: () => <div data-testid="skeleton" />,
}));
vi.mock("@repo/app/documents/components/table/documents-empty-state", () => ({
  DocumentsEmptyState: () => <div data-testid="empty-state" />,
}));
vi.mock("@repo/app/documents/components/table/table-header", () => ({
  DocumentTableHeader: () => <div data-testid="table-header" />,
}));
// ISS-4761: spread the REAL module so `getDocumentTableColumnCount` keeps the
// production arithmetic rather than a hand-copied stub that could silently
// diverge from it.
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/table/document-row")
    >()),
    DocumentRow: () => <div data-testid="document-row" />,
    getDocumentRowGridTemplateColumns: () => "1fr",
  })
);
vi.mock("@repo/app/documents/components/table/tree-group-rows", () => ({
  TreeGroupRows: () => <div data-testid="tree-group-rows" />,
}));

import { DocumentsView } from "../documents-view";

const BASE_PROPS = {
  filterText: "",
  filterCategory: "all" as const,
  visibleColumns: [DocumentColumn.Type],
  storageKey: "test",
};

function emptyTree(): ProjectTreeResponse {
  return { nodes: [], externalParents: [] };
}

function treeWithBranch(): ProjectTreeResponse {
  return {
    nodes: [
      {
        root: {
          id: "branch-1",
          type: ArtifactType.Branch,
          title: "feat/x",
        },
        children: [],
      },
    ],
    externalParents: [],
  } as unknown as ProjectTreeResponse;
}

describe("DocumentsView loading branch (FEA-3938)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      sortBy: null,
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: vi.fn(),
    });
    mocks.useMergeDocuments.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useStackRanking.mockReturnValue({
      rankInteractionMode: "disabled",
      isDndEnabled: false,
      rankItemIds: [],
      isRankableMenuItem: () => false,
      moveToTop: vi.fn(),
      moveToBottom: vi.fn(),
      handleDragEnd: vi.fn(),
    });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: vi.fn(),
    });
  });

  it("renders the skeleton (not the empty state) while loading with no documents and no tree rows", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[]}
        isLoading={true}
        treeData={emptyTree()}
      />
    );

    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders the table (not the skeleton) while loading when the documents list already has rows", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[{ id: "doc-1" } as never]}
        isLoading={true}
        treeData={emptyTree()}
      />
    );

    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("table-header")).toBeTruthy();
  });

  it("renders the table (not the skeleton) while loading when only the tree has renderable rows (branch-only user)", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[]}
        isLoading={true}
        treeData={treeWithBranch()}
      />
    );

    // A branch-only user has zero documents but a non-empty tree: the loading
    // branch must not win, so the header/table renders instead of the skeleton.
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(screen.getByTestId("table-header")).toBeTruthy();
  });
});
