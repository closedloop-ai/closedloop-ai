import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared paginator reads sort state and the stack-rank flag from ports we
// mock, so these tests drive this hook's own branches deterministically.
const featureFlagEnabledMock = vi.fn();
const sortParamsMock = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => featureFlagEnabledMock(key),
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => sortParamsMock(),
}));

import { useProjectArtifactsPagination } from "../use-project-artifacts-pagination";

const PROJECT_ID = "project-1";
/** More rows than one default page, so a page can be a strict subset. */
const TOTAL_DOCS = 60;

function docFixture(id: string): DocumentRowData {
  return {
    assignee: null,
    id,
    priority: "MEDIUM",
    project: null,
    projectId: PROJECT_ID,
    slug: id,
    status: "DRAFT",
    title: id,
    type: "PRD",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as DocumentRowData;
}

function docs(count: number): DocumentRowData[] {
  return Array.from({ length: count }, (_unused, i) =>
    docFixture(`doc-${String(i).padStart(3, "0")}`)
  );
}

type HookInput = Parameters<typeof useProjectArtifactsPagination>[0];

function baseInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    applyProjectFilters: undefined,
    documents: docs(TOTAL_DOCS),
    filterCategory: "documents",
    filterText: "",
    groupBy: GroupByMode.None,
    hasArtifactItems: true,
    isEnabled: true,
    isFilterActive: false,
    isOverview: false,
    projectId: PROJECT_ID,
    scrollContainer: null,
    treeData: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  featureFlagEnabledMock.mockReturnValue(false);
  sortParamsMock.mockReturnValue({
    clearPersistedSort: vi.fn(),
    clearSort: vi.fn(),
    setSort: vi.fn(),
    sortBy: null,
    sortDir: "asc",
  });
});

describe("useProjectArtifactsPagination — bounded page (ISS-5307)", () => {
  it("hands DocumentsView a bounded subset, not every row", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.pagedDocuments).toHaveLength(DEFAULT_TABLE_PAGE_SIZE);
    expect(result.current.pagedDocuments.length).toBeLessThan(TOTAL_DOCS);
  });

  it("reports the tab's TRUE total, not the number of rows on the page", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    // The trap this guards: a "60" that actually means "25 loaded so far".
    expect(result.current.total).toBe(TOTAL_DOCS);
    expect(result.current.total).not.toBe(result.current.pagedDocuments.length);
    expect(result.current.readout).toContain(String(TOTAL_DOCS));
    expect(result.current.totalPages).toBe(
      Math.ceil(TOTAL_DOCS / DEFAULT_TABLE_PAGE_SIZE)
    );
  });

  it("names the tab's own population in the readout", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ filterCategory: "documents" }))
    );

    expect(result.current.readout).toContain("PRDs");
    expect(result.current.readout).not.toContain("artifacts");
  });

  it("serves a later page without repeating or skipping a row", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    const firstPageIds = result.current.pagedDocuments.map((d) => d.id);
    act(() => {
      result.current.setPage(1);
    });
    const secondPageIds = result.current.pagedDocuments.map((d) => d.id);

    expect(result.current.page).toBe(1);
    expect(secondPageIds).toHaveLength(DEFAULT_TABLE_PAGE_SIZE);
    // Disjoint (nothing repeated) and contiguous (nothing skipped).
    for (const id of secondPageIds) {
      expect(firstPageIds).not.toContain(id);
    }
    expect([...firstPageIds, ...secondPageIds]).toHaveLength(
      new Set([...firstPageIds, ...secondPageIds]).size
    );
  });
});

describe("useProjectArtifactsPagination — page size (ISS-5307)", () => {
  it("re-slices to the new size and returns to the first page", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);

    act(() => {
      result.current.onPageSizeChange(50);
    });

    expect(result.current.pageSize).toBe(50);
    expect(result.current.pagedDocuments).toHaveLength(50);
    // Without the reset a viewer on page 2 of 25-row pages would land on page 2
    // of 50-row pages — past the rows they were reading.
    expect(result.current.page).toBe(0);
    // The total is a property of the tab, not of the page size.
    expect(result.current.total).toBe(TOTAL_DOCS);
  });
});

describe("useProjectArtifactsPagination — empty-vs-filtered signal (ISS-5307)", () => {
  it("passes the unpaged signal down so a zero-match filter keeps Clear filters", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ hasArtifactItems: true, isFilterActive: true })
      )
    );

    expect(result.current.hasUnpagedItems).toBe(true);
  });

  it("passes the honest false when the project truly has no artifacts", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: [], hasArtifactItems: false })
      )
    );

    expect(result.current.hasUnpagedItems).toBe(false);
    expect(result.current.showFooter).toBe(false);
  });

  it("hides the footer on an empty tab even when the project has artifacts elsewhere", () => {
    // Branches on a project with no branches: `hasArtifactItems` is true
    // project-wide, but this tab has nothing to page. A footer here would be a
    // bordered strip holding a rows-per-page control over zero rows.
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ filterCategory: "branches", hasArtifactItems: true })
      )
    );

    expect(result.current.total).toBe(0);
    expect(result.current.showFooter).toBe(false);
  });
});

