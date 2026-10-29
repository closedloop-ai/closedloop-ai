import { DocumentType } from "@repo/api/src/types/document";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8940, flag ON. Each state gets its own assertion on something only that
 * state can render, because a suite that only checked "the table is there"
 * could not tell loading from true-zero from a failed read — the exact
 * conflation this ticket exists to remove.
 *
 * The data hooks are mocked so each state is reached by the read shape that
 * produces it in production (TanStack Query's own `isLoading`/`isFetching`/
 * `isError` combinations) rather than by a prop the container does not have.
 */
const mocks = vi.hoisted(() => ({
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagGate: vi.fn(),
  useDocuments: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useDeleteRowItem: vi.fn(),
  useOrgUsersAsPopoverUsers: vi.fn(),
  useColumnVisibility: vi.fn(),
  useScrollRestore: vi.fn(),
  useViewStatePersistence: vi.fn(),
  documentsViewProps: vi.fn(),
}));
/**
 * ISS-9157: the paged read as every case in this file sees it — mounted with
 * its gate CLOSED and resolved, so it issues nothing and hands back nothing.
 * Set after each `clearAllMocks` beside the unbounded read's own default.
 */
function pagedReadDisabled() {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial: this module gained exports (ISS-9726) the surface under test now
    // reaches through, and a total mock silently drops them.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagGate: mocks.useFeatureFlagGate,
  })
);
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
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
// ISS-9157: the container reads the table's sort for its cursor reset. The
// real hook needs the app router; the shipped default sort is what it would
// resolve to with no URL and no persisted choice.
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    sortBy: SortKey.StackRank,
    sortDir: "asc",
    setSort: vi.fn(),
    clearSort: vi.fn(),
    clearPersistedSort: vi.fn(),
  }),
}));
// ISS-9157: the ladder resolves closed and ready, as it does with no provider.
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: (requested: number) => ({
    isExtendedLadderEnabled: false,
    isReady: true,
    options: TABLE_PAGE_SIZE_OPTIONS,
    pageSize: resolveLegalTablePageSize(requested, TABLE_PAGE_SIZE_OPTIONS),
  }),
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
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
vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  // Renders DIFFERENTLY for a loading read, so the loading assertions below
  // observe something in the DOM rather than only a captured call argument —
  // a prop check alone would pass on a table that ignored the prop.
  DocumentsView: (props: Record<string, unknown>) => {
    mocks.documentsViewProps(props);
    return props.isLoading ? (
      <div data-testid="documents-view-loading" />
    ) : (
      <div data-testid="documents-view" />
    );
  },
}));

import { DocumentsIndexView } from "@repo/app/documents/components/index/documents-index-view";

const DOC = {
  id: "doc-1",
  slug: "DOC-1",
  type: DocumentType.Doc,
  title: "Incident runbook",
  projectId: null,
};

const BLOCKING_ERROR_TITLE = "Couldn't load documents";
const FIRST_USE_EMPTY_TITLE = "No documents yet";
const NO_RESULTS_TITLE = "No documents match your search";
/**
 * The no-match SENTENCE, pinned on the client-filtered path too. One screen
 * serves both search modes, so wording it for only the server-answered reader
 * is a reachable divergence (ISS-9762) that a title-only assertion would miss.
 */
const NO_RESULTS_BODY =
  "No documents match your search. Try another term, or clear it.";
const STALE_NOTICE = /last loaded documents/i;
/** Owned by the stale-plus-no-match state alone — no other screen says it. */
const STALE_NO_RESULTS_BODY =
  "These are the documents that loaded before the refresh failed, and none of them match this search.";

type ReadShape = {
  data?: unknown[];
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  refetch?: () => void;
};

function givenRead(read: ReadShape) {
  mocks.useDocuments.mockReturnValue({
    data: read.data ?? [],
    isLoading: read.isLoading ?? false,
    isFetching: read.isFetching ?? false,
    isError: read.isError ?? false,
    refetch: read.refetch ?? vi.fn(),
  });
}

function givenSearch(text: string) {
  mocks.useViewStatePersistence.mockReturnValue([text, vi.fn(), vi.fn()]);
}

/** The `isLoading` the shared table was actually handed on the last render. */
function tableLoadingProp(): boolean | undefined {
  const props = mocks.documentsViewProps.mock.calls.at(-1)?.[0] as
    | { isLoading?: boolean }
    | undefined;
  return props?.isLoading;
}

