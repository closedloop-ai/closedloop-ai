import { DocumentStatus } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The hook reads sort + a feature flag from ports we mock so the test drives
// only the hook's own page-advance / reset / clamp branches deterministically.
const featureFlagEnabledMock = vi.fn();
const sortParamsMock = vi.fn();

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial: `useTableViewPagination` also resolves the ISS-9437 ordering keys
    // through this module (`useFeatureFlagGateOptional`), and a total factory
    // drops every export it does not name. The real one resolves closed here,
    // with no provider mounted, which is this suite's flag-OFF baseline.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: (key: string) => featureFlagEnabledMock(key),
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => sortParamsMock(),
}));

import {
  MY_TASKS_PAGE_SIZE,
  useMyTasksPagination,
} from "../use-my-tasks-pagination";

function docFixture(id: string): DocumentRowData {
  return {
    id,
    title: id,
    slug: id,
    status: "DRAFT",
    priority: "MEDIUM",
    projectId: "p1",
    project: null,
    assignee: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as DocumentRowData;
}

function docs(count: number): DocumentRowData[] {
  return Array.from({ length: count }, (_u, i) => docFixture(`doc-${i}`));
}

type HookInput = Parameters<typeof useMyTasksPagination>[0];

function baseInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    documents: [],
    treeData: null as ProjectTreeResponse | null,
    filterCategory: "all",
    filterText: "",
    applyProjectFilters: undefined,
    isFilterActive: false,
    groupBy: GroupByMode.None,
    sortPersistenceKey: "table:sort:my-tasks",
    pageSize: 2,
    ...overrides,
  };
}

beforeEach(() => {
  featureFlagEnabledMock.mockReturnValue(false);
  sortParamsMock.mockReturnValue({
    sortBy: null,
    sortDir: "asc",
    setSort: vi.fn(),
    clearSort: vi.fn(),
    clearPersistedSort: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useMyTasksPagination — page advancement", () => {
  test("setPage advances the slice and the range readout", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(5) }) }
    );

    // Page 0 of size 2 → first two docs, range 1-2 of 5.
    expect(result.current.page).toBe(0);
    expect(result.current.total).toBe(5);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(2);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual([
      "doc-0",
      "doc-1",
    ]);

    act(() => {
      result.current.setPage(2);
    });

    // Page 2 → the trailing doc, range 5-5 of 5.
    expect(result.current.page).toBe(2);
    expect(result.current.from).toBe(5);
    expect(result.current.to).toBe(5);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual(["doc-4"]);
  });
});

describe("useMyTasksPagination — reset to page 0 on input changes", () => {
  test("a filterText change resets to page 0 (never strands the viewer on an out-of-range page)", () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(5) }) }
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);

    rerender(baseInput({ documents: docs(5), filterText: "alpha" }));
    expect(result.current.page).toBe(0);
  });

  test("a groupBy change resets to page 0", () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(5) }) }
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);

    rerender(baseInput({ documents: docs(5), groupBy: GroupByMode.Status }));
    expect(result.current.page).toBe(0);
  });

  test("a sort change (from the sort port) resets to page 0", () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(5) }) }
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);

    // The sort port now reports a different sort; a rerender picks it up and the
    // filter-identity change resets the page.
    sortParamsMock.mockReturnValue({
      sortBy: "title",
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    rerender(baseInput({ documents: docs(5) }));
    expect(result.current.page).toBe(0);
  });
});

describe("useMyTasksPagination — corpus shrink + regrowth clamping", () => {
  test("clamps the current page when the corpus shrinks WITHOUT a filter change (a refetch dropping rows)", () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(5) }) }
    );

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);

    // Same filter identity, but the list refetched down to 2 rows → totalPages
    // becomes 1, so the effective page clamps to 0 and the slice is not empty.
    rerender(baseInput({ documents: docs(2) }));
    expect(result.current.total).toBe(2);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.page).toBe(0);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual([
      "doc-0",
      "doc-1",
    ]);
  });

  test("does not over-clamp: after a shrink-then-regrow the viewer can page again", () => {
    const { result, rerender } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(2) }) }
    );

    // Corpus grows back to 5 rows; the page range reopens.
    rerender(baseInput({ documents: docs(5) }));
    expect(result.current.totalPages).toBe(3);

    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.page).toBe(2);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual(["doc-4"]);
  });
});

describe("useMyTasksPagination — page-size clamp", () => {
  test("floors an invalid pageSize of 0 to 1 (no infinite totalPages)", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(3), pageSize: 0 }) }
    );

    expect(Number.isFinite(result.current.totalPages)).toBe(true);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.pagedDocuments).toHaveLength(1);
  });

  test("defaults to MY_TASKS_PAGE_SIZE when pageSize is omitted", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: docs(3), pageSize: undefined }) }
    );

    // 3 docs fit on one MY_TASKS_PAGE_SIZE (50) page.
    expect(MY_TASKS_PAGE_SIZE).toBeGreaterThan(3);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.to).toBe(3);
  });
});

