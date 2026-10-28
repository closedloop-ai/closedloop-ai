import {
  deriveListEmptyReason,
  ListEmptyReason,
} from "@repo/api/src/list-empty-state";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { filterByCategory } from "@repo/app/documents/lib/table-view-pipeline";

/**
 * The category the Documents index renders under. The index is a single flat
 * list with no category tabs, so this is fixed — and it is a named constant so
 * the match count below and the `DocumentsView` prop are read from one place
 * instead of two literals that could drift into disagreeing about which rows
 * the surface is even describing.
 */
export const DOCUMENTS_INDEX_CATEGORY: FilterCategory = "all";

/**
 * The mutually exclusive things the Documents index can be showing (ISS-8940,
 * PRD-695 §2). Exactly one holds for any read, so the surface can never be
 * describing itself two ways at once.
 *
 * PRD-695 §2 names six. {@link DocumentsIndexState.StaleNoResults} is the
 * seventh, and it exists because the six were not in fact exclusive: a failed
 * refresh whose cached rows all fall outside the active search satisfies BOTH
 * `StaleAfterFailedRefresh` and `NoResults`, and the first draft rendered it as
 * both at once — a "Showing your last loaded documents" banner above a screen
 * showing none of them (whitlockk review, cid 3955716628). The intersection is a
 * state, not a stack of two, so it is named here and gets one screen that says
 * both facts rather than two blocks that contradict each other.
 */
export const DocumentsIndexState = {
  /** The read has not settled and there is nothing cached to show meanwhile. */
  Loading: "loading",
  /** Rows the reader can act on, from a read that succeeded. */
  Populated: "populated",
  /** The read settled and the organization genuinely has no documents. */
  FirstUseEmpty: "first-use-empty",
  /**
   * A search emptied the view. Says nothing about the population: once the
   * term is answered upstream this read cannot know whether any document
   * exists (ISS-9762), so neither may this state or its copy.
   */
  NoResults: "no-results",
  /** The read failed with nothing cached — the whole surface is unusable. */
  BlockingError: "blocking-error",
  /** A refresh failed over rows that are still usable, and says so. */
  StaleAfterFailedRefresh: "stale-after-failed-refresh",
  /**
   * A refresh failed over cached rows AND the active search matches none of
   * them, so there is nothing on screen for a "showing your last loaded
   * documents" banner to be about.
   */
  StaleNoResults: "stale-no-results",
} as const;
export type DocumentsIndexState =
  (typeof DocumentsIndexState)[keyof typeof DocumentsIndexState];

/** Everything the state partition is a function of. */
export type DocumentsIndexReadState = {
  /** No settled read has happened yet for this query. */
  isLoading: boolean;
  /** A request is in flight, first or subsequent. */
  isFetching: boolean;
  /** The most recent request failed. */
  isError: boolean;
  /** Rows currently held, cached rows from an earlier success included. */
  rowCount: number;
  /** Rows surviving the active search. Equals `rowCount` when none is active. */
  matchCount: number;
  /** Whether a non-blank search is narrowing the list. */
  hasSearch: boolean;
  /**
   * The rows were already searched before they arrived — the term went to the
   * server (ISS-9724), so `rowCount` counts MATCHES rather than the population.
   *
   * A fact about the rows, not about which flag produced them: it is false for
   * a blank term and for a term the container held back from the wire, both of
   * which happen with server search switched on.
   */
  searchAppliedUpstream: boolean;
};

