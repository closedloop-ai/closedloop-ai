import { DocumentStatus } from "@repo/api/src/types/document";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared paginator reads sort state and the stack-rank flag from ports we
// mock, so these tests drive this hook's own branches deterministically.
const featureFlagEnabledMock = vi.fn();
const sortParamsMock = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => featureFlagEnabledMock(key),
  useFeatureFlagEnabledOptional: (key: string) => featureFlagEnabledMock(key),
  // ISS-9692 (whitlockk review): the page size reads the ladder flag through the
  // GATE, which reports resolution as well as value. Routed to the same mock so
  // a case can turn the extended ladder on; `isReady` is true here because this
  // tab pages client-side over rows already in hand — it issues no request the
  // size could be wrong for. The readiness contract itself is asserted where it
  // bites, in `use-table-page-size-options.test.tsx` and at the two list hosts.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: featureFlagEnabledMock(key),
    isReady: true,
  }),
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => sortParamsMock(),
}));

import { useProjectArtifactsPagination } from "../use-project-artifacts-pagination";

const PROJECT_ID = "project-1";
/** More rows than one default page, so a page can be a strict subset. */
const TOTAL_DOCS = 60;

// ISS-9726: the page-size and sort keys are resolved by the page and threaded
// in, so a test names the key it wants rather than the project it used to be
// derived from. Same shape the page produces.
function pageSizeKeyFor(projectId: string): string {
  return `table:page-size:project-artifacts:${projectId}`;
}

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
    pageSizeStorageKey: pageSizeKeyFor(PROJECT_ID),
    scrollContainer: null,
    sortPersistenceKey: `table:sort:project-artifacts:${PROJECT_ID}`,
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

/**
 * A grouped tab whose sections straddle the 25-row default page: 20 Draft, 20
 * In Review, 20 Approved. Sizes are literals, independent of
 * DEFAULT_TABLE_PAGE_SIZE, so a change to the default cannot re-satisfy them.
 */
function statusDocs(status: string, prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_unused, i) =>
      ({
        ...docFixture(`${prefix}-${String(i).padStart(3, "0")}`),
        status,
      }) as DocumentRowData
  );
}

function groupedStatusInput(): HookInput {
  return baseInput({
    documents: [
      ...statusDocs(DocumentStatus.Draft, "draft", 20),
      ...statusDocs(DocumentStatus.InReview, "review", 20),
      ...statusDocs(DocumentStatus.Approved, "approved", 20),
    ],
    groupBy: GroupByMode.Status,
  });
}

describe("useProjectArtifactsPagination — grouped section-aware paging (ISS-4704)", () => {
  beforeEach(() => {
    featureFlagEnabledMock.mockImplementation(
      (key: string) => key === GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY
    );
  });

  it("hands DocumentsView the true section populations and this page's continuations", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(groupedStatusInput())
    );

    expect(result.current.sectionTotalsByKey?.get(DocumentStatus.Draft)).toBe(
      20
    );
    expect(
      result.current.sectionTotalsByKey?.get(DocumentStatus.InReview)
    ).toBe(20);
    // Page 0 opens on Draft alone, which began here — nothing is continuing.
    expect([...(result.current.continuedSectionKeys ?? [])]).toEqual([]);
    expect(result.current.pagedDocuments).toHaveLength(20);
  });

  it("states the range the page actually holds, not the page * pageSize stride", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(groupedStatusInput())
    );

    act(() => {
      result.current.onPageChange(1);
    });

    // Page 0 held 20 rows (Draft), so page 1 resumes at 21 — the stride
    // derivation would have said "26-50 of 60" over rows 21-40.
    expect(result.current.readout).toBe("21–40 of 60 PRDs");
  });

  it("keeps the fixed-stride readout and publishes no populations with the gate off", () => {
    featureFlagEnabledMock.mockReturnValue(false);
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(groupedStatusInput())
    );

    act(() => {
      result.current.onPageChange(1);
    });

    expect(result.current.readout).toBe("26–50 of 60 PRDs");
    expect(result.current.sectionTotalsByKey).toBeUndefined();
    expect(result.current.continuedSectionKeys).toBeUndefined();
  });
});
/**
 * ISS-9692 — the project-artifacts tab offers the large rungs, fills them, and
 * remembers the choice per project.
 */
