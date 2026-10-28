// @vitest-environment jsdom

import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  type DocumentListPage,
  DocumentType,
} from "@repo/api/src/types/document";
import type { ArtifactListReadState } from "@repo/app/artifacts/components/artifact-list";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIssuesIndexRead } from "../use-issues-index-read";

const mocks = vi.hoisted(() => ({
  useDocuments: vi.fn(),
  useDocumentsPage: vi.fn(),
  useTablePageSizeOptions: vi.fn(),
}));
vi.mock("@repo/app/documents/hooks/use-documents", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useDocuments: mocks.useDocuments,
  useDocumentsPage: mocks.useDocumentsPage,
}));
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: mocks.useTablePageSizeOptions,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: (_key: string | null, value: unknown) => [
    value,
    vi.fn(),
    vi.fn(),
  ],
}));

const PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[0];
const PAGED_LIST_READ: ArtifactListReadState = {
  completeRead: false,
  sortBy: null,
  sortDir: "asc",
};
const PAST_THE_DEBOUNCE_MS = 400;
const issue = createMockDocument({ type: DocumentType.Feature });
const envelope: DocumentListPage = {
  items: [issue],
  total: PAGE_SIZE + 1,
  limit: PAGE_SIZE,
  offset: 0,
  hasMore: true,
};

function idleRead(data: unknown) {
  return {
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

function renderRead(
  filterText = "",
  listRead: ArtifactListReadState | undefined = PAGED_LIST_READ
) {
  return renderHook(
    ({ term, list }) =>
      useIssuesIndexRead({
        filterText: term,
        listRead: list,
        pageSizeStorageKey: "org-1:issues-index-page-size",
        recencyDays: undefined,
        scrollContainer: null,
      }),
    { initialProps: { term: filterText, list: listRead } }
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.useTablePageSizeOptions.mockImplementation((requested: number) => ({
    isExtendedLadderEnabled: false,
    isReady: true,
    options: TABLE_PAGE_SIZE_OPTIONS,
    pageSize: resolveLegalTablePageSize(requested, TABLE_PAGE_SIZE_OPTIONS),
  }));
  mocks.useDocumentsPage.mockReturnValue(idleRead(envelope));
  mocks.useDocuments.mockReturnValue(idleRead(undefined));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("org-wide Issues read", () => {
  it("reads one server page of Issues instead of the whole organization", () => {
    const { result } = renderRead();
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      { types: [DocumentType.Feature], limit: PAGE_SIZE, offset: 0 },
      expect.objectContaining({ enabled: true })
    );
    expect(mocks.useDocuments).toHaveBeenLastCalledWith(
      { types: [DocumentType.Feature] },
      { enabled: false }
    );
    expect(result.current.isServerPaged).toBe(true);
    expect(result.current.documents).toEqual([issue]);
    expect(result.current.pagination).toMatchObject({ page: 0, totalPages: 2 });
  });

  it("scopes the summary and cost reads by the cohort filter, never an ID list", () => {
    const { result, rerender } = renderRead();
    expect(result.current.summaryParams).toEqual({
      types: [DocumentType.Feature],
    });
    rerender({ term: " evergreen ", list: PAGED_LIST_READ });
    act(() => vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS));
    expect(result.current.summaryParams).toEqual({
      types: [DocumentType.Feature],
      search: "evergreen",
    });
    expect(result.current.summaryParams).not.toHaveProperty("artifactIds");
    expect(result.current.searchAppliedUpstream).toBe(true);
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      {
        types: [DocumentType.Feature],
        search: "evergreen",
        limit: PAGE_SIZE,
        offset: 0,
      },
      expect.objectContaining({ enabled: true })
    );
  });

  it("holds the rows as loading until a typed term settles", () => {
    const { result, rerender } = renderRead();
    rerender({ term: "ever", list: PAGED_LIST_READ });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isSummaryUnsettled).toBe(true);
    act(() => vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS));
    expect(result.current.isLoading).toBe(false);
  });

  it("falls back to the unpaged read for a term the endpoint refuses", () => {
    const longTerm = "x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1);
    mocks.useDocuments.mockReturnValue(idleRead([issue]));
    const { result } = renderRead(longTerm);
    expect(mocks.useDocuments).toHaveBeenLastCalledWith(
      { types: [DocumentType.Feature] },
      { enabled: true }
    );
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
    expect(result.current.isServerPaged).toBe(false);
    expect(result.current.searchAppliedUpstream).toBe(false);
    expect(result.current.pagination).toBeUndefined();
  });

  it("issues no page read until the page-size ladder has resolved", () => {
    mocks.useTablePageSizeOptions.mockImplementation((requested: number) => ({
      isExtendedLadderEnabled: false,
      isReady: false,
      options: TABLE_PAGE_SIZE_OPTIONS,
      pageSize: resolveLegalTablePageSize(requested, TABLE_PAGE_SIZE_OPTIONS),
    }));
    const { result } = renderRead();
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
    expect(result.current.isLoading).toBe(true);
  });

  it("holds the page read while ArtifactList reads the complete population", () => {
    const { rerender } = renderRead();
    rerender({
      term: "",
      list: { completeRead: true, sortBy: "status", sortDir: "asc" },
    });
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
    rerender({ term: "", list: PAGED_LIST_READ });
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true })
    );
  });

  it("returns to the first page when the order ArtifactList renders changes", () => {
    const { result, rerender } = renderRead();
    act(() => result.current.pagination?.onPageChange(1));
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: PAGE_SIZE }),
      expect.anything()
    );
    // A column outside the Documents sort keys still moves the cursor.
    rerender({
      term: "",
      list: { completeRead: true, sortBy: "currentVersion", sortDir: "desc" },
    });
    rerender({ term: "", list: PAGED_LIST_READ });
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0 }),
      expect.objectContaining({ enabled: true })
    );
  });
});
