import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  type DocumentListPage,
  DocumentType,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import type { DocumentsIndexPagination } from "@repo/app/documents/components/documents-index-pagination";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY,
  DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9157 — the Documents index with `documents-index-paged` OPEN.
 *
 * The flag-OFF arm is pinned by `documents-index-view.test.tsx`; this file is
 * the paged arm's contract: which read goes out and with which `limit`/`offset`,
 * what the pager states, and what each body shows for a page that is loading,
 * failed, empty, or past the end. The reads are mocked so every case is reached
 * by the envelope shape it describes; the pager is mocked to capture the ONE
 * descriptor the container hands the body, so its readout, its disabled state
 * and its handlers are asserted directly rather than through the design-system
 * strip (whose own mapping has a case of its own at the bottom).
 */
const mocks = vi.hoisted(() => ({
  useFeatureFlagGate: vi.fn(),
  useDocuments: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useDeleteRowItem: vi.fn(),
  useOrgUsersAsPopoverUsers: vi.fn(),
  useColumnVisibility: vi.fn(),
  useScrollRestore: vi.fn(),
  useViewStatePersistence: vi.fn(),
  useTablePageSizeOptions: vi.fn(),
  documentsViewProps: vi.fn(),
  pagerProps: vi.fn(),
  // Assigned in `beforeEach`: a hoisted factory cannot read an import.
  sort: { sortBy: null as string | null, sortDir: "asc" },
  namespace: "org-a",
}));

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagGate: mocks.useFeatureFlagGate,
  })
);
// Partial: `documentsPageQueryKey` stays real, so the placeholder case below
// hands the container's predicate the SAME key shape the paged hook registers.
vi.mock("@repo/app/documents/hooks/use-documents", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useDocuments: mocks.useDocuments,
  useDocumentsPage: mocks.useDocumentsPage,
  useUpdateDocument: mocks.useUpdateDocument,
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: mocks.useDeleteRowItem,
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: mocks.useOrgUsersAsPopoverUsers,
}));
vi.mock("@repo/app/shared/hooks/use-column-visibility", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useColumnVisibility: mocks.useColumnVisibility };
});
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: mocks.useScrollRestore,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `${mocks.namespace}::${baseKey}`,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    ...mocks.sort,
    setSort: vi.fn(),
    clearSort: vi.fn(),
    clearPersistedSort: vi.fn(),
  }),
}));
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: mocks.useTablePageSizeOptions,
}));
// ISS-8936: this suite resolves EVERY flag open, which now includes the summary
// band — a real component owning a real TanStack read that needs auth/query
// providers this harness deliberately does not mount. A marker, because which
// props the production host hands the band is
// `documents-index-summary-band.test.tsx`'s contract, not this file's.
vi.mock("@repo/app/documents/components/index/documents-summary-band", () => ({
  DocumentsSummaryBand: () => <div data-testid="summary-band" />,
}));
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: () => <div data-testid="toolbar" />,
}));
vi.mock("@repo/app/artifacts/components/artifact-list", async () => {
  const { DocumentsPrototypeHostProbe } = await import(
    "./documents-prototype-host-probe"
  );
  return {
    ArtifactList: (
      props: Parameters<typeof DocumentsPrototypeHostProbe>[0]
    ) => (
      <DocumentsPrototypeHostProbe
        {...props}
        observe={mocks.documentsViewProps}
      />
    ),
  };
});
vi.mock("@repo/app/documents/components/documents-index-pagination", () => ({
  DocumentsIndexPaginationFooter: (props: {
    pagination: DocumentsIndexPagination;
  }) => {
    mocks.pagerProps(props.pagination);
    return <div data-testid="pager" />;
  },
}));

import { DocumentsUniversalIndexView as DocumentsIndexView } from "@repo/app/documents/components/index/documents-universal-index-view";
import { documentsPageQueryKey } from "@repo/app/documents/hooks/use-documents";

const BLOCKING_ERROR_HEADING = "Couldn't load documents";
const INDEX_EMPTY_HEADING = "No documents yet";
const NO_RESULTS_HEADING = "No documents match your search";
const READOUT_NOUN = "documents";
const PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[0];
const LARGER_PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[1];
const PAST_THE_DEBOUNCE_MS = 400;

type ReadShape = Partial<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  refetch: () => void;
}>;

// Only the fields this surface reads — it counts rows and keys them by id, and
// never touches the rest of the record.
function docs(count: number, prefix = "doc"): DocumentWithProject[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    type: DocumentType.Doc,
    title: `${prefix} ${index}`,
    slug: `${prefix}-${index}`,
    projectId: null,
  })) as DocumentWithProject[];
}

