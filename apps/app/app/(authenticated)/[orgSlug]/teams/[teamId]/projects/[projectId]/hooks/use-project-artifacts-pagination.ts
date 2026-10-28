"use client";

import type {
  ProjectTreeDetailsResponse,
  ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { isProjectTreeTruncated } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { useTableViewPagination } from "@repo/app/documents/hooks/use-table-view-pagination";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import type { GroupByMode } from "@repo/app/documents/lib/group-by";
import { useTablePageSizeOptions } from "@repo/app/shared/hooks/use-table-page-size-options";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import {
  buildTableRangeReadout,
  DEFAULT_TABLE_PAGE_SIZE,
} from "@repo/design-system/components/ui/table-page-size-select";
import { useCallback, useState } from "react";
import {
  resolveProjectArtifactsEmptyTruncationNote,
  resolveProjectArtifactsPageNoun,
  resolveProjectArtifactsTruncationNote,
} from "../lib/project-artifacts-pagination";

type UseProjectArtifactsPaginationInput = {
  /** Whether the ISS-5307 pagination flag is on for this viewer. */
  isEnabled: boolean;
  /**
   * ISS-9726: the identity-namespaced page-size and sort keys, resolved ONCE by
   * the page (`useProjectArtifactsViewStateKeys`) and threaded in rather than
   * rebuilt here. The sort key in particular is also read by `DocumentsView`, so
   * a second construction site is how one reader's sort splits across two
   * stored values. `null` means "hold it in memory" — the identity or the flag
   * has not resolved, so there is no key it can honestly be written under.
   */
  pageSizeStorageKey: string | null;
  sortPersistenceKey: string | null;
  filterCategory: FilterCategory;
  filterText: string;
  groupBy: GroupByMode;
  documents: DocumentRowData[];
  treeData: ProjectTreeDetailsResponse | undefined;
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  isFilterActive: boolean;
  /** True on the Overview tab, which renders no table and so no footer. */
  isOverview: boolean;
  /** The unpaged "this project has artifacts at all" signal. */
  hasArtifactItems: boolean;
  /**
   * The tab's scroll container, so turning a page returns to the top of the
   * new page. Without it the container's persisted offset survives the page
   * change and Next, clicked from the bottom of page 1, lands the viewer at
   * the bottom of page 2. My Tasks does the same, for the same reason.
   */
  scrollContainer: HTMLElement | null;
};

type UseProjectArtifactsPaginationResult = {
  /** The `documents` subset to hand `DocumentsView` for the current page. */
  pagedDocuments: DocumentRowData[];
  /**
   * The `treeData` subset for the current page, in the base tree shape
   * `DocumentsView` accepts. The detail enrichment rides along on the nodes;
   * the slice neither reads nor drops it.
   */
  pagedTreeData: ProjectTreeResponse | null;
  /**
   * The unpaged signal for `DocumentsView`, or `undefined` when paging is off
   * so the view falls back to reading its own (then-complete) sources exactly
   * as it did before ISS-5307.
   */
  hasUnpagedItems: boolean | undefined;
  /** Whether to render the pagination footer at all. */
  showFooter: boolean;
  page: number;
  /**
   * Turn to a page. Prefer this over `setPage` from a footer control: it also
   * returns the scroll container to the top of the new page.
   */
  onPageChange: (page: number) => void;
  setPage: (page: number) => void;
  /**
   * The TRUE number of rows the active tab would render unpaged — never the
   * number currently on screen. Exposed (not just folded into `readout`) so the
   * distinction is assertable, because "N loaded so far" masquerading as a
   * total is the defect this surface is most likely to regress into.
   */
  total: number;
  totalPages: number;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  /** ISS-9692: the rungs this viewer is offered, for the footer's select. */
  pageSizeOptions: readonly number[];
  /** "1–25 of 240 issues", built from the tab's TRUE total. */
  readout: string | null;
  /** Present only when the server bounded the read. */
  truncationNote: string | null;
  /**
   * The bounded-read caveat for a tab with NO rows, which therefore renders no
   * footer to carry {@link truncationNote}. Mutually exclusive with it: exactly
   * one of the two is non-null at a time, so the caveat survives the zero-result
   * case instead of disappearing at the moment it explains the screen.
   */
  emptyStateTruncationNote: string | null;
  /**
   * ISS-4704: each group section's true size, and the sections continuing from
   * an earlier page, for `DocumentsView`'s headers. Both `undefined` unless a
   * section-aware page plan is in force — this surface pages by whole sections
   * under the same gate My Tasks does, so it needs the same two.
   */
  sectionTotalsByKey: ReadonlyMap<string, number> | undefined;
  continuedSectionKeys: ReadonlySet<string> | undefined;
};

/**
 * ISS-5307 — everything the project detail page needs to render one bounded
 * page of an artifact tab, extracted from `page.tsx` so that component stays
 * under the cognitive-complexity ceiling and the paging rules can be tested
 * without mounting the whole page.
 *
 * The counting and slicing themselves are NOT reimplemented here: they are the
 * shared `useTableViewPagination` (ISS-4466), which counts through the exact
 * pipeline `DocumentsView` renders with. This hook only supplies the project
 * page's bindings — page-size state, the tab's noun, the footer's visibility,
 * and the server-truncation caveat.
 */
export function useProjectArtifactsPagination(
  input: UseProjectArtifactsPaginationInput
): UseProjectArtifactsPaginationResult {
  // ISS-9692: the rows-per-page persists through the SAME per-surface store this
  // tab's sort already uses (`table:sort:project-artifacts:<id>` beside it), so
  // the choice survives a reload and a navigate-away-and-back. Keyed by project
  // so one project's page size cannot leak onto another's.
  //
  // ISS-9692 (davetho review): the store is READ whatever the gate says. It
  // used to be built on a `null` key while the flag was off — that hook's
  // memory-only mode — which did not merely withhold the two large rungs, it
  // hid the stored value entirely and handed back 25. A reader who had chosen
  // 500 came back to the smallest page on the ladder and, on their next choice,
  // overwrote what was on disk. Reading it always and resolving it against the
  // ladder in force is the documented stale-value contract: a stored 500 becomes
  // 100, the largest rung still offered, not the default.
  const [persistedPageSize, setPersistedPageSize] =
    useViewStatePersistence<number>(
      input.pageSizeStorageKey,
      DEFAULT_TABLE_PAGE_SIZE
    );
  // What the reader has chosen during THIS visit, which is the only thing a
  // gated-off session may change: the control still moves, and nothing is
  // written, so a reader without the flag gets the tab exactly as it shipped.
  const [visitPageSize, setVisitPageSize] = useState<number | null>(null);
  const {
    isExtendedLadderEnabled,
    options: pageSizeOptions,
    pageSize,
  } = useTablePageSizeOptions(visitPageSize ?? persistedPageSize);

  const artifactPage = useTableViewPagination({
    applyProjectFilters: input.applyProjectFilters,
    documents: input.documents,
    enabled: input.isEnabled,
    filterCategory: input.filterCategory,
    filterText: input.filterText,
    groupBy: input.groupBy,
    isFilterActive: input.isFilterActive,
    pageSize,
    sortPersistenceKey: input.sortPersistenceKey,
    treeData: input.treeData ?? null,
  });

  const { setPage } = artifactPage;
  const { scrollContainer } = input;
  const onPageChange = useCallback(
    (nextPage: number) => {
      setPage(nextPage);
      if (scrollContainer) {
        scrollContainer.scrollTop = 0;
      }
    },
    [setPage, scrollContainer]
  );
  const onPageSizeChange = useCallback(
    (next: number) => {
      setVisitPageSize(next);
      // ISS-9692 (davetho review): only a gated-ON choice is DURABLE. The
      // control moves either way — the line above — but a gated-off session
      // must not write, or persistence would be perceivably on for a reader
      // whose flag is off, and their write would destroy the value the flag
      // exists to restore.
      if (isExtendedLadderEnabled) {
        setPersistedPageSize(next);
      }
      // The shared footer deliberately does not reset the page on a size
      // change, and the paginator only resets on a FILTER change. Without this
      // a viewer on page 4 of 25-row pages lands on page 4 of 100-row pages —
      // three pages past the rows they were reading.
      setPage(0);
      if (scrollContainer) {
        scrollContainer.scrollTop = 0;
      }
    },
    [setPage, scrollContainer, setPersistedPageSize, isExtendedLadderEnabled]
  );

  // The footer is a claim about a paginated table, so it renders only where one
  // exists: paging on, a table on screen (never Overview), and rows on THIS
  // tab to page.
  //
  // Gating on the tab's own total, not the project-wide `hasArtifactItems`:
  // most projects have no branches, and several have no plans, so the broader
  // signal rendered a bordered strip holding nothing but a "25 / page" select —
  // a rows-per-page control offering to page zero rows. The zero-match-filter
  // case that gate was protecting is already held by `hasUnpagedItems`, which
  // keeps "Clear filters" alive in the table body.
  const showsTable = input.isEnabled && !input.isOverview;
  const showFooter = showsTable && artifactPage.total > 0;

  // The caveat names what the bounded read counted, so it speaks in the active
  // tab's own unit: a category-scoped read (ISS: filter-after-paginate) bounds
  // PRDs/issues/plans/branches, not mixed top-level artifacts, and describing
  // its floor as "top-level artifacts" would misstate the population.
  const noun = resolveProjectArtifactsPageNoun(input.filterCategory);
  const isTruncated = isProjectTreeTruncated(input.treeData);
  const truncationNote = isTruncated
    ? resolveProjectArtifactsTruncationNote(input.treeData, noun)
    : null;
  // With no rows there is no footer, and the caveat would vanish exactly where
  // it decides what an empty tab MEANS: "nothing matches" versus "nothing
  // matches in the prefix we loaded". Hand it back separately so the page can
  // render it beside the empty state instead.
  const emptyStateTruncationNote =
    isTruncated && showsTable && artifactPage.total === 0
      ? resolveProjectArtifactsEmptyTruncationNote(input.treeData, noun)
      : null;

  return {
    emptyStateTruncationNote,
    hasUnpagedItems: input.isEnabled ? input.hasArtifactItems : undefined,
    onPageChange,
    onPageSizeChange,
    page: artifactPage.page,
    pagedDocuments: artifactPage.pagedDocuments,
    // `useTableViewPagination` preserves a `null`/`undefined` tree so the
    // view's own loading gate is unchanged; the page renders `null` for both.
    pagedTreeData: artifactPage.pagedTreeData ?? null,
    pageSize,
    pageSizeOptions,
    readout: buildTableRangeReadout({
      noun,
      page: artifactPage.page,
      pageSize,
      // A bounded server read makes this a count of the prefix the client
      // holds, not of the project — so it renders as a floor ("500+") beside
      // the note that says what it was counted from. Marker and note ship
      // together; either alone misleads.
      isTotalPartial: truncationNote !== null,
      // The tab's TRUE total, from the same pipeline that renders the rows —
      // never `pagedDocuments.length`, which is the size of the page already
      // on screen.
      total: artifactPage.total,
      // ISS-4704: section-aware paging makes pages variable-height, so the
      // range comes from the plan the rows were drawn from rather than from
      // `page * pageSize`, which would name rows this page does not hold.
      range: { from: artifactPage.from, to: artifactPage.to },
    }),
    setPage,
    showFooter,
    total: artifactPage.total,
    totalPages: artifactPage.totalPages,
    truncationNote,
    sectionTotalsByKey: artifactPage.sectionTotalsByKey,
    continuedSectionKeys: artifactPage.continuedSectionKeys,
  };
}
