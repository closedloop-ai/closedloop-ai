import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import type { UseTableViewPaginationInput } from "@repo/app/documents/hooks/use-table-view-pagination";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagGateOptional: vi.fn(),
  useSortParams: vi.fn(),
}));

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagGateOptional: mocks.useFeatureFlagGateOptional,
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));

import { useTableViewPagination } from "@repo/app/documents/hooks/use-table-view-pagination";

function statusRow(id: string, status: string): DocumentWithProject {
  return {
    ...makeArtifact({ id, title: id, slug: id }),
    status,
  } as DocumentWithProject;
}

const ROWS = [
  statusRow("row-a", DocumentStatus.Draft),
  statusRow("row-b", DocumentStatus.Draft),
  statusRow("row-c", DocumentStatus.Executed),
];

function baseInput(
  overrides: Partial<UseTableViewPaginationInput> = {}
): UseTableViewPaginationInput {
  return {
    documents: ROWS,
    treeData: undefined,
    filterCategory: "documents",
    filterText: "",
    isFilterActive: false,
    groupBy: GroupByMode.None,
    sortPersistenceKey: "paging",
    pageSize: 1,
    ...overrides,
  };
}

function setSectionPaging(enabled: boolean): void {
  mocks.useFeatureFlagEnabled.mockImplementation((key: string) =>
    key === GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY ? enabled : false
  );
}

describe("useTableViewPagination paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSectionPaging(false);
    mocks.useFeatureFlagGateOptional.mockReturnValue({
      enabled: false,
      isReady: true,
    });
    mocks.useSortParams.mockReturnValue({
      sortBy: SortKey.Title,
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
  });

  it("uses the default page size when none is passed", () => {
    const { result } = renderHook(() =>
      useTableViewPagination(baseInput({ pageSize: undefined }))
    );
    expect(DEFAULT_TABLE_PAGE_SIZE).toBeGreaterThanOrEqual(ROWS.length);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(3);
    expect(result.current.pagedDocuments.map((doc) => doc.id)).toEqual([
      "row-a",
      "row-b",
      "row-c",
    ]);
  });

  it("reports an empty corpus as one page with a zero range", () => {
    const { result } = renderHook(() =>
      useTableViewPagination(baseInput({ documents: [] }))
    );
    expect(result.current.total).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.from).toBe(0);
    expect(result.current.to).toBe(0);
  });

  it("applies project filters only while a filter is active", () => {
    const applyProjectFilters = vi.fn((items: DocumentRowItem[]) =>
      items.filter((item) => item.data.id === "row-c")
    );

    const inactive = renderHook(() =>
      useTableViewPagination(baseInput({ applyProjectFilters }))
    );
    expect(inactive.result.current.total).toBe(3);
    expect(applyProjectFilters).not.toHaveBeenCalled();

    const active = renderHook(() =>
      useTableViewPagination(
        baseInput({ applyProjectFilters, isFilterActive: true })
      )
    );
    expect(applyProjectFilters).toHaveBeenCalled();
    expect(active.result.current.total).toBe(1);
    expect(active.result.current.pagedDocuments.map((doc) => doc.id)).toEqual([
      "row-c",
    ]);
  });

  it("resets to page 0 when the filter text changes", () => {
    const { result, rerender } = renderHook(
      (input: UseTableViewPaginationInput) => useTableViewPagination(input),
      { initialProps: baseInput() }
    );
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);

    rerender(baseInput({ filterText: "row" }));

    expect(result.current.page).toBe(0);
  });

  it("clamps a requested page past the end back to the last page", () => {
    const { result } = renderHook(() => useTableViewPagination(baseInput()));
    act(() => result.current.setPage(9));
    expect(result.current.page).toBe(2);
    expect(result.current.from).toBe(3);
    expect(result.current.to).toBe(3);
  });

  it("hands the inputs back unsliced when disabled", () => {
    const { result } = renderHook(() =>
      useTableViewPagination(baseInput({ enabled: false }))
    );
    expect(result.current.total).toBe(0);
    expect(result.current.pagedDocuments).toBe(ROWS);
    expect(result.current.sectionTotalsByKey).toBeUndefined();
  });

  describe("with section-aware paging on a grouped board", () => {
    beforeEach(() => {
      setSectionPaging(true);
    });

    it("pages by whole sections and counts earlier pages' rows", () => {
      const { result } = renderHook(() =>
        useTableViewPagination(baseInput({ groupBy: GroupByMode.Status }))
      );
      const firstPageIds = result.current.pagedDocuments.map((doc) => doc.id);
      const sectionTotals = [
        ...(result.current.sectionTotalsByKey?.values() ?? []),
      ].sort();
      expect(sectionTotals).toEqual([1, 2]);
      expect(result.current.from).toBe(1);
      expect(result.current.to).toBe(firstPageIds.length);

      act(() => result.current.setPage(result.current.totalPages - 1));

      const lastPageIds = result.current.pagedDocuments.map((doc) => doc.id);
      expect(result.current.to).toBe(3);
      expect(result.current.from).toBe(3 - lastPageIds.length + 1);
    });

    it("reports an empty grouped board as one empty page", () => {
      const { result } = renderHook(() =>
        useTableViewPagination(
          baseInput({ documents: [], groupBy: GroupByMode.Status })
        )
      );
      expect(result.current.totalPages).toBe(1);
      expect(result.current.from).toBe(0);
      expect(result.current.to).toBe(0);
      expect(result.current.pagedDocuments).toEqual([]);
      expect(result.current.continuedSectionKeys).toBeUndefined();
    });
  });
});
