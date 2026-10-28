import { DocumentType } from "@repo/api/src/types/document";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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

// Leaf surfaces → markers so no navigation/DnD/query providers are needed.
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

import { DocumentsUniversalIndexView as DocumentsIndexView } from "@repo/app/documents/components/index/documents-universal-index-view";

const PAST_THE_DEBOUNCE_MS = 400;

const DOC = {
  id: "doc-1",
  type: DocumentType.Doc,
  title: "Runbook",
  projectId: null,
};

describe("DocumentsIndexView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sort = { sortBy: SortKey.StackRank, sortDir: "asc" };
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    // ISS-8940 ships its six-state body closed by default, so every assertion
    // in this file describes the flag-OFF arm unless it says otherwise. The
    // flag-ON arm has its own suite (`documents-index-states.test.tsx`).
    // ISS-9724: the server-search gate stays CLOSED and resolved here, so every
    // case in this file keeps describing the client-side-search behavior it was
    // written for rather than silently becoming a server-search test.
    mocks.useFeatureFlagGate.mockReturnValue({
      enabled: false,
      isReady: true,
    });
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
      // The index pins DOCUMENTS_INDEX_COLUMNS (Assignee, Updated) — the Type
      // column is never in the set, mirroring the hook's real output for this
      // surface so the "Type column dropped" assertion is exercised, not skipped.
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

  it("requests all three document subtypes at org scope", () => {
    render(<DocumentsIndexView />);

    // ISS-9724 added a second argument (the query's `enabled`). The params
    // themselves are unchanged with the server-search gate closed, which is the
    // contract this case has always asserted; `enabled: true` is asserted too so
    // the flag-off arm cannot start withholding its read.
    expect(mocks.useDocuments).toHaveBeenCalledWith(
      {
        recencyDays: 30,
        types: [
          DocumentType.Prd,
          DocumentType.ImplementationPlan,
          DocumentType.Doc,
        ],
      },
      { enabled: true }
    );
  });

  it("issues no paged read and hands the body no pager with the paged flag closed (ISS-9157)", () => {
    render(<DocumentsIndexView />);

    // The shipped request, byte for byte: no `limit`, no `offset`, and the
    // paged reader mounted but held. The body sees neither a pagination
    // descriptor nor a paged-caller signal, so the table derives emptiness
    // from its rows exactly as it did before.
    expect(mocks.useDocuments.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "limit"
    );
    expect(mocks.useDocumentsPage.mock.calls.at(-1)?.[1]).toMatchObject({
      enabled: false,
    });
    expect(mocks.documentsViewProps.mock.calls.at(-1)?.[0]).toMatchObject({
      isServerPaged: false,
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders the shared document table with the fetched documents", () => {
    render(<DocumentsIndexView />);

    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    const props = mocks.documentsViewProps.mock.calls.at(-1)?.[0] as {
      documents: unknown[];
      filterCategory: string;
      treeData: unknown;
      isServerPaged: boolean;
      searchParams: unknown;
    };
    expect(props.documents).toEqual([DOC]);
    // Project-less docs have no project tree, so the org index runs the shared
    // pipeline's flat fallback (treeData null, "all" category).
    expect(props.isServerPaged).toBe(false);
    expect(props.searchParams).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
    });
  });

  it("leaves the reader's scroll position alone when the sort or the search changes (ISS-9157)", () => {
    // The paged cursor hook mounts on this arm too. Its scroll-to-top rides
    // only on a reset that MOVED the cursor, and this arm never turns a page,
    // so a sort or a settled search term must not move the container — the
    // shipped surface, not just the shipped request, is unchanged with the
    // flag closed (marisolashgrove review, #7568).
    vi.useFakeTimers();
    const { rerender } = render(<DocumentsIndexView />);
    const container = screen.getByTestId("documents-view")
      .parentElement as HTMLElement;
    container.scrollTop = 120;

    mocks.sort = { sortBy: SortKey.Title, sortDir: "desc" };
    rerender(<DocumentsIndexView />);
    expect(container.scrollTop).toBe(120);

    mocks.useViewStatePersistence.mockReturnValue([
      "runbook",
      vi.fn(),
      vi.fn(),
    ]);
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });
    expect(container.scrollTop).toBe(120);
  });
});

