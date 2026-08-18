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
  projectId: string;
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
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TABLE_PAGE_SIZE);

  const artifactPage = useTableViewPagination({
    applyProjectFilters: input.applyProjectFilters,
    documents: input.documents,
    enabled: input.isEnabled,
    filterCategory: input.filterCategory,
    filterText: input.filterText,
    groupBy: input.groupBy,
    isFilterActive: input.isFilterActive,
    pageSize,
    sortPersistenceKey: `table:sort:project-artifacts:${input.projectId}`,
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
      setPageSize(next);
      // The shared footer deliberately does not reset the page on a size
      // change, and the paginator only resets on a FILTER change. Without this
      // a viewer on page 4 of 25-row pages lands on page 4 of 100-row pages —
      // three pages past the rows they were reading.
      setPage(0);
      if (scrollContainer) {
        scrollContainer.scrollTop = 0;
      }
    },
    [setPage, scrollContainer]
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

  const isTruncated = isProjectTreeTruncated(input.treeData);
  const truncationNote = isTruncated
    ? resolveProjectArtifactsTruncationNote(input.treeData)
    : null;
  // With no rows there is no footer, and the caveat would vanish exactly where
  // it decides what an empty tab MEANS: "nothing matches" versus "nothing
  // matches in the prefix we loaded". Hand it back separately so the page can
  // render it beside the empty state instead.
  const emptyStateTruncationNote =
    isTruncated && showsTable && artifactPage.total === 0
      ? resolveProjectArtifactsEmptyTruncationNote(input.treeData)
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
    readout: buildTableRangeReadout({
      noun: resolveProjectArtifactsPageNoun(input.filterCategory),
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
    }),
    setPage,
    showFooter,
    total: artifactPage.total,
    totalPages: artifactPage.totalPages,
    truncationNote,
  };
}
