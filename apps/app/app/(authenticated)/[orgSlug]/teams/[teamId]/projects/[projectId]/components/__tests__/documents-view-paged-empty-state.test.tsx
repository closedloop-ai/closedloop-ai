import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This test exercises the ISS-4466 `hasUnpagedItems` prop: when the caller pages
// upstream (My Tasks), `documents`/`treeData` here are only the current page's
// subset, so a zero-match filter would hand this view two empty sources. The
// unpaged signal must keep the "no match / Clear filters" state from collapsing
// into the truly-empty "No artifacts yet" state. `DocumentsEmptyState` is left
// UNMOCKED so the real empty-state variant is asserted.
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

describe("DocumentsView paged empty-vs-filtered state (ISS-4466)", () => {
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

  it("shows the no-match state with Clear filters (not 'No artifacts yet') when the paged subset is empty but the unpaged board has items", () => {
    const onClearFilters = vi.fn();
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[]}
        // Board is NON-empty upstream — the current page just filtered to zero.
        hasUnpagedItems={true}
        isFilterActive={true}
        onClearFilters={onClearFilters}
        treeData={emptyTree()}
      />
    );

    expect(screen.getByText("No items match your filters")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    expect(screen.queryByText("No artifacts yet")).toBeNull();
  });

  it("shows the truly-empty 'No artifacts yet' state when the unpaged board is genuinely empty", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[]}
        hasUnpagedItems={false}
        isFilterActive={false}
        treeData={emptyTree()}
      />
    );

    expect(screen.getByText("No artifacts yet")).toBeTruthy();
    expect(screen.queryByText("No items match your filters")).toBeNull();
  });

  it("falls back to the local sources for unpaged callers that omit hasUnpagedItems (truly empty)", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={[]}
        isFilterActive={false}
        treeData={emptyTree()}
      />
    );

    // No hasUnpagedItems prop → derive emptiness from the local empty sources.
    expect(screen.getByText("No artifacts yet")).toBeTruthy();
  });
});
