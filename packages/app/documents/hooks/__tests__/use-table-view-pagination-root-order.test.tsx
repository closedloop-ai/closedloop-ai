import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY,
  ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9437 production wiring — `useTableViewPagination` reads the ordering keys
 * ITSELF and slices page membership with the result.
 *
 * This is the half that cannot be covered by the pipeline tests: the paginator
 * is a different component from `DocumentsView`, so if it did not perform its
 * own read it would keep slicing in today's order while the view rendered each
 * page root-first, and rows would move between pages with nothing detecting it.
 */
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
  statusRow("row-garbage", "GARBAGE"),
  statusRow("row-executed", DocumentStatus.Executed),
  statusRow("row-draft", DocumentStatus.Draft),
];

function setRootOrderFlag(enabled: boolean): void {
  mocks.useFeatureFlagGateOptional.mockImplementation((key: string) => {
    if (key === ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY) {
      return { enabled, isReady: true };
    }
    if (key === ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY) {
      return { enabled: false, isReady: true };
    }
    return { enabled: false, isReady: true };
  });
}

function pageOne(): string[] {
  const { result } = renderHook(() =>
    useTableViewPagination({
      documents: ROWS,
      treeData: undefined,
      filterCategory: "documents",
      filterText: "",
      isFilterActive: false,
      groupBy: GroupByMode.None,
      sortPersistenceKey: "root-order",
      pageSize: 1,
    })
  );
  return result.current.pagedDocuments.map((doc) => doc.id);
}

describe("useTableViewPagination slices membership by the resolved ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The ISS-4704 section-paging gate is a separate key and stays off here.
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      sortBy: SortKey.Status,
      sortDir: "desc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    setRootOrderFlag(false);
  });

  it("puts the unranked row on page 1 while the key is OFF", () => {
    // Today's descending quirk: an unranked status floats to the TOP, so it is
    // the first page's only row.
    expect(pageOne()).toEqual(["row-garbage"]);
  });

  it("puts the highest ROOT band on page 1 once the key is ON", () => {
    setRootOrderFlag(true);
    expect(pageOne()).toEqual(["row-executed"]);
  });

  it("moves the unranked row to the LAST page once the key is ON", () => {
    setRootOrderFlag(true);
    const { result } = renderHook(() =>
      useTableViewPagination({
        documents: ROWS,
        treeData: undefined,
        filterCategory: "documents",
        filterText: "",
        isFilterActive: false,
        groupBy: GroupByMode.None,
        sortPersistenceKey: "root-order",
        pageSize: 1,
      })
    );
    expect(result.current.totalPages).toBe(3);
    act(() => result.current.setPage(2));
    expect(result.current.pagedDocuments.map((doc) => doc.id)).toEqual([
      "row-garbage",
    ]);
  });
});