describe("ISS-9726 persisted view-state wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    mocks.useFeatureFlagGate.mockReturnValue({ enabled: false, isReady: true });
    // A populated read, so the body renders the TABLE rather than the
    // first-use empty state — the keys under test only reach DocumentsView.
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

  it("hands the shared table the identity-namespaced sort and expansion keys", () => {
    render(<DocumentsIndexView />);

    expect(mocks.documentsViewProps).toHaveBeenCalledWith(
      expect.objectContaining({
        sortPersistenceKey: "ns::table:sort:documents-index",
        storageKey: "ns::documents-index-artifacts",
      })
    );
  });

  it("reads search, scroll, and column state under namespaced keys", () => {
    render(<DocumentsIndexView />);

    expect(mocks.useViewStatePersistence).toHaveBeenCalledWith(
      "ns::table:search:documents-index",
      ""
    );
    expect(mocks.useScrollRestore).toHaveBeenCalledWith(
      "ns::table:scroll:documents-index",
      null
    );
  });
});

/**
 * ISS-9819 — the flag-OFF body must tell a no-match search from an empty index.
 *
 * THE PERMUTATION IS THE POINT. The two keys are read independently, so
 * `documents-index-server-search` ON with `documents-index-states` OFF is a real
 * state, and it is the only one that reaches this defect: turning both off never
 * sends a term to the server, and turning both on runs the v2 body ISS-9762
 * already fixed. No test drove this pair before.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. `DocumentsView` is mocked in this file,
 * so the empty-corpus sentence it renders — "No artifacts yet — Create a PRD,
 * issue, or plan." — is not reachable from here directly. It is reachable only
 * THROUGH that component, so "the table did not render" is the same claim, and it
 * is paired with the heading that must have replaced it. Under the defect the
 * mocked table renders and neither absence holds.
 *
 * The two cases falsify each other: the first is a populated organization whose
 * term matched nothing and must NOT get the empty-corpus screen; the second is a
 * genuinely empty organization with no term and must still get it. A fix that
 * routed every zero-row read to the no-match screen passes the first and fails
 * the second.
 */
describe("server-searched universal view empty states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    // Key-aware since ISS-9157 gave this surface a second gate: only the
    // server-search key is open here; the paged key stays closed and resolved.
    mocks.useFeatureFlagGate.mockImplementation((key: string) => ({
      enabled: key === DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY,
      isReady: true,
    }));
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

  it("does not claim an empty corpus when the server answered a term with no rows", () => {
    // A term restored from view state, so it is settled at first render: the
    // debounce hook seeds its state from the value it is given.
    mocks.useViewStatePersistence.mockReturnValue([
      "runbook",
      vi.fn(),
      vi.fn(),
    ]);
    mocks.useDocuments.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<DocumentsIndexView />);

    // The term reached the wire — without this the read is not the one the case
    // is about, and the assertions below would hold for the wrong reason.
    expect(mocks.useDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ search: "runbook" }),
      { enabled: true }
    );
    expect(
      screen.getByText("No documents match your search")
    ).toBeInTheDocument();
    // The empty-corpus sentence lives inside the shared table, so its absence is
    // exactly this: the table never rendered.
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    expect(screen.queryByText("No documents yet")).not.toBeInTheDocument();
  });

  it("still shows the empty-corpus state for an organization that genuinely has none", () => {
    mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
    mocks.useDocuments.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<DocumentsIndexView />);

    // No term, so nothing was searched upstream and the zero IS the population.
    expect(mocks.useDocuments).toHaveBeenCalledWith(
      {
        recencyDays: 30,
        types: [
          DocumentType.Prd,
          DocumentType.ImplementationPlan,
          DocumentType.Doc,
        ],
      },
      { enabled: true }
    );
    expect(screen.getByText("No documents yet")).toBeInTheDocument();
    expect(
      screen.queryByText("No documents match your search")
    ).not.toBeInTheDocument();
  });

  it("reads the server-search gate", () => {
    mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
    mocks.useDocuments.mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<DocumentsIndexView />);

    expect(mocks.useFeatureFlagGate).toHaveBeenCalledWith(
      DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY
    );
  });
});
