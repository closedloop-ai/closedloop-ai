"use client";

import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import {
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import type { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  countTableViewRows,
  pageTableView,
  type TableViewPage,
} from "@repo/app/documents/lib/table-view-pagination";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { useEffect, useMemo, useRef, useState } from "react";

export type UseTableViewPaginationInput = {
  documents: DocumentRowData[];
  treeData: ProjectTreeResponse | null | undefined;
  filterCategory: FilterCategory;
  filterText: string;
  applyProjectFilters?: (items: DocumentRowItem[]) => DocumentRowItem[];
  /** Whether any project facet filter is active (feeds the same predicate). */
  isFilterActive: boolean;
  /**
   * Active grouping mode. `DocumentsView` re-groups the paged subset by section,
   * so the paginator must slice membership in that same grouped order or a
   * section repeats across pages (ISS-4466). A group change also resets to
   * page 0 so the viewer is never stranded on a now-reordered later page.
   */
  groupBy: GroupByMode;
  /** Sort persistence key `DocumentsView` reads, so paging order matches. */
  sortPersistenceKey: string;
  pageSize?: number;
  /**
   * ISS-5307: when `false`, the surface is not paged and this hook does no
   * work — it hands the inputs straight back and reports one page holding
   * everything. Defaults to `true` so the My Tasks binding is unaffected.
   *
   * This exists because the project detail page's pagination ships behind a
   * default-off flag, and the paging pipeline is not free: it re-runs the same
   * `buildSortedGroups` pass `DocumentsView` runs. Computing a slice nobody
   * renders would make the flag-OFF path slower than it was before this ticket
   * touched it — a regression paid by everyone, to serve a feature nobody has
   * turned on yet.
   */
  enabled?: boolean;
};

/**
 * When `enabled` is `false` the counting fields (`total`, `totalPages`, `from`,
 * `to`) describe nothing — the count was deliberately not computed — while
 * `pagedDocuments`/`pagedTreeData` are the caller's own unsliced inputs. A
 * disabled caller must therefore render the rows and NOT a range readout: a
 * footer reading "0 items" above a full table is precisely the class of lie the
 * repo bans. The project page enforces this by rendering its footer only inside
 * the same flag branch that enables the hook, and its test asserts the flag-off
 * page shows no readout.
 */
export type UseTableViewPaginationResult = {
  /** Zero-based current page, already clamped to the available range. */
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
  /** One honest total across all three streams for the active tab + filters. */
  total: number;
  /** 1-based index of the first visible row (0 when empty). */
  from: number;
  /** 1-based index of the last visible row. */
  to: number;
  /** The `documents` + `treeData` subset to feed `DocumentsView` for this page. */
  pagedDocuments: DocumentRowData[];
  pagedTreeData: ProjectTreeResponse | null | undefined;
};

/**
 * ISS-4466 — real pagination for a `DocumentsView` surface, over every stream
 * that view renders.
 *
 * ISS-5307: extracted from the My Tasks board to `@repo/app/documents` verbatim
 * (no behavior change) so the project detail page pages by the SAME rules. The
 * clamp, the page-0 reset, the grouped-order slice, and the sort resolution are
 * all things two surfaces would otherwise have re-derived slightly differently;
 * a paginator that disagrees with the renderer about order is exactly how a row
 * gets skipped or shown twice.
 *
 * Mirrors `usePaginatedFilterState` (page-0 reset on a filter/group change, clamp
 * + persist when the corpus shrinks) but pages at the DATA layer over the
 * unified, deduped root-group list `pageTableView` builds — in the SAME grouped
 * order `DocumentsView` renders when a grouping mode is active — then hands
 * `DocumentsView` an already-paged `documents` + `treeData` subset so its render
 * assembly stays untouched. `total` is the one honest count for the active tab +
 * filters, and it matches every visible root row because the same pipeline that
 * renders is the one that counts.
 */
export function useTableViewPagination(
  input: UseTableViewPaginationInput
): UseTableViewPaginationResult {
  // Clamp the page size to a valid floor of 1: a 0 makes `totalPages` infinite
  // for non-empty data and a negative value reports a total while slicing the
  // wrong window (repo numeric-input guardrail).
  const pageSize = Math.max(1, input.pageSize ?? DEFAULT_TABLE_PAGE_SIZE);
  const [pageInput, setPage] = useState(0);

  // Read the same sort state `DocumentsView` renders with (URL + persistence),
  // so the paged slice is ordered identically to the rendered rows. The default
  // column MUST match DocumentsView: with `stack-rank-project-page` on it
  // defaults to StackRank, so resolving `null` here would slice page membership
  // in input order and then let each page re-sort independently — a divergence.
  const isStackRankEnabled = useFeatureFlagEnabled(
    STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY
  );
  const { sortBy, sortDir } = useSortParams<SortKey>({
    validColumns: SORT_KEYS,
    defaultColumn: isStackRankEnabled ? SortKey.StackRank : null,
    defaultDirection: "asc",
    persistenceKey: input.sortPersistenceKey,
  });

  const applyProjectFilters = input.isFilterActive
    ? input.applyProjectFilters
    : undefined;

  const countInput = useMemo(
    () => ({
      documents: input.documents,
      treeData: input.treeData,
      filterCategory: input.filterCategory,
      filterText: input.filterText,
      applyProjectFilters,
      sortBy,
      sortDir,
      groupBy: input.groupBy,
    }),
    [
      input.documents,
      input.treeData,
      input.filterCategory,
      input.filterText,
      applyProjectFilters,
      sortBy,
      sortDir,
      input.groupBy,
    ]
  );

  const isEnabled = input.enabled ?? true;
  const total = useMemo(
    () => (isEnabled ? countTableViewRows(countInput) : 0),
    [countInput, isEnabled]
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Reset to page 0 whenever the filter inputs change so a narrowing never
  // strands the viewer on a now-out-of-range page (mirrors the intrinsic reset
  // in `usePaginatedFilterState`). Keyed on the filter identity, not a setter,
  // so any path that changes the filters resets the page.
  const filterIdentity = useMemo(
    () => ({
      filterCategory: input.filterCategory,
      filterText: input.filterText,
      applyProjectFilters,
      sortBy,
      sortDir,
      groupBy: input.groupBy,
    }),
    [
      input.filterCategory,
      input.filterText,
      applyProjectFilters,
      sortBy,
      sortDir,
      input.groupBy,
    ]
  );
  const prevFilterIdentity = useRef(filterIdentity);
  if (prevFilterIdentity.current !== filterIdentity) {
    prevFilterIdentity.current = filterIdentity;
    if (pageInput !== 0) {
      setPage(0);
    }
  }

  // Clamp the requested page to the available range: the corpus can shrink
  // WITHOUT a filter change (a list refetch dropping rows), which would strand
  // the viewer on a now-empty later page.
  const page = Math.min(pageInput, totalPages - 1);
  useEffect(() => {
    if (pageInput > page) {
      setPage(page);
    }
  }, [pageInput, page]);

  const { pagedDocuments, pagedTreeData }: TableViewPage = useMemo(
    () =>
      isEnabled
        ? pageTableView({ ...countInput, page, pageSize })
        : // Disabled: hand the inputs straight back, unsliced. Skipping
          // `pageTableView` is the point — see `enabled` above.
          {
            pagedDocuments: countInput.documents,
            pagedTreeData: countInput.treeData,
            total: 0,
          },
    [countInput, page, pageSize, isEnabled]
  );

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  return {
    page,
    setPage,
    totalPages,
    total,
    from,
    to,
    pagedDocuments,
    pagedTreeData,
  };
}
