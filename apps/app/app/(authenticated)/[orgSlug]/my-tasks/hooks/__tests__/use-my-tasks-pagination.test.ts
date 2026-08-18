import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The hook reads sort + a feature flag from ports we mock so the test drives
// only the hook's own page-advance / reset / clamp branches deterministically.
const featureFlagEnabledMock = vi.fn();
const sortParamsMock = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => featureFlagEnabledMock(key),
}));
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
