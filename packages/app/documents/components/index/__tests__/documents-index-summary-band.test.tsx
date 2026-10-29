import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentType,
} from "@repo/api/src/types/document";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FEA-4140: DocumentsIndexView lists DOC artifacts at org scope,
// composing the shared DocumentsView + toolbar. The data hooks are mocked so
// this test asserts the container's contract — it requests DOC
// documents and hands them to the shared table — without a query/DB provider.
const mocks = vi.hoisted(() => ({
  bandProps: vi.fn(),
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
  // Assigned in `beforeEach`: a hoisted factory cannot read an import.
  sort: { sortBy: null as string | null, sortDir: "asc" },
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
    // Partial, not total: the surface under test reaches through MORE of this
    // module than the keys overridden below (ISS-9726), and a total factory
    // drops every export it does not name.
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
    ...mocks.sort,
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
// ISS-9726 wiring: a sentinel namespace, so the assertions below fail if this
// surface ever addresses its raw base literals again.
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));

// The band is a marker too — it owns a real TanStack read, and the point of this
// file is which props the production host hands it, not what the read returns.
vi.mock("@repo/app/documents/components/index/documents-summary-band", () => ({
  DocumentsSummaryBand: (props: Record<string, unknown>) => {
    mocks.bandProps(props);
    return <div data-testid="summary-band" />;
  },
}));

// Leaf surfaces → markers so no navigation/DnD/query providers are needed.
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: () => <div data-testid="toolbar" />,
}));
vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  DocumentsView: (props: Record<string, unknown>) => {
    mocks.documentsViewProps(props);
    return <div data-testid="documents-view" />;
  },
}));

import { DocumentsIndexView } from "@repo/app/documents/components/index/documents-index-view";
import { DOCUMENTS_INDEX_SUMMARY_CARDS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * ISS-8936 — that the PRODUCTION host actually mounts the band, gates it on one
 * PostHog key, and hands it the list's own filters.
 *
 * Deleting the render from `DocumentsIndexView` leaves the band's own suite green,
 * which is why this file exists: it is the only thing that fails when the surface
 * stops mounting it. Both flag arms are covered, and the OFF arm asserts absence
 * rather than merely not asserting presence — a test that passes only because the
 * gate is closed proves nothing about the gate.
 */

/** The props the band was handed on the last render. */
function bandProps(): Record<string, unknown> {
  const props = mocks.bandProps.mock.calls.at(-1)?.[0];
  if (props === undefined) {
    throw new Error("the band was never rendered");
  }
  return props as Record<string, unknown>;
}

/** The flag map every case in this file resolves against. */
function flags(summaryCards: boolean) {
  return (key: string) =>
    key === DOCUMENTS_INDEX_SUMMARY_CARDS_FEATURE_FLAG_KEY
      ? summaryCards
      : false;
}

const DOC = {
  id: "doc-1",
  type: DocumentType.Doc,
  title: "Runbook",
  projectId: null,
};

describe("DocumentsIndexView summary band (ISS-8936)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sort = { sortBy: SortKey.StackRank, sortDir: "asc" };
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    mocks.useFeatureFlagEnabled.mockImplementation(flags(true));
    mocks.useFeatureFlagGate.mockReturnValue({ enabled: false, isReady: true });
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
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
    mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts the band with the flag OPEN", () => {
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("summary-band")).toBeTruthy();
  });

  it("mounts NOTHING with the flag closed — the default", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(flags(false));

    render(<DocumentsIndexView />);

    // Absence, asserted. The band owns a real query hook, so a closed reader must
    // not merely get a disabled read — the component must not be in the tree.
    expect(screen.queryByTestId("summary-band")).toBeNull();
    expect(mocks.bandProps).not.toHaveBeenCalled();
    // The list itself is untouched by this gate.
    expect(screen.getByTestId("documents-view")).toBeTruthy();
  });

  it("hands the band the SAME population the list reads", () => {
    render(<DocumentsIndexView />);

    expect(bandProps().searchParams).toEqual({
      type: DocumentType.Doc,
    });
  });

  it("sends the term to the server even while the list filters in the browser", () => {
    // The server-search gate is CLOSED here, so the list narrows its own rows
    // client-side. The band holds no rows, so a term it did not send is a term it
    // did not apply — it would count the whole population under a search that
    // narrowed the table.
    mocks.useViewStatePersistence.mockReturnValue([
      "runbook",
      vi.fn(),
      vi.fn(),
    ]);
    vi.useFakeTimers();

    render(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(bandProps().searchParams).toEqual({
      type: DocumentType.Doc,
      search: "runbook",
    });
    expect(bandProps().isTermOverLong).toBe(false);
  });

  it("tells the band a term the endpoint refuses is unanswerable", () => {
    const tooLong = "x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1);
    mocks.useViewStatePersistence.mockReturnValue([tooLong, vi.fn(), vi.fn()]);
    vi.useFakeTimers();

    render(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(bandProps().isTermOverLong).toBe(true);
  });

  it("holds the band unsettled until the gate that picks the list's read answers", () => {
    // Which of two reads the list issues is not yet known, so the population the
    // band would summarize is not yet known either. That is a read still to come,
    // which must reach the band as loading rather than as an empty index.
    mocks.useFeatureFlagGate.mockReturnValue({
      enabled: false,
      isReady: false,
    });

    const undecided = render(<DocumentsIndexView />);

    expect(bandProps().isPopulationUnsettled).toBe(true);
    undecided.unmount();

    mocks.useFeatureFlagGate.mockReturnValue({ enabled: false, isReady: true });
    render(<DocumentsIndexView />);

    expect(bandProps().isPopulationUnsettled).toBe(false);
  });

  it("holds the band unsettled while the selected read is still in flight", () => {
    // Kills: dropping `read.isLoading` from `isPopulationUnsettled`. The band
    // counts `rows` on the refused-term arm, and a cold read hands it `[]` — four
    // settled zeroes for a population nothing has read (review thread on #8000).
    mocks.useDocuments.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      refetch: vi.fn(),
    });

    const loading = render(<DocumentsIndexView />);

    expect(bandProps().isPopulationUnsettled).toBe(true);
    expect(bandProps().rows).toEqual([]);
    loading.unmount();

    // Presence half: the same prop settles once the read answers, so the
    // assertion above is not passing on a band that never rendered.
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<DocumentsIndexView />);

    expect(bandProps().isPopulationUnsettled).toBe(false);
    expect(bandProps().rows).toEqual([DOC]);
  });
});

const PAST_THE_DEBOUNCE_MS = 400;