function page(overrides: Partial<DocumentListPage>): DocumentListPage {
  return {
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
    hasMore: false,
    ...overrides,
  };
}

function givenPagedRead(read: ReadShape) {
  mocks.useDocumentsPage.mockReturnValue({
    data: read.data,
    isLoading: read.isLoading ?? false,
    isFetching: read.isFetching ?? false,
    isError: read.isError ?? false,
    isPlaceholderData: read.isPlaceholderData ?? false,
    refetch: read.refetch ?? vi.fn(),
  });
}

function givenUnboundedRead(read: ReadShape) {
  mocks.useDocuments.mockReturnValue({
    data: read.data ?? [],
    isLoading: read.isLoading ?? false,
    isFetching: read.isFetching ?? false,
    isError: read.isError ?? false,
    refetch: read.refetch ?? vi.fn(),
  });
}

function givenGates({
  paged = true,
  pagedReady = true,
  serverSearch = false,
}: {
  paged?: boolean;
  pagedReady?: boolean;
  serverSearch?: boolean;
} = {}) {
  mocks.useFeatureFlagGate.mockImplementation((key: string) => {
    if (key === DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY) {
      return { enabled: paged, isReady: pagedReady };
    }
    return {
      enabled:
        key === DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY && serverSearch,
      isReady: true,
    };
  });
}

function givenLadder({ isReady = true }: { isReady?: boolean } = {}) {
  mocks.useTablePageSizeOptions.mockImplementation((requested: number) => ({
    isExtendedLadderEnabled: false,
    isReady,
    options: TABLE_PAGE_SIZE_OPTIONS,
    pageSize: resolveLegalTablePageSize(requested, TABLE_PAGE_SIZE_OPTIONS),
  }));
}

function givenSearch(text: string, persistedPageSize?: number) {
  mocks.useViewStatePersistence.mockImplementation(
    (key: string, defaultValue: unknown) =>
      key.includes("page-size")
        ? [persistedPageSize ?? defaultValue, vi.fn(), vi.fn()]
        : [text, vi.fn(), vi.fn()]
  );
}

function pagedCalls(): { limit?: number; offset?: number; search?: string }[] {
  return mocks.useDocumentsPage.mock.calls.map((call) => call[0]);
}

function lastPagedParams() {
  return pagedCalls().at(-1);
}

function lastPagedOptions():
  | {
      enabled?: boolean;
      placeholderData?: (
        previous: DocumentListPage | undefined,
        previousQuery: { queryKey: readonly unknown[] } | undefined
      ) => DocumentListPage | undefined;
    }
  | undefined {
  return mocks.useDocumentsPage.mock.calls.at(-1)?.[1];
}

function lastUnboundedOptions(): { enabled?: boolean } | undefined {
  return mocks.useDocuments.mock.calls.at(-1)?.[1];
}

function lastDescriptor(): DocumentsIndexPagination | undefined {
  return mocks.pagerProps.mock.calls.at(-1)?.[0];
}