describe("useProjectArtifactsPagination — flag off (ISS-5307)", () => {
  it("slices nothing and shows no footer", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ isEnabled: false }))
    );

    // Every row is handed through, exactly as before this ticket.
    expect(result.current.pagedDocuments).toHaveLength(TOTAL_DOCS);
    expect(result.current.showFooter).toBe(false);
    // `undefined` (not `false`) so DocumentsView falls back to reading its own
    // sources, which are complete when nothing is paged.
    expect(result.current.hasUnpagedItems).toBeUndefined();
  });
});

describe("useProjectArtifactsPagination — footer visibility (ISS-5307)", () => {
  it("hides the footer on Overview, which renders no table", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ isOverview: true }))
    );

    expect(result.current.showFooter).toBe(false);
  });

  it("shows the footer on a populated tab with paging on", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.showFooter).toBe(true);
  });
});

describe("useProjectArtifactsPagination — server truncation (ISS-5307)", () => {
  it("carries no caveat when the server returned a complete tree", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({
          treeData: {
            externalParents: [],
            nodes: [],
          } as ProjectTreeDetailsResponse,
        })
      )
    );

    expect(result.current.truncationNote).toBeNull();
  });

  it("says what the count was counted from when the server bounded the read", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({
          treeData: {
            externalParents: [],
            nodes: [],
            truncation: {
              anchorsIncluded: 500,
              anchorsMatchedAtLeast: 1284,
              reasons: [TreeTruncationReason.AnchorCap],
            },
          } as ProjectTreeDetailsResponse,
        })
      )
    );

    expect(result.current.truncationNote).toContain("first 500");
  });

  it("marks the total as a floor whenever the caveat is showing", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({
          treeData: {
            externalParents: [],
            nodes: [],
            truncation: {
              anchorsIncluded: 500,
              anchorsMatchedAtLeast: 1284,
              reasons: [TreeTruncationReason.AnchorCap],
            },
          } as ProjectTreeDetailsResponse,
        })
      )
    );

    // Marker and note ship together: "of 60" under a bounded read asserts a
    // project size nobody measured, and a note with no marker leaves that
    // confident wrong number on screen.
    expect(result.current.readout).toContain(`${TOTAL_DOCS}+`);
    expect(result.current.truncationNote).not.toBeNull();
  });

  it("does not mark the total as a floor on a complete read", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.readout).not.toContain(`${TOTAL_DOCS}+`);
    expect(result.current.truncationNote).toBeNull();
  });
});

describe("useProjectArtifactsPagination — page turn (ISS-5307)", () => {
  it("returns the scroll container to the top of the new page", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 640;
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ scrollContainer }))
    );

    act(() => {
      result.current.onPageChange(1);
    });

    // The container persists its offset per tab, so without this Next clicked
    // from the bottom of page 1 lands the viewer at the bottom of page 2.
    expect(result.current.page).toBe(1);
    expect(scrollContainer.scrollTop).toBe(0);
  });

  it("also returns to the top when the page size changes", () => {
    const scrollContainer = document.createElement("div");
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ scrollContainer }))
    );

    act(() => {
      result.current.onPageChange(2);
    });
    scrollContainer.scrollTop = 420;
    act(() => {
      result.current.onPageSizeChange(50);
    });

    expect(result.current.page).toBe(0);
    expect(scrollContainer.scrollTop).toBe(0);
  });
});

/**
 * The caveat used to ride inside the footer only, and the footer renders only
 * when the tab has rows — so filtering a truncated project down to zero matches
 * dropped it exactly where it decides what the screen means.
 */
describe("useProjectArtifactsPagination — the caveat survives a zero-row tab", () => {
  const boundedTree = {
    externalParents: [],
    nodes: [],
    truncation: {
      anchorsIncluded: 500,
      anchorsMatchedAtLeast: 1284,
      reasons: [TreeTruncationReason.AnchorCap],
    },
  } as ProjectTreeDetailsResponse;

  it("hands back a standalone caveat when the bounded tab has no rows", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: [], treeData: boundedTree })
      )
    );

    // No rows means no footer, so the footer's own note is gone...
    expect(result.current.showFooter).toBe(false);
    expect(result.current.truncationNote).not.toBeNull();
    // ...and this is what the page renders beside the empty state instead.
    expect(result.current.emptyStateTruncationNote).toContain(
      "No matches in the first 500"
    );
  });

  it("leaves the standalone caveat off while the footer is carrying one", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ treeData: boundedTree }))
    );

    // Exactly one of the two shows at a time; both would print the caveat twice.
    expect(result.current.showFooter).toBe(true);
    expect(result.current.emptyStateTruncationNote).toBeNull();
  });

  it("says nothing on an empty tab the server read completely", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput({ documents: [] }))
    );

    // Here "nothing matches" is simply true.
    expect(result.current.emptyStateTruncationNote).toBeNull();
  });

  it("says nothing on Overview, which renders no table at all", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: [], isOverview: true, treeData: boundedTree })
      )
    );

    expect(result.current.emptyStateTruncationNote).toBeNull();
  });

  it("says nothing with the flag off, where nothing is bounded or paged", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: [], isEnabled: false, treeData: boundedTree })
      )
    );

    expect(result.current.emptyStateTruncationNote).toBeNull();
  });
});