/**
 * Collapse a read into exactly one state.
 *
 * The zero-row half of this is NOT re-derived here. `deriveListEmptyReason`
 * (`@repo/api/src/list-empty-state`, FEA-4181) already owns the vocabulary and
 * the precedence for why a list surface shows nothing — unavailable outranks
 * filtered outranks genuinely-empty — and Sessions and Branches both read it.
 * Restating that order in Documents' own words would let a fourth reason added
 * there silently mean something different here. So this function contributes
 * only the two distinctions that classifier has no member for, and delegates
 * the rest:
 *
 * 1. **Loading, decided before any zero verdict.** `deriveListEmptyReason` is
 *    documented as something a host calls "the moment a list resolves to zero
 *    visible rows on the settled page" — an unsettled read has no verdict to
 *    classify at all, so it must never reach a branch that says "no documents".
 *    That is the ISS-7370 defect class, and the reason `isFetching` with no rows
 *    is loading rather than empty (AC2).
 * 2. **Splitting `Unavailable` by whether usable rows survived, and then by
 *    whether the reader can actually see them.** A read failure with nothing
 *    cached makes the surface unusable and blocks; a failure over cached rows
 *    must keep those rows and say so instead of blanking them (AC3) — unless
 *    the active search excludes every one of them, in which case nothing is on
 *    screen to call "your last loaded documents" and the honest answer is the
 *    combined {@link DocumentsIndexState.StaleNoResults}. The shared classifier
 *    has one `Unavailable` because Sessions and Branches never drew either
 *    line — worth hoisting there once a second surface needs them, but this
 *    ticket is the first to answer them.
 *
 * `Filtered` and `Empty` come straight from the classifier — Documents does not
 * restate that half of the precedence, it only supplies honest signals to it.
 */
export function resolveDocumentsIndexState(
  read: DocumentsIndexReadState
): DocumentsIndexState {
  if (read.isLoading || (read.rowCount === 0 && read.isFetching)) {
    return DocumentsIndexState.Loading;
  }
  const reason = deriveListEmptyReason({
    isUnavailable: read.isError,
    // A search is only NARROWING something when there is something to narrow —
    // and `rowCount` can only answer that while it counts the population BEFORE
    // the search, which is what the client filter leaves it as (AC4). Once the
    // server answered the term the count is of matches, so a zero means "none
    // matched", not "none exist", and consulting it would call a populated
    // organization empty (ISS-9762). This surface knows which of the two counts
    // it holds, so it says so instead of reading one as the other.
    hasActiveFilters:
      read.hasSearch && (read.searchAppliedUpstream || read.rowCount > 0),
  });
  if (reason === ListEmptyReason.Unavailable) {
    return resolveUnavailableState(read);
  }
  if (reason === ListEmptyReason.Filtered && read.matchCount === 0) {
    return DocumentsIndexState.NoResults;
  }
  if (read.rowCount === 0) {
    return DocumentsIndexState.FirstUseEmpty;
  }
  return DocumentsIndexState.Populated;
}

/**
 * How many of `documents` survive `searchText`, using the SAME predicate the
 * table itself runs.
 *
 * `filterByCategory` is the pipeline `DocumentsView` applies before it renders
 * (`table-view-pipeline.ts`), so importing it here is what stops the index's
 * no-results verdict and the table's row set from drifting apart — a
 * re-implemented "does this match" would eventually disagree with the rows
 * underneath it, which is the failure the distinction exists to prevent.
 */
export function countMatchingDocuments(
  documents: readonly DocumentRowData[],
  searchText: string
): number {
  return filterByCategory([...documents], DOCUMENTS_INDEX_CATEGORY, searchText)
    .length;
}

/** Whether a search box's contents actually narrow anything. */
export function hasActiveSearch(searchText: string): boolean {
  return searchText.trim() !== "";
}

/**
 * Which of the three failure states a `ListEmptyReason.Unavailable` verdict is.
 *
 * The split is on what the reader can actually SEE, not on what the cache
 * holds: cached rows the active search excludes are not rows on screen, so a
 * banner claiming to be showing them would be false (whitlockk review, cid
 * 3955716628). Kept beside the resolver rather than inlined so the three-way
 * choice is one expression a reader can check for exhaustiveness.
 */
function resolveUnavailableState(
  read: DocumentsIndexReadState
): DocumentsIndexState {
  if (read.rowCount === 0) {
    return DocumentsIndexState.BlockingError;
  }
  if (read.hasSearch && read.matchCount === 0) {
    return DocumentsIndexState.StaleNoResults;
  }
  return DocumentsIndexState.StaleAfterFailedRefresh;
}
