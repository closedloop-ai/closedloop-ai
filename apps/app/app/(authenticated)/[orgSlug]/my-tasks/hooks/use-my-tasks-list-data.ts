"use client";

import type { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { TableFilters } from "@repo/app/documents/hooks/use-table-filters";
import type { UseTableViewPaginationResult } from "@repo/app/documents/hooks/use-table-view-pagination";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS } from "@repo/app/documents/lib/documents-index-paged-read";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { withPriorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import {
  type MyTasksTruncation,
  mergeMyTasksTruncations,
  resolveMyTasksTreeTruncation,
  resolveMyTasksTruncation,
} from "@repo/app/my-tasks/lib/my-tasks-range-readout";
import type { AssignedTreeFacets } from "@repo/app/projects/hooks/use-assigned-artifact-tree";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDebouncedValue } from "@repo/app/shared/hooks/use-debounced-value";
import { useMemo, useRef, useState } from "react";
import {
  assignedTreeFacetParams,
  withUnsetPriorityDisplayFallback,
} from "../lib/assigned-tree-facet-params";
import { treeDocumentRows } from "../lib/tree-document-rows";
import {
  MY_TASKS_PAGE_SIZE,
  useMyTasksPagination,
} from "./use-my-tasks-pagination";
import { useMyTasksServerPage } from "./use-my-tasks-server-page";
import { useMyTasksTreeSource } from "./use-my-tasks-tree-source";

/** Nothing was left out of the fetched window — no floor marker, no note. */
const NO_TRUNCATION: MyTasksTruncation = {
  isTotalPartial: false,
  note: null,
};

type MyTasksListDataInput = {
  assigneeId: string | null;
  isListView: boolean;
  filterCategory: FilterCategory;
  filterText: string;
  groupBy: GroupByMode;
  /** For resolving each tree row's project; the board renders a Project column. */
  projects: readonly DocumentRowData["project"][];
  /** The `GET /documents` stream, which only the unpaged states still read. */
  rawArtifacts: DocumentRowData[];
  documentsHasMore: boolean;
  assignedTotal: number;
  applyProjectFilters: (items: DocumentRowItem[]) => DocumentRowItem[];
  isFilterActive: boolean;
  sortPersistenceKey: string | null;
  /**
   * The facet selection. Applied by the SERVER when this read is paged there,
   * because a browser predicate over one page narrows the rows on screen while
   * the footer goes on counting the whole set.
   */
  filters: TableFilters;
  /** Whether the FEA-1626 recency window is in force. */
  isRecencyWindowActive: boolean;
  /** Whether the flag that decides the window has resolved (FEA-1626). */
  isRecencyWindowFlagReady: boolean;
};

export type MyTasksListData = {
  /** Rows for the active state: the tree's when server-paged, else the stream's. */
  documents: DocumentRowData[];
  treeData: ProjectTreeResponse | null;
  isTreeLoading: boolean;
  isTreeError: boolean;
  refetchTree: () => void;
  pagination: UseTableViewPaginationResult;
  /** The footer's floor marker, or none when the total is exact. */
  truncation: MyTasksTruncation;
  /**
   * Whether the server drew this page. The caller needs it because the states
   * differ in what they may CLAIM: only a server-paged read has an exact total.
   */
  isServerPaged: boolean;
  /**
   * The section ordering the server NAMED for this page, or null when it named
   * none and the browser may resolve its own.
   *
   * Handed to the renderer so the bands it draws are keyed the way the page was
   * packed. The server resolves three orderings from its own PostHog read and
   * two of them key a status band on the RAW status while the third coerces it,
   * so a renderer re-deciding from its own gates can land a row in a band the
   * paginator counted under a different key — a header stating a total over the
   * wrong rows (whitlockk, PR #9091).
   */
  sectionOrdering: ArtifactSectionOrdering | null;
};

