"use client";

import type { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import type {
  ProjectTreeResponse,
  TreeRootSection,
} from "@repo/api/src/types/project-tree";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import { useTableViewOrdering } from "@repo/app/documents/hooks/use-table-view-ordering";
import type { UseTableViewPaginationResult } from "@repo/app/documents/hooks/use-table-view-pagination";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode, groupByMode } from "@repo/app/documents/lib/group-by";
import { useEffect, useMemo, useRef } from "react";

type MyTasksServerPageInput = {
  /** This page's tree, already the server's selection — never sliced again. */
  treeData: ProjectTreeResponse | null;
  /** This page's rows, built from `treeData`. */
  documents: DocumentRowData[];
  sections: TreeRootSection[] | null;
  total: number | null;
  /** Section-paged only. A row-paged read derives it from `total` and `limit`. */
  totalPages: number | null;
  /** Section-paged only. A row-paged read reports `rowOffset` instead. */
  rowsBefore: number | null;
  /** `page.offset` — the ROW offset of a row-paged read's first root. */
  rowOffset: number | null;
  /** `page.limit` — the page size the server actually applied, after clamping. */
  pageSize: number | null;
  /** The ordering the RESPONSE named, or null when it was not section-paged. */
  ordering: ArtifactSectionOrdering | null;
  groupBy: GroupByMode;
  page: number;
  setPage: (page: number) => void;
};

/**
 * ISS-10472 — the My Tasks board bound to a SERVER page.
 *
 * Returns the same shape as `useTableViewPagination` so the board can swap
 * between them without branching on it, but it slices nothing: `treeData` and
 * `documents` already ARE the page. The shared client paginator is deliberately
 * left alone — five-plus surfaces read it (the documents index views,
 * `documents-view`, the project detail page), and reshaping it into a
 * server-page binding would reach every one of them.
 *
 * Every counting field comes off the RESPONSE. On a SECTION-paged read that is
 * literal — pages are variable-height because whole groups stay together, so
 * `page * pageSize` names a window the read never returned, and the server
 * sends `rowsBefore` and `totalPages` for exactly that reason. On a ROW-paged
 * read the server sends `offset`, `limit` and `total` and no page count, so
 * `totalPages` is `ceil(total / limit)` over those — arithmetic on the
 * RESPONSE, still never on the page index.
 */
export function useMyTasksServerPage(
  input: MyTasksServerPageInput
): UseTableViewPaginationResult {
  const { groupBy, page, setPage, sections, treeData } = input;
  // The SERVER's ordering when it named one, so the keys below partition the
  // rows the way the page was packed (ISS-10472).
  const ordering = useTableViewOrdering(input.ordering ?? undefined);

  const knownTotalPages = resolveTotalPages(input);
  const totalPages = Math.max(1, knownTotalPages ?? 1);
  // Clamp at both ends: the corpus can shrink without a filter change (a
  // refetch dropping rows), which would strand the viewer on a page the server
  // no longer has, and a negative page would index before the first.
  //
  // ONLY once this page's own metadata has arrived. An uncached page changes
  // the query key, so the read returns null while it loads and every count is
  // unknown — clamping against that sent the selection straight back to page 0
  // and the viewer could never turn a page (whitlockk, PR #9026). A negative page
  // is still refused, which needs no metadata.
  const clamped =
    knownTotalPages === null
      ? Math.max(0, page)
      : Math.max(0, Math.min(page, totalPages - 1));
  useEffect(() => {
    if (page !== clamped) {
      setPage(clamped);
    }
  }, [page, clamped, setPage]);

  // A grouping change re-seats every section boundary, so the page the viewer is
  // on holds different rows under the same number. Reset rather than strand
  // them.
  //
  // Compared during RENDER against a ref, not in an effect: an effect that
  // calls `setState` on a prop change is the pattern `apps/app/AGENTS.md`
  // rejects, and it would also render one frame of the wrong page first. This
  // is the shape `useTableViewPagination` already uses for its filter reset.
  const previousGroupBy = useRef(groupBy);
  if (previousGroupBy.current !== groupBy) {
    previousGroupBy.current = groupBy;
    if (page !== 0) {
      setPage(0);
    }
  }

  const sectionKeys = useMemo(
    () => resolveSectionKeys(sections, input.documents, groupBy, ordering),
    [sections, input.documents, groupBy, ordering]
  );

  const total = input.total ?? 0;
  const rowsBefore = input.rowsBefore ?? input.rowOffset ?? 0;
  const rootsOnPage = treeData?.nodes.length ?? 0;

  return {
    continuedSectionKeys: sectionKeys?.continued,
    from: total === 0 ? 0 : rowsBefore + 1,
    page: clamped,
    pagedDocuments: input.documents,
    pagedTreeData: treeData,
    sectionTotalsByKey: sectionKeys?.totals,
    setPage,
    to: rowsBefore + rootsOnPage,
    total,
    totalPages,
  };
}