describe("Documents index six states (flag on)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    mocks.useFeatureFlagEnabled.mockReturnValue(true);
    // ISS-9724: the server-search gate stays CLOSED and resolved here, so every
    // case in this file keeps describing the client-side-search behavior it was
    // written for rather than silently becoming a server-search test.
    mocks.useFeatureFlagGate.mockReturnValue({
      enabled: false,
      isReady: true,
    });
    givenRead({ data: [DOC] });
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
    givenSearch("");
  });

  it("shows the table as loading, and no count or zero-state, while the first read is open", () => {
    givenRead({ data: [], isLoading: true, isFetching: true });
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view-loading")).toBeInTheDocument();
    expect(tableLoadingProp()).toBe(true);
    // The whole point: an unsettled read must not be described as an absence.
    expect(screen.queryByText(FIRST_USE_EMPTY_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(BLOCKING_ERROR_TITLE)).not.toBeInTheDocument();
  });

  it("still shows loading, not zero, when a refetch is open over an empty cache", () => {
    givenRead({ data: [], isLoading: false, isFetching: true });
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view-loading")).toBeInTheDocument();
    expect(screen.queryByText(FIRST_USE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("renders a settled populated read as the table alone, with no notice", () => {
    givenRead({ data: [DOC] });
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(
      screen.queryByTestId("documents-view-loading")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(FIRST_USE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("renders a search that still matches rows as an ordinary populated table", () => {
    // The common case, and the one that separates "narrowed" from "zeroed":
    // the search matches DOC's title, so the surface must not claim no results.
    givenRead({ data: [DOC] });
    givenSearch("runbook");
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(FIRST_USE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("names the first-use empty state when the organization genuinely has none", () => {
    givenRead({ data: [] });
    render(<DocumentsIndexView />);

    expect(screen.getByText(FIRST_USE_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
  });

  it("distinguishes no-results-under-a-search from having no documents at all", () => {
    givenRead({ data: [DOC] });
    givenSearch("nothing matches this");
    render(<DocumentsIndexView />);

    expect(screen.getByText(NO_RESULTS_TITLE)).toBeInTheDocument();
    expect(screen.getByText(NO_RESULTS_BODY)).toBeInTheDocument();
    expect(screen.queryByText(FIRST_USE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("blames nothing on the search when the organization has no documents and a search is typed", () => {
    // Pre-ISS-8940 this read reached neither empty branch and let the table
    // claim a filter was hiding documents that do not exist.
    givenRead({ data: [] });
    givenSearch("runbook");
    render(<DocumentsIndexView />);

    expect(screen.getByText(FIRST_USE_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS_TITLE)).not.toBeInTheDocument();
  });

  it("blocks with a retry when the read failed and nothing is cached", async () => {
    const refetch = vi.fn();
    givenRead({ data: [], isError: true, refetch });
    render(<DocumentsIndexView />);

    expect(screen.getByText(BLOCKING_ERROR_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    // The toolbar stays: the failure is a sibling below it, not a page collapse.
    expect(screen.getByTestId("toolbar")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps usable rows and says the refresh failed, rather than blanking or staying silent", async () => {
    const refetch = vi.fn();
    givenRead({ data: [DOC], isError: true, refetch });
    render(<DocumentsIndexView />);

    // Rows survive the failed refresh...
    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(screen.queryByText(BLOCKING_ERROR_TITLE)).not.toBeInTheDocument();
    // ...and the surface says they are no longer known to be current, instead
    // of presenting stale rows as settled data.
    expect(screen.getByRole("status")).toHaveTextContent(STALE_NOTICE);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("answers a stale read that matches nothing with one screen, not a banner over an empty one", async () => {
    /*
     * DELIBERATE EXPECTATION CHANGE (whitlockk review, cid 3955716628). This case
     * used to assert the stale BANNER *and* the plain no-results empty state on
     * screen together. That screen said "Showing your last loaded documents"
     * while showing none of them — a false statement, and two of the supposedly
     * mutually exclusive states rendered at once. The behavior changed: the
     * intersection is now its own resolved state with its own copy, so the
     * assertions below pin one screen that states both facts and keeps the
     * retry, and pin the ABSENCE of the banner that made the claim.
     */
    const refetch = vi.fn();
    givenRead({ data: [DOC], isError: true, refetch });
    givenSearch("nothing matches this");
    render(<DocumentsIndexView />);

    expect(screen.getByText(NO_RESULTS_TITLE)).toBeInTheDocument();
    expect(screen.getByText(STALE_NO_RESULTS_BODY)).toBeInTheDocument();
    // The banner claimed to be showing rows that this screen does not show.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();

    // The read still failed, so the reader is not stranded without a retry.
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not put the stale-read sentence on an ordinary no-results screen", () => {
    // The pair to the case above: with a healthy read the no-results copy must
    // not imply a refresh failure that did not happen.
    givenRead({ data: [DOC] });
    givenSearch("nothing matches this");
    render(<DocumentsIndexView />);

    expect(screen.getByText(NO_RESULTS_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(STALE_NO_RESULTS_BODY)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
  });

  it("does not report a failed refresh as loading, even while a retry is in flight", () => {
    // A retry after a failure has `isError` and `isFetching` both true. The
    // failure outranks the fetch: the reader is told the rows are stale, not
    // that the surface is loading over rows it is already showing.
    givenRead({ data: [DOC], isError: true, isFetching: true });
    render(<DocumentsIndexView />);

    expect(tableLoadingProp()).toBe(false);
    expect(
      screen.queryByTestId("documents-view-loading")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(STALE_NOTICE);
  });
});