describe("useProjectArtifactsPagination — rows-per-page (ISS-9692)", () => {
  const LARGE_PAGE_SIZE = 250;
  const STORAGE_KEY = `table:page-size:project-artifacts:${PROJECT_ID}`;

  beforeEach(() => {
    localStorage.clear();
  });

  it("offers only the shipped ladder with the flag off", () => {
    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.pageSizeOptions).not.toContain(LARGE_PAGE_SIZE);
    expect(result.current.pageSizeOptions).not.toContain(500);
  });

  it("offers 250 and 500 with the flag on", () => {
    featureFlagEnabledMock.mockReturnValue(true);

    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.pageSizeOptions).toContain(LARGE_PAGE_SIZE);
    expect(result.current.pageSizeOptions).toContain(500);
  });

  it("fills a large page when the tab has the rows for it", () => {
    featureFlagEnabledMock.mockReturnValue(true);

    const { result } = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: docs(LARGE_PAGE_SIZE + 10) })
      )
    );

    act(() => result.current.onPageSizeChange(LARGE_PAGE_SIZE));

    expect(result.current.pageSize).toBe(LARGE_PAGE_SIZE);
    expect(result.current.pagedDocuments).toHaveLength(LARGE_PAGE_SIZE);
    expect(result.current.totalPages).toBe(2);
  });

  it("restores the choice on a later visit to the same project", () => {
    featureFlagEnabledMock.mockReturnValue(true);

    const first = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: docs(LARGE_PAGE_SIZE + 10) })
      )
    );
    act(() => first.result.current.onPageSizeChange(LARGE_PAGE_SIZE));
    first.unmount();

    // A fresh mount reading what the first one wrote, which is what a reload
    // and a navigate-away-and-back both are.
    const second = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: docs(LARGE_PAGE_SIZE + 10) })
      )
    );

    expect(second.result.current.pageSize).toBe(LARGE_PAGE_SIZE);
    expect(second.result.current.pagedDocuments).toHaveLength(LARGE_PAGE_SIZE);
  });

  it("does not leak one project's choice onto another", () => {
    featureFlagEnabledMock.mockReturnValue(true);

    const first = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: docs(LARGE_PAGE_SIZE + 10) })
      )
    );
    act(() => first.result.current.onPageSizeChange(LARGE_PAGE_SIZE));
    first.unmount();

    const other = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ pageSizeStorageKey: pageSizeKeyFor("project-2") })
      )
    );

    expect(other.result.current.pageSize).toBe(DEFAULT_TABLE_PAGE_SIZE);
  });

  /**
   * ISS-9692 (davetho review) — the expectation here CHANGED, deliberately.
   *
   * It used to assert that a stored 500 read back as 25 with the gate closed,
   * which was the behaviour of a hook that switched its persistence key to
   * `null` and therefore never saw the stored value at all. That is not the
   * documented stale-value contract: `useTablePageSizeOptions` promises the
   * NEAREST STILL-LEGAL rung, so a reader who chose "as many as possible" lands
   * on 100 rather than being reset to the smallest page on the ladder — and,
   * critically, their stored 500 survives to be honoured again when the gate
   * reopens. The old expectation described the defect.
   */
  it("degrades a stored size to the largest still-offered rung while the gate is closed", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: 500, savedAt: Date.now() })
    );
    featureFlagEnabledMock.mockReturnValue(false);

    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );

    expect(result.current.pageSize).toBe(100);
    expect(result.current.pageSizeOptions).toContain(result.current.pageSize);
    expect(result.current.pageSizeOptions).not.toContain(500);
  });

  it("still holds the stored size on disk through a gated-off visit", () => {
    // The half a "no error thrown" assertion would miss. A gated-off session
    // that read 25 and then wrote 25 would have DESTROYED the 500 — the reader
    // turns the flag back on and their choice is gone, with nothing to show
    // that anything was lost.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: 500, savedAt: Date.now() })
    );
    featureFlagEnabledMock.mockReturnValue(false);

    const gatedOff = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );
    act(() => gatedOff.result.current.onPageSizeChange(50));
    gatedOff.unmount();

    featureFlagEnabledMock.mockReturnValue(true);
    const gatedOn = renderHook(() =>
      useProjectArtifactsPagination(
        baseInput({ documents: docs(LARGE_PAGE_SIZE + 10) })
      )
    );

    expect(gatedOn.result.current.pageSize).toBe(500);
  });

  it("keeps the choice out of storage while the ladder gate is closed", () => {
    featureFlagEnabledMock.mockReturnValue(false);

    const { result } = renderHook(() =>
      useProjectArtifactsPagination(baseInput())
    );
    act(() => result.current.onPageSizeChange(100));

    // The control still moves for this visit — withholding the feature must not
    // break the control that shipped.
    expect(result.current.pageSize).toBe(100);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
