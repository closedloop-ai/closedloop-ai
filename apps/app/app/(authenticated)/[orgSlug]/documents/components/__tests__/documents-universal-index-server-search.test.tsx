import {
  DOCUMENT_LIST_MAX_SEARCH_LENGTH,
  DocumentType,
} from "@repo/api/src/types/document";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9724 — the Documents index sends its search term to the server, and the
 * gap before it does is loading rather than a verdict.
 *
 * The flag-ON arm only. `documents-index-view.test.tsx` owns the flag-OFF arm,
 * which this change must leave byte-identical: with the key off the container
 * sends the SAME params it sends today, which is asserted here too rather than
 * assumed, because a gate that leaks is not a gate.
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

/** Longer than the container's debounce, so a settled term is unambiguous. */
const PAST_THE_DEBOUNCE_MS = 500;
/**
 * A realistic gap between keypresses, strictly UNDER the debounce. The
 * coalescing case advances by this between keystrokes so it fails if the
 * debounce is ever shortened below typing cadence.
 */
const BETWEEN_KEYSTROKES_MS = 100;
/** The copy the six-state body shows for a settled zero-match verdict. */
const NO_RESULTS_HEADING = "No documents match your search";
/**
 * The sentence under the no-match heading. Pinned as an independent literal —
 * the point of ISS-9762 is that this ONE sentence has to be true for two
 * different populations, so a test that read it off the component could not
 * police it.
 */
const NO_RESULTS_BODY =
  "No documents match your search. Try another term, or clear it.";
/** The copy reserved for an organization that genuinely holds no documents. */
const FIRST_USE_EMPTY_HEADING = "No documents yet";
/** The copy for a read that failed with nothing cached to fall back on. */
const BLOCKING_ERROR_HEADING = "Couldn't load documents";
/** What the server returns for a term that matched nothing. */
const NO_MATCHING_ROWS: unknown[] = [];

const DOC = {
  id: "doc-1",
  type: DocumentType.Doc,
  title: "Runbook",
  // Carried because the client filter reads it: a row without one makes
  // `matchesFilter` throw, which would take the zero-match branch off the table
  // and quietly make the AC5 case below unreachable.
  slug: "ISS-4001",
  projectId: null,
};

/** A settled, successful read of `rows`. */
function settledRead(rows: unknown[]) {
  return {
    data: rows,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  };
}

/**
 * The endpoint's actual behavior: the unsearched read answers with the
 * population, a searched read answers with the rows that matched. Modelling it
 * this way is what lets a test establish whether the organization HAS documents
 * — clearing the term asks the same surface, and the answer is the corpus.
 *
 * The match is computed, not assumed. A stub that returned nothing for every
 * term would still pass the cases below and would quietly keep passing for a
 * term that ought to have matched.
 */
function givenCorpus(corpus: readonly { title: string; slug: string }[]) {
  mocks.useDocuments.mockImplementation((params: { search?: string }) => {
    if (params.search === undefined) {
      return settledRead([...corpus]);
    }
    const term = params.search.toLowerCase();
    return settledRead(
      corpus.filter(
        (row) =>
          row.title.toLowerCase().includes(term) ||
          row.slug.toLowerCase().includes(term)
      )
    );
  });
}