function tableProps(): Record<string, unknown> | undefined {
  return mocks.documentsViewProps.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sort = { sortBy: SortKey.StackRank, sortDir: "asc" };
  mocks.namespace = "org-a";
  givenGates();
  givenLadder();
  givenSearch("");
  givenUnboundedRead({});
  givenPagedRead({ data: page({ items: docs(2), total: 137 }) });
  mocks.useUpdateDocument.mockReturnValue({ mutate: vi.fn() });
  mocks.useDeleteRowItem.mockReturnValue(vi.fn());
  mocks.useOrgUsersAsPopoverUsers.mockReturnValue([]);
  mocks.useColumnVisibility.mockReturnValue({
    visibility: {},
    userVisibility: {},
    visibleColumns: [DocumentColumn.Assignee, DocumentColumn.Updated],
    toggleColumn: vi.fn(),
    reorderColumns: vi.fn(),
  });
  mocks.useScrollRestore.mockReturnValue({ clearPosition: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which read goes out", () => {
  it("reads one server page — limit and offset 0 — and issues no unbounded read", () => {
    render(<DocumentsIndexView />);

    expect(lastPagedParams()).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(lastPagedOptions()).toMatchObject({ enabled: true });
    expect(lastUnboundedOptions()).toMatchObject({ enabled: false });
  });

  it("holds BOTH reads and shows loading while the paged gate is unresolved", () => {
    givenGates({ pagedReady: false });
    givenPagedRead({ data: undefined });
    render(<DocumentsIndexView />);

    expect(lastPagedOptions()).toMatchObject({ enabled: false });
    expect(lastUnboundedOptions()).toMatchObject({ enabled: false });
    expect(tableProps()?.isLoading).toBe(true);
    expect(screen.queryByText(INDEX_EMPTY_HEADING)).not.toBeInTheDocument();
    // No envelope yet, so no pager: a strip here would count pages nothing
    // has measured.
    expect(screen.queryByTestId("pager")).not.toBeInTheDocument();
  });

  it("holds the paged read while the page-size ladder is unresolved", () => {
    givenLadder({ isReady: false });
    givenPagedRead({ data: undefined });
    render(<DocumentsIndexView />);

    expect(lastPagedOptions()).toMatchObject({ enabled: false });
    expect(lastUnboundedOptions()).toMatchObject({ enabled: false });
    expect(tableProps()?.isLoading).toBe(true);
  });

  it("hands the read a placeholder that keeps the previous page only under the same term", () => {
    // The predicate itself has direct cases in
    // `documents-index-paged-read.test.ts`; this pins that the container
    // actually wires it, with the term it is reading for, into the paged read.
    givenSearch("runbook");
    render(<DocumentsIndexView />);
    const placeholderData = lastPagedOptions()?.placeholderData;
    expect(placeholderData).toBeTypeOf("function");
    const previous = page({ items: docs(2), total: 137, offset: PAGE_SIZE });
    const previousQueryFor = (search?: string) => ({
      queryKey: documentsPageQueryKey({
        recencyDays: 30,
        types: [
          DocumentType.Prd,
          DocumentType.ImplementationPlan,
          DocumentType.Doc,
        ],
        ...(search === undefined ? {} : { search }),
        limit: PAGE_SIZE,
        offset: PAGE_SIZE,
      }),
    });

    expect(placeholderData?.(previous, previousQueryFor("runbook"))).toBe(
      previous
    );
    expect(
      placeholderData?.(previous, previousQueryFor(undefined))
    ).toBeUndefined();
    expect(
      placeholderData?.(previous, previousQueryFor("playbook"))
    ).toBeUndefined();
  });

  it("searches on the server even with the server-search flag closed", () => {
    givenSearch("runbook");
    render(<DocumentsIndexView />);

    expect(lastPagedParams()).toMatchObject({ search: "runbook", offset: 0 });
    expect(lastUnboundedOptions()).toMatchObject({ enabled: false });
  });

  it("falls back to the unbounded read, with no pager, for a term the endpoint refuses", () => {
    givenSearch("x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1));
    givenUnboundedRead({ data: docs(3) });
    render(<DocumentsIndexView />);

    expect(lastUnboundedOptions()).toMatchObject({ enabled: true });
    expect(mocks.useDocuments.mock.calls.at(-1)?.[0]).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
    });
    expect(lastPagedOptions()).toMatchObject({ enabled: false });
    expect(screen.queryByTestId("pager")).not.toBeInTheDocument();
    expect(tableProps()?.documents).toHaveLength(3);
  });
});