/**
 * Pages the whole set was laid into, or null when this page's metadata has not
 * arrived.
 *
 * Two shapes, because the two reads page different units. A SECTION-paged read
 * sends `totalPages` and nothing else can produce it: pages are
 * variable-height, so whole sections stay together. A ROW-paged read sends
 * `total` and `limit` and no `totalPages`, and reading that as one page is what
 * pinned the ungrouped All tab on page 0 — the clamp above then pulled every
 * later page back (tamsinb, PR #9026).
 */
function resolveTotalPages(input: MyTasksServerPageInput): number | null {
  if (input.totalPages !== null) {
    return input.totalPages;
  }
  if (input.total === null || input.pageSize === null) {
    return null;
  }
  // An empty corpus still has one page, which is the page the viewer is on.
  return Math.max(1, Math.ceil(input.total / input.pageSize));
}

/**
 * The server's sections, keyed the way the RENDERER keys them.
 *
 * The wire carries each section's member root ids, not a key, so that
 * `GroupSectionDescriptor.key` has exactly one spelling — the renderer's. That
 * means the key has to be derived here from a row the section holds, through
 * `groupByMode`, the same function `DocumentsView` groups with. Deriving it any
 * other way would be a second spelling that could drift, and the failure would
 * be silent: a header rendered against a total belonging to a different
 * section.
 *
 * `undefined` when the read was not section-paged, which is the documented way
 * to tell a renderer it holds no section-aware plan and must not print a page's
 * own subset as a section's population.
 */
function resolveSectionKeys(
  sections: TreeRootSection[] | null,
  documents: DocumentRowData[],
  groupBy: GroupByMode,
  ordering: ReturnType<typeof useTableViewOrdering>
): { totals: Map<string, number>; continued: Set<string> } | undefined {
  if (sections === null || groupBy === GroupByMode.None) {
    return undefined;
  }
  const rowsById = new Map(documents.map((row) => [row.id, row]));
  const totals = new Map<string, number>();
  const continued = new Set<string>();
  for (const section of sections) {
    const key = sectionKeyOf(section, rowsById, groupBy, ordering);
    if (key === null) {
      continue;
    }
    totals.set(key, section.total);
    if (section.continued) {
      continued.add(key);
    }
  }
  return { continued, totals };
}

/**
 * One section's key, from the first of its roots the page actually holds.
 *
 * Null when none of them resolved to a row — a section the renderer will not
 * draw either, so attaching a total to it would describe a header that is not
 * there.
 */
function sectionKeyOf(
  section: TreeRootSection,
  rowsById: ReadonlyMap<string, DocumentRowData>,
  groupBy: GroupByMode,
  ordering: ReturnType<typeof useTableViewOrdering>
): string | null {
  for (const rootId of section.rootIds) {
    const row = rowsById.get(rootId);
    if (row === undefined) {
      continue;
    }
    const grouped = groupByMode(
      [row],
      toRowItem,
      // `None` is excluded by the caller, which `groupByMode` requires.
      groupBy as Exclude<GroupByMode, typeof GroupByMode.None>,
      ordering.groupOptions
    );
    return grouped[0]?.descriptor.key ?? null;
  }
  return null;
}