/** The params `useDocuments` was called with on the last render. */
function lastListParams(): Record<string, unknown> {
  return mocks.useDocuments.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/** The query options `useDocuments` was handed on the last render. */
function lastQueryOptions(): { enabled?: boolean } | undefined {
  return mocks.useDocuments.mock.calls.at(-1)?.[1] as
    | { enabled?: boolean }
    | undefined;
}

/** The `isLoading` the shared table was handed on the last render. */
function tableLoadingProp(): boolean | undefined {
  const props = mocks.documentsViewProps.mock.calls.at(-1)?.[0] as
    | { isLoading?: boolean }
    | undefined;
  return props?.isLoading;
}

/** Whether PostHog has answered for the server-search key yet. */
let serverSearchResolved = true;

/** The server-search gate is independent of the paged read. */
function enableFlags(serverSearch: boolean): void {
  mocks.useFeatureFlagGate.mockImplementation((key: string) => ({
    enabled:
      key === DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY && serverSearch,
    // Only the server-search gate is ever unresolved here; the paged gate
    // (ISS-9157) stays closed and resolved so every case keeps describing the
    // unbounded read it was written for.
    isReady:
      key === DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY
        ? serverSearchResolved
        : true,
  }));
}

/** Whether the flag has resolved; drives the gate's `isReady`. */
function setFlagsResolved(resolved: boolean): void {
  serverSearchResolved = resolved;
  enableFlags(true);
}

/** Persisted search text the container reads on its next render. */
function setFilterText(value: string): void {
  mocks.useViewStatePersistence.mockReturnValue([value, vi.fn(), vi.fn()]);
}

describe("Documents index server-side search (ISS-9724)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    vi.useFakeTimers();
    serverSearchResolved = true;
    enableFlags(true);
    setFilterText("");
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the settled term to the list read", () => {
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("porcupine");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(lastListParams()).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
      search: "porcupine",
    });
  });

  it("trims the term before it reaches the wire", () => {
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("  porcupine  ");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(lastListParams().search).toBe("porcupine");
  });

  it("omits the key entirely for a whitespace-only term", () => {
    // Not `search: ""`. The endpoint answers a blank term with a 400, and an
    // omitted key is also what keeps this query identical to the unsearched one
    // instead of forking the cache on a term that narrows nothing.
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("   ");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(lastListParams()).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
    });
    expect(lastListParams()).not.toHaveProperty("search");
  });

  it("does not issue a read for every keystroke while the term is still changing", () => {
    // The clock MUST advance between keystrokes. Rerendering three times with
    // the timers frozen would pass for any debounce at all — including a 1ms one
    // that in production fires a request per keypress — because a frozen
    // `setTimeout` never fires. Advancing by a realistic inter-keystroke gap that
    // is strictly under the debounce is what makes this fail if the window is
    // ever shortened below typing cadence.
    const { rerender } = render(<DocumentsIndexView />);
    const callsBefore = mocks.useDocuments.mock.calls.length;

    for (const term of ["p", "po", "por"]) {
      setFilterText(term);
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(BETWEEN_KEYSTROKES_MS);
      });
    }

    const paramsSinceTyping = mocks.useDocuments.mock.calls
      .slice(callsBefore)
      .map((call) => call[0]);
    expect(paramsSinceTyping).not.toContainEqual(
      expect.objectContaining({ search: expect.anything() })
    );

    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });
    expect(lastListParams().search).toBe("por");
  });

  it("holds a term the endpoint would reject back rather than blanking the index", () => {
    // A term past the wire bound is a 400, and this surface turns a failed read
    // with no cached rows into the whole-page "Couldn't load documents". Pasting
    // a long string must narrow nothing, not destroy the page.
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1));
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(lastListParams()).not.toHaveProperty("search");
  });

  it("still sends a term of exactly the maximum accepted length", () => {
    // The boundary on the other side, so the guard above cannot quietly widen
    // into "never search anything long".
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH));
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(lastListParams().search).toBe(
      "x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH)
    );
  });

  it("issues no read at all while the flag is unresolved and a term is already in the box", () => {
    // Keying off the bare flag would fire the unsearched read for a reader whose
    // term was restored from a previous visit, then supersede it — and show that
    // reader the full list under their own search term in the meantime.
    setFlagsResolved(false);
    setFilterText("porcupine");

    render(<DocumentsIndexView />);

    expect(lastQueryOptions()?.enabled).toBe(false);
    expect(tableLoadingProp()).toBe(true);
  });

  it("still reads immediately while the flag is unresolved and no term is typed", () => {
    // The converse: with no term the request cannot differ by flag value, so
    // waiting on PostHog would delay every reader's first paint for nothing.
    setFlagsResolved(false);
    setFilterText("");

    render(<DocumentsIndexView />);

    expect(lastQueryOptions()?.enabled).toBe(true);
  });

  it("keeps the term off the wire entirely when the flag is off", () => {
    enableFlags(false);
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("porcupine");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });

    expect(mocks.useFeatureFlagGate).toHaveBeenCalledWith(
      DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY
    );
    expect(lastListParams()).toEqual({
      recencyDays: 30,
      types: [
        DocumentType.Prd,
        DocumentType.ImplementationPlan,
        DocumentType.Doc,
      ],
    });
  });

  it("reads as loading, not as no-results, while the typed term is still settling", () => {
    // AC5. The rows on screen answer the PREVIOUS term, so the client filter
    // narrows them to zero — and a settled "none of your documents match" is a
    // verdict about a read that has not been issued yet. The loaded row is
    // titled "Runbook" and the term is "porcupine", so the zero-match branch is
    // genuinely reachable here; it must lose to loading.
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("porcupine");
    rerender(<DocumentsIndexView />);

    expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(tableLoadingProp()).toBe(true);
  });

  it("lets the settled read reach the no-results verdict once the term lands", () => {
    // The other half of the case above: suppressing the verdict WHILE settling
    // must not suppress it afterwards, or a real empty search result would show
    // a skeleton forever.
    const { rerender } = render(<DocumentsIndexView />);

    setFilterText("porcupine");
    rerender(<DocumentsIndexView />);
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    rerender(<DocumentsIndexView />);

    expect(screen.getByText(NO_RESULTS_HEADING)).toBeInTheDocument();
  });

  /**
   * ISS-9762. The cases above all leave a row in the payload, so none of them
   * ever saw what the endpoint actually answers a no-match term with: nothing.
   * At that point the zero-row read for "hundreds of documents, none matched"
   * and the one for "no documents at all" are the same bytes, and the index
   * told the first organization it had none.
   *
   * Both screens are driven here so neither can be deleted unnoticed, but note
   * what each case can and cannot catch. The no-match case is the one that
   * fails without the fix. The blank-term case cannot fail to an OVER-applied
   * fix — with no term `hasSearch` is false and the widened guard is never
   * reached — so it pins the empty-organization screen's existence, not the
   * boundary. The both-directions pair lives one layer down, on the resolver
   * (`documents-index-state.test.ts`, "splits a zero-row search on whether the
   * rows arrived already searched"), where both sides can carry a term.
   *
   * Routing both populations to one screen is only honest if its SENTENCE is
   * honest for both, which is the second pair below. Both halves assert the
   * same literal — one screen, one string — so a dishonest sentence fails both
   * rather than exactly one. What the pair establishes is the premise that
   * makes the sentence's honesty checkable at all: two genuinely DIFFERENT
   * populations reach this one screen, each proving which it is by clearing the
   * term and reading what the surface says next. Without that, the sentence
   * could be written for whichever population a reader happened to picture.
   */
  describe("a zero-row read the server produced", () => {
    it("names the search, not the organization, when a term was answered with no rows", () => {
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("porcupine");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });
      mocks.useDocuments.mockReturnValue({
        data: NO_MATCHING_ROWS,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
      });
      rerender(<DocumentsIndexView />);

      expect(lastListParams().search).toBe("porcupine");
      expect(screen.getByText(NO_RESULTS_HEADING)).toBeInTheDocument();
      expect(
        screen.queryByText(FIRST_USE_EMPTY_HEADING)
      ).not.toBeInTheDocument();
    });

    it("says the same thing to an organization whose documents did not match", () => {
      // Half one of the pair the copy has to survive. This reader HAS
      // documents — proved on the same surface, by clearing the term and
      // watching the row come back — and the search is what emptied the view.
      givenCorpus([DOC]);
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("porcupine");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });

      expect(screen.getByText(NO_RESULTS_BODY)).toBeInTheDocument();

      setFilterText("");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });
      expect(screen.getByTestId("documents-view")).toBeInTheDocument();
      expect(
        screen.queryByText(FIRST_USE_EMPTY_HEADING)
      ).not.toBeInTheDocument();
    });

    it("says the same thing to an organization that has no documents at all", () => {
      // The other half, and the reason the sentence may not claim a
      // population: this read is byte-identical to the one above — zero rows,
      // a term that reached the server — over an organization that owns
      // nothing, proved by clearing the term and getting the first-use screen.
      // A term persists for 7 days, so this reader arrives here on an ordinary
      // page load rather than by typing into an index they know is empty.
      givenCorpus([]);
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("porcupine");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });

      expect(screen.getByText(NO_RESULTS_BODY)).toBeInTheDocument();

      setFilterText("");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });
      expect(screen.getByText(FIRST_USE_EMPTY_HEADING)).toBeInTheDocument();
      expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    });

    it("names the organization, not the search, when no term was sent at all", () => {
      mocks.useDocuments.mockReturnValue({
        data: NO_MATCHING_ROWS,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
      });

      render(<DocumentsIndexView />);

      expect(lastListParams()).not.toHaveProperty("search");
      expect(screen.getByText(FIRST_USE_EMPTY_HEADING)).toBeInTheDocument();
      expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
    });

    it("is still loading, not either absence, while the term has yet to reach the wire", () => {
      // The widened verdict must not reach back over an unsettled read: between
      // the keystroke and the debounce there is no answer to classify, and the
      // empty payload here would satisfy BOTH zero-row screens if it did.
      mocks.useDocuments.mockReturnValue({
        data: NO_MATCHING_ROWS,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
      });
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("porcupine");
      rerender(<DocumentsIndexView />);

      expect(tableLoadingProp()).toBe(true);
      expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
      expect(
        screen.queryByText(FIRST_USE_EMPTY_HEADING)
      ).not.toBeInTheDocument();
    });

    it("reports a failed search as a failure, not as either kind of absence", () => {
      // A failed read tells us nothing about the population OR the match set,
      // so it must not be reclassified into the states above now that a
      // searched zero can reach one of them.
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("porcupine");
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });
      mocks.useDocuments.mockReturnValue({
        data: NO_MATCHING_ROWS,
        isLoading: false,
        isFetching: false,
        isError: true,
        refetch: vi.fn(),
      });
      rerender(<DocumentsIndexView />);

      expect(screen.getByText(BLOCKING_ERROR_HEADING)).toBeInTheDocument();
      expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
      expect(
        screen.queryByText(FIRST_USE_EMPTY_HEADING)
      ).not.toBeInTheDocument();
    });

    it("reads the rows, not the gate, for a term the container held back", () => {
      // The one shape that tells the two apart. A term past the wire bound
      // never reaches the server, so these zero rows ARE the population and
      // the honest answer is the empty organization — while the gate is open
      // the whole time. A container that reported the FLAG here instead of
      // what it actually asked for would call this org's absence a failed
      // search, which is the substitution its own docstring warns against and
      // which every other case in this file lets pass by co-varying.
      mocks.useDocuments.mockReturnValue({
        data: NO_MATCHING_ROWS,
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
      });
      const { rerender } = render(<DocumentsIndexView />);

      setFilterText("x".repeat(DOCUMENT_LIST_MAX_SEARCH_LENGTH + 1));
      rerender(<DocumentsIndexView />);
      act(() => {
        vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
      });

      expect(lastListParams()).not.toHaveProperty("search");
      expect(screen.getByText(FIRST_USE_EMPTY_HEADING)).toBeInTheDocument();
      expect(screen.queryByText(NO_RESULTS_HEADING)).not.toBeInTheDocument();
    });
  });
});