describe("the cursor", () => {
  it("turns the page by advancing the offset one page size", () => {
    render(<DocumentsIndexView />);

    act(() => lastDescriptor()?.onPageChange(1));

    expect(lastPagedParams()).toMatchObject({
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
  });

  it("returns to the first page the moment a settled search term changes, never asking for the old offset", () => {
    vi.useFakeTimers();
    const { rerender } = render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(2));
    expect(lastPagedParams()).toMatchObject({ offset: 2 * PAGE_SIZE });
    const callsBefore = pagedCalls().length;

    givenSearch("runbook");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    const searchedCalls = pagedCalls()
      .slice(callsBefore)
      .filter((params) => params.search === "runbook");
    expect(searchedCalls.length).toBeGreaterThan(0);
    expect(searchedCalls.every((params) => params.offset === 0)).toBe(true);
  });

  it("returns to the first page when the table's sort changes", () => {
    const { rerender } = render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(1));
    const callsBefore = pagedCalls().length;

    mocks.sort = { sortBy: SortKey.Title, sortDir: "desc" };
    rerender(<DocumentsIndexView />);

    const after = pagedCalls().slice(callsBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((params) => params.offset === 0)).toBe(true);
  });

  it("returns to the first page when the organization changes", () => {
    const { rerender } = render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(1));
    const callsBefore = pagedCalls().length;

    mocks.namespace = "org-b";
    rerender(<DocumentsIndexView />);

    const after = pagedCalls().slice(callsBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((params) => params.offset === 0)).toBe(true);
  });

  it("reads the next organization at its own size, not the size chosen in the previous one", () => {
    const { rerender } = render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageSizeChange?.(LARGER_PAGE_SIZE));
    expect(lastPagedParams()).toMatchObject({ limit: LARGER_PAGE_SIZE });
    const callsBefore = pagedCalls().length;

    mocks.namespace = "org-b";
    rerender(<DocumentsIndexView />);

    const after = pagedCalls().slice(callsBefore);
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.every((params) => params.limit === PAGE_SIZE && params.offset === 0)
    ).toBe(true);
  });

  it("re-reads at the new size from the first page when the rows-per-page changes", () => {
    render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(1));

    act(() => lastDescriptor()?.onPageSizeChange?.(LARGER_PAGE_SIZE));

    expect(lastPagedParams()).toMatchObject({
      limit: LARGER_PAGE_SIZE,
      offset: 0,
    });
  });

  it("writes the cursor back down when the server's total no longer reaches the requested page", () => {
    // Page 2 requested (offset 50) of a population of 30: the server answers
    // an empty page. That is a hold — never an empty index — until the clamp
    // moves the reader to the last real page.
    givenPagedRead({
      data: page({ items: [], total: 30, offset: 2 * PAGE_SIZE }),
    });
    render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(2));

    expect(screen.queryByText(INDEX_EMPTY_HEADING)).not.toBeInTheDocument();
    expect(tableProps()?.isLoading).toBe(true);
    expect(lastPagedParams()).toMatchObject({ offset: PAGE_SIZE });
  });

  it("holds a nonzero page that came back with total 0, rather than calling the index empty", () => {
    // Page 1 requested (offset 25) after every document was deleted: the
    // server answers an empty page AND a zero total. Same hold as above — the
    // clamp is about to move the reader to page 0, whose own answer is the
    // one that gets to say whether the index is empty.
    givenPagedRead({
      data: page({ items: [], total: 0, offset: PAGE_SIZE }),
    });
    render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(1));

    expect(screen.queryByText(INDEX_EMPTY_HEADING)).not.toBeInTheDocument();
    expect(tableProps()?.isLoading).toBe(true);
    expect(lastPagedParams()).toMatchObject({ offset: 0 });
  });
});