describe("useMyTasksPagination — empty corpus", () => {
  test("reports a zero total with from=0 and an empty slice", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: baseInput({ documents: [] }) }
    );

    expect(result.current.total).toBe(0);
    expect(result.current.from).toBe(0);
    expect(result.current.to).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pagedDocuments).toEqual([]);
  });
});

/**
 * Sizes are pinned to literals, independent of MY_TASKS_PAGE_SIZE, so a change
 * to the board's page size cannot silently re-satisfy these expectations.
 * Sections render in STATUS_DISPLAY_ORDER: Draft, then In Review, then Approved.
 */
const GROUPED_PAGE_SIZE = 10;

function statusDoc(id: string, status: string): DocumentRowData {
  return { ...docFixture(id), status } as DocumentRowData;
}

function statusDocs(
  status: string,
  prefix: string,
  count: number
): DocumentRowData[] {
  return Array.from({ length: count }, (_u, i) =>
    statusDoc(`${prefix}-${i}`, status)
  );
}

/** 6 Draft + 7 In Review + 25 Approved = 38 rows over a 10-row page. */
function groupedStatusBoard(): DocumentRowData[] {
  return [
    ...statusDocs(DocumentStatus.Draft, "draft", 6),
    ...statusDocs(DocumentStatus.InReview, "review", 7),
    ...statusDocs(DocumentStatus.Approved, "approved", 25),
  ];
}

function groupedInput(): HookInput {
  return baseInput({
    documents: groupedStatusBoard(),
    groupBy: GroupByMode.Status,
    pageSize: GROUPED_PAGE_SIZE,
  });
}

describe("useMyTasksPagination — grouped section-aware paging (ISS-4704)", () => {
  beforeEach(() => {
    featureFlagEnabledMock.mockImplementation(
      (key: string) => key === GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY
    );
  });

  test("keeps a boundary-spanning section whole on its own page, and the range readout follows the variable page sizes", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: groupedInput() }
    );

    // Draft(6) alone on page 0 — In Review would have overflowed the 10-row page.
    expect(result.current.totalPages).toBe(5);
    expect(result.current.total).toBe(38);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual([
      "draft-0",
      "draft-1",
      "draft-2",
      "draft-3",
      "draft-4",
      "draft-5",
    ]);
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(6);

    act(() => {
      result.current.setPage(1);
    });

    // The whole In Review section, and a readout that resumes at row 7.
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual([
      "review-0",
      "review-1",
      "review-2",
      "review-3",
      "review-4",
      "review-5",
      "review-6",
    ]);
    expect(result.current.from).toBe(7);
    expect(result.current.to).toBe(13);
  });

  test("reports each section's full-list population and marks only the oversized section's spill pages", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: groupedInput() }
    );

    expect(result.current.sectionTotalsByKey?.get(DocumentStatus.Draft)).toBe(
      6
    );
    expect(
      result.current.sectionTotalsByKey?.get(DocumentStatus.InReview)
    ).toBe(7);
    expect(
      result.current.sectionTotalsByKey?.get(DocumentStatus.Approved)
    ).toBe(25);

    // Page 2 opens the Approved section: 10 of its 25 rows, no continuation.
    act(() => {
      result.current.setPage(2);
    });
    expect(result.current.pagedDocuments).toHaveLength(10);
    expect([...(result.current.continuedSectionKeys ?? [])]).toEqual([]);

    // Page 3 carries on with the same section, and says so.
    act(() => {
      result.current.setPage(3);
    });
    expect([...(result.current.continuedSectionKeys ?? [])]).toEqual([
      DocumentStatus.Approved,
    ]);
    expect(result.current.from).toBe(24);
    expect(result.current.to).toBe(33);
  });

  test("clamps a negative page to 0 instead of slicing from the tail of the plan", () => {
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: groupedInput() }
    );

    act(() => {
      result.current.setPage(-3);
    });

    expect(result.current.page).toBe(0);
    expect(result.current.from).toBe(1);
    expect(result.current.pagedDocuments).toHaveLength(6);
  });
});

describe("useMyTasksPagination — grouped paging with the gate OFF", () => {
  test("keeps the ISS-4466 fixed-pageSize slice, which splits a section across pages and publishes no section population", () => {
    featureFlagEnabledMock.mockReturnValue(false);
    const { result } = renderHook(
      (props: HookInput) => useMyTasksPagination(props),
      { initialProps: groupedInput() }
    );

    // Today's defect, deliberately pinned: page 0 is a flat 10-row window that
    // cuts four rows off the In Review section, and no true population is
    // published for the header to state.
    expect(result.current.totalPages).toBe(4);
    expect(result.current.pagedDocuments.map((d) => d.id)).toEqual([
      "draft-0",
      "draft-1",
      "draft-2",
      "draft-3",
      "draft-4",
      "draft-5",
      "review-0",
      "review-1",
      "review-2",
      "review-3",
    ]);
    expect(result.current.to).toBe(10);
    expect(result.current.sectionTotalsByKey).toBeUndefined();
    expect(result.current.continuedSectionKeys).toBeUndefined();
  });
});