/**
 * ISS-10472 — where the My Tasks list view gets its rows, and who paged them.
 *
 * Extracted from `page.tsx` rather than added to it: that file was already at
 * the size where the repo asks for a factoring instead of another branch, and
 * this is one cohesive decision — which read is live, which paginator owns it,
 * and what the footer may therefore state.
 *
 * TWO STATES, and the split is the endpoint's, not a preference:
 *
 * - The **All tab** pages ROOT GROUPS server-side, with an exact total. Its
 *   rows come from the TREE, because `/documents` returns its own
 *   created_at-ordered window and a root on a later page need not be in it —
 *   `treeEntityToRowItem` would then yield null and the row would silently
 *   vanish (see `treeDocumentRows`).
 * - The **flat tabs** page individual rows, and the endpoint has no type facet,
 *   so they keep today's read: `/documents` merged with an unpaged tree, paged
 *   in the browser, and the floor marker that says the total is a bound. They
 *   therefore still cannot reach a row past `MAX_TREE_ANCHORS` — tracked as
 *   ISS-12756, and disclosed by that marker rather than hidden.
 */
export function useMyTasksListData(
  input: MyTasksListDataInput
): MyTasksListData {
  const { filterCategory, filterText, groupBy, isListView } = input;
  const isServerPaged = isListView && filterCategory === "all";
  const [serverPage, setServerPage] = useState(0);

  // The term settles before it becomes a tree query key, so a typed word is one
  // request rather than one per keystroke — and this read is the anchor climb
  // plus the `count(*)` beside it (tamsinb, PR #9091). Reuses the Documents
  // index's own delay rather than naming a second one.
  //
  // Only the SERVER read waits. The browser-paged tabs filter locally, so a
  // delay there would buy nothing and make the box feel slow, and the toolbar
  // input keeps the live value in every state.
  const debouncedFilterText = useDebouncedValue(
    filterText,
    DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS
  );
  const serverSearch = isServerPaged ? debouncedFilterText : filterText;

  // Keyed on the selection's CONTENT, because `filters` is a fresh object on
  // every render (ISS-12882) — an identity-keyed memo re-read the clock with it,
  // and a moving `dateFrom` is inside the query key.
  //
  // The clock is read once per selection change, which is the property the
  // window needs: one that moved between page requests would draw page 2 from a
  // different population than page 1.
  const facetSelectionKey = JSON.stringify({
    date: input.filters.date,
    favoritesOnly: input.filters.favoritesOnly,
    hideCompletedItems: input.filters.hideCompletedItems,
    priorities: input.filters.priorities,
    recencyWindow: input.isRecencyWindowActive,
    statuses: input.filters.statuses,
    tagIds: input.filters.tagIds,
  });
  // ISS-9665: flag OFF, an artifact holding no priority RENDERS as `Medium`, so
  // a `Medium` selection has always returned it. Read here and branched here —
  // the boolean is never handed to the resolver, which is what
  // `no-threaded-feature-flag` asks of a second consumer.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const resolvedFacets = useRef<{
    key: string;
    facets: AssignedTreeFacets;
    unsetPriorityEnabled: boolean;
  } | null>(null);
  if (
    resolvedFacets.current?.key !== facetSelectionKey ||
    resolvedFacets.current.unsetPriorityEnabled !== unsetPriorityEnabled
  ) {
    const resolved = assignedTreeFacetParams(
      input.filters,
      input.isRecencyWindowActive,
      new Date()
    );
    resolvedFacets.current = {
      facets: unsetPriorityEnabled
        ? resolved
        : withUnsetPriorityDisplayFallback(resolved),
      key: facetSelectionKey,
      unsetPriorityEnabled,
    };
  }
  const facets = resolvedFacets.current.facets;

  // A narrowing re-seats every page boundary, so the page the viewer is on
  // holds different rows under the same number. Compared during render against
  // a ref rather than in an effect, which would render one frame of the wrong
  // page first (`apps/app/AGENTS.md`). The grouping's own reset lives in
  // `useMyTasksServerPage`, which is the only thing that knows the plan.
  //
  // The FACETS are part of the comparison, not just the tab and the term: a
  // status or date selection narrows the anchor set, so it moves every boundary
  // exactly as a new search term does. Compared through the resolved facets'
  // serialization rather than their identity, so a re-resolution that produced
  // an equal selection cannot read as a change and send the viewer to page 0
  // mid-read.
  const narrowing = `${filterCategory}\u0000${serverSearch}\u0000${JSON.stringify(facets)}`;
  const previousNarrowing = useRef(narrowing);
  if (previousNarrowing.current !== narrowing) {
    previousNarrowing.current = narrowing;
    if (serverPage !== 0) {
      setServerPage(0);
    }
  }

  const isGrouped = groupBy !== GroupByMode.None;
  const tree = useMyTasksTreeSource({
    assigneeId: input.assigneeId,
    ...(isServerPaged && isGrouped
      ? { grouping: { groupBy, pageIndex: serverPage } }
      : {}),
    isFacetFlagReady: input.isRecencyWindowFlagReady,
    isListView,
    ...(isServerPaged
      ? {
          facets,
          paging: {
            limit: MY_TASKS_PAGE_SIZE,
            offset: serverPage * MY_TASKS_PAGE_SIZE,
          },
          // Server-side because the board pages server-side: a browser filter
          // over one page would search the rows on screen rather than the
          // assignee's work.
          search: serverSearch,
        }
      : {}),
  });

  const projectsById = useMemo(
    () =>
      new Map(
        input.projects.flatMap((project) =>
          project ? [[project.id, project] as const] : []
        )
      ),
    [input.projects]
  );
  // The same ISS-9665 substitution `page.tsx` applies to the `/documents` rows.
  // Without it the All tab's rows come from a stream that reports `null`
  // honestly while the flat tabs' are folded to `Medium`, so one artifact reads
  // two ways on two tabs of one board — and the group header, the sort, and the
  // cell all read `row.priority`, so it belongs on the ROW MODEL (whitlockk).
  const treeRows = useMemo(() => {
    const rows = treeDocumentRows(tree.treeData, projectsById);
    return unsetPriorityEnabled ? rows : withPriorityDisplayFallback(rows);
  }, [tree.treeData, projectsById, unsetPriorityEnabled]);
  const documents = isServerPaged ? treeRows : input.rawArtifacts;

  // Both paginators are called unconditionally — hooks must be — and the client
  // one is told to do no work when it is not the live path, which is exactly
  // what its `enabled` flag exists for (ISS-5307).
  const clientPagination = useMyTasksPagination({
    applyProjectFilters: input.applyProjectFilters,
    documents: input.rawArtifacts,
    enabled: !isServerPaged,
    filterCategory,
    filterText,
    groupBy,
    isFilterActive: input.isFilterActive,
    sortPersistenceKey: input.sortPersistenceKey,
    treeData: tree.treeData,
  });
  const serverPagination = useMyTasksServerPage({
    documents: treeRows,
    groupBy,
    ordering: tree.treeSectionOrdering,
    page: serverPage,
    pageSize: tree.treePageSize,
    rowOffset: tree.treeRowOffset,
    rowsBefore: tree.treeRowsBefore,
    sections: tree.treeSections,
    setPage: setServerPage,
    total: tree.treeTotal,
    totalPages: tree.treeTotalPages,
    treeData: tree.treeData,
  });

  return {
    documents,
    isServerPaged,
    isTreeError: tree.isTreeError,
    isTreeLoading: tree.isTreeLoading,
    pagination: isServerPaged ? serverPagination : clientPagination,
    refetchTree: tree.refetchTree,
    // Only on the server-paged state: the browser-paged tabs never asked the
    // server to section anything, so naming an ordering for them would pin the
    // renderer to a plan no response carried.
    sectionOrdering: isServerPaged ? tree.treeSectionOrdering : null,
    treeData: tree.treeData,
    truncation: isServerPaged
      ? // The total is the server's exact count over the same predicate the
        // page was drawn from, so there is no floor to mark. The node budget
        // can still bind per page and the server reports it, but the board
        // renders nothing for that (operator ruling 2026-10-20).
        NO_TRUNCATION
      : resolveUnpagedTruncation(input, tree.treeData),
  };
}

/**
 * The floor marker for the states that still read a BOUNDED window.
 *
 * Both reasons are named, because the footer states ONE total and a `+` on it
 * means "at least one stream was bounded" — dropping either would leave a
 * marker whose explanation is incomplete.
 */
function resolveUnpagedTruncation(
  input: MyTasksListDataInput,
  treeData: ProjectTreeResponse | null
): MyTasksTruncation {
  if (!input.isListView) {
    return NO_TRUNCATION;
  }
  const documentsTruncation = input.documentsHasMore
    ? resolveMyTasksTruncation(input.rawArtifacts.length, input.assignedTotal)
    : NO_TRUNCATION;
  return mergeMyTasksTruncations([
    documentsTruncation,
    resolveMyTasksTreeTruncation(treeData?.truncation),
  ]);
}