describe("what the pager states", () => {
  it("states the envelope's total, not the rows on screen", () => {
    render(<DocumentsIndexView />);

    const descriptor = lastDescriptor();
    expect(descriptor?.readout).toBe(`1–2 of 137 ${READOUT_NOUN}`);
    expect(descriptor?.page).toBe(0);
    expect(descriptor?.totalPages).toBe(6);
    expect(descriptor?.disabled).toBe(false);
    expect(descriptor?.pageSize).toBe(PAGE_SIZE);
    expect(descriptor?.onPageSizeChange).toBeTypeOf("function");
    expect(tableProps()?.documents).toHaveLength(2);
    expect(tableProps()?.isServerPaged).toBe(true);
  });

  it("describes the page the server actually served, not the one requested", () => {
    // An older API that ignores `limit` answers the whole set as a bare array,
    // which the reader folds into one unbounded page.
    givenPagedRead({
      data: page({ items: docs(40), total: 40, limit: null, offset: 0 }),
    });
    render(<DocumentsIndexView />);
    act(() => lastDescriptor()?.onPageChange(1));

    const descriptor = lastDescriptor();
    expect(descriptor?.page).toBe(0);
    expect(descriptor?.totalPages).toBe(1);
    expect(descriptor?.readout).toBe(`1–40 of 40 ${READOUT_NOUN}`);
    expect(tableProps()?.documents).toHaveLength(40);
    // The server applied no bound, so there is no rows-per-page to offer.
    expect(descriptor?.onPageSizeChange).toBeUndefined();
    expect(descriptor?.pageSize).toBeUndefined();
  });

  it("follows a page the server narrowed where it ended, and offers no rows-per-page over it", () => {
    // A version-skewed API whose cap sits below the ladder's rung: 50 asked
    // for, 25 served. The envelope says so, so the pager describes 25, the
    // next page is asked for at offset 25 (not 50, which would skip rows
    // 26–50), and the size control is withheld — it can state neither the 50
    // nothing applied nor a 25 the reader did not choose (whitlockk review, #7568).
    givenSearch("", LARGER_PAGE_SIZE);
    givenPagedRead({
      data: page({ items: docs(PAGE_SIZE), total: 137, limit: PAGE_SIZE }),
    });
    render(<DocumentsIndexView />);
    expect(lastPagedParams()).toMatchObject({
      limit: LARGER_PAGE_SIZE,
      offset: 0,
    });

    const descriptor = lastDescriptor();
    expect(descriptor?.readout).toBe(`1–${PAGE_SIZE} of 137 ${READOUT_NOUN}`);
    expect(descriptor?.totalPages).toBe(6);
    expect(descriptor?.pageSize).toBeUndefined();
    expect(descriptor?.onPageSizeChange).toBeUndefined();

    act(() => descriptor?.onPageChange(1));

    expect(lastPagedParams()).toMatchObject({
      limit: LARGER_PAGE_SIZE,
      offset: PAGE_SIZE,
    });
  });

  it("keeps the previous page's rows under a pinned, silent pager while the next page loads", () => {
    givenPagedRead({
      data: page({ items: docs(2), total: 137 }),
      isFetching: true,
      isPlaceholderData: true,
    });
    render(<DocumentsIndexView />);

    expect(tableProps()?.documents).toHaveLength(2);
    expect(lastDescriptor()?.disabled).toBe(true);
    expect(lastDescriptor()?.readout).toBeNull();
  });

  it("reads as loading, not as no-results, while a typed term is still settling", () => {
    vi.useFakeTimers();
    givenPagedRead({ data: page({ items: [], total: 0 }) });
    const { rerender } = render(<DocumentsIndexView />);

    givenSearch("runbook");
    rerender(<DocumentsIndexView />);

    expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
    expect(tableProps()?.isLoading).toBe(true);
  });

  it("pins the pager, silent, over the skeleton while a typed term is still settling", () => {
    vi.useFakeTimers();
    givenPagedRead({ data: page({ items: docs(2), total: 137 }) });
    const { rerender } = render(<DocumentsIndexView />);
    expect(lastDescriptor()?.disabled).toBe(false);
    expect(lastDescriptor()?.readout).toBe(`1–2 of 137 ${READOUT_NOUN}`);

    givenSearch("runbook");
    rerender(<DocumentsIndexView />);

    expect(tableProps()?.isLoading).toBe(true);
    expect(lastDescriptor()?.disabled).toBe(true);
    expect(lastDescriptor()?.readout).toBeNull();
  });
});

describe("what each body shows", () => {
  it("blocks with a retry and no pager when a page turn fails with nothing for that page", () => {
    givenPagedRead({ data: undefined, isError: true });
    render(<DocumentsIndexView />);

    expect(screen.getByText(BLOCKING_ERROR_HEADING)).toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pager")).not.toBeInTheDocument();
  });

  it("keeps the rows and the pager when a refetch of the same page fails", () => {
    givenPagedRead({
      data: page({ items: docs(2), total: 137 }),
      isError: true,
    });
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(screen.getByTestId("pager")).toBeInTheDocument();
  });

  it("shows the first-use empty state, and no pager, for an empty first page", () => {
    givenPagedRead({ data: page({ items: [], total: 0 }) });
    render(<DocumentsIndexView />);

    expect(screen.getByText(INDEX_EMPTY_HEADING)).toBeInTheDocument();
    expect(screen.queryByTestId("pager")).not.toBeInTheDocument();
  });

  it("survives an empty legacy bare-array answer", () => {
    givenPagedRead({
      data: page({ items: [], total: 0, limit: null, offset: 0 }),
    });
    render(<DocumentsIndexView />);

    expect(screen.getByText(INDEX_EMPTY_HEADING)).toBeInTheDocument();
  });

  it("names the search, not the organization, when the server answered a term with no rows", () => {
    givenSearch("nothing-here");
    givenPagedRead({ data: page({ items: [], total: 0 }) });
    render(<DocumentsIndexView />);

    expect(screen.getByText(NO_RESULTS_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(INDEX_EMPTY_HEADING)).not.toBeInTheDocument();
  });

  it("renders the pager under the six-state body too, and never over its blocking error", () => {
    const { unmount } = render(<DocumentsIndexView />);
    expect(screen.getByTestId("pager")).toBeInTheDocument();
    unmount();

    givenPagedRead({ data: undefined, isError: true });
    render(<DocumentsIndexView />);
    expect(screen.getByText(BLOCKING_ERROR_HEADING)).toBeInTheDocument();
    expect(screen.queryByTestId("pager")).not.toBeInTheDocument();
  });
});
