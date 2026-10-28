import type { BranchQueryFilters } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_MAX_OFFSET,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  type BranchListServerPageSize,
  type BranchListSortDirection,
  type BranchListSortKey,
  normalizeBranchListSearch,
  BranchListSortDirection as SortDirection,
  BranchListSortKey as SortKey,
} from "@repo/api/src/types/branch-list-contract";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import { resolveMaxPageIndex } from "@repo/api/src/utils/math";
import { isValidBranchServerPageResponse } from "../data-source/branch-server-page-response";
import { type BranchFilters, selectedPriorityFilterValues } from "./branch-row";

type BranchServerPageQueryInput = {
  filters: BranchFilters;
  page: number;
  pageSize?: BranchListServerPageSize;
  sortKey: BranchListSortKey;
  sortDir: BranchListSortDirection;
  startDate?: string;
  endDate?: string;
};

/** Map visible List controls to the closed server-page query vocabulary. */
export function buildBranchServerPageFilters({
  filters,
  page,
  pageSize = BRANCH_LIST_SERVER_PAGE_SIZE,
  sortKey,
  sortDir,
  startDate,
  endDate,
}: BranchServerPageQueryInput): BranchQueryFilters {
  const maxPage = resolveMaxPageIndex(BRANCH_LIST_MAX_OFFSET, pageSize);
  const normalizedSearch = normalizeBranchListSearch(filters.search);
  return {
    pageMode: BranchListPageMode.Server,
    limit: pageSize,
    offset: Math.min(Math.max(0, Math.floor(page)), maxPage) * pageSize,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...optionalValues("names", filters.names),
    ...optionalValues("owners", filters.owners),
    ...optionalValues("collaborators", filters.collaborators),
    ...optionalValues("statuses", filters.statuses),
    ...optionalValues("pullRequests", filters.pullRequests),
    ...optionalValues("lastActiveRanges", filters.lastActiveRanges),
    ...optionalValues("repositories", filters.repos),
    ...optionalValues("tags", filters.tags),
    ...optionalPriorities(selectedPriorityFilterValues(filters.priorities)),
    ...(filters.locMin === undefined ? {} : { locMin: filters.locMin }),
    ...(filters.locMax === undefined ? {} : { locMax: filters.locMax }),
    ...(normalizedSearch ? { search: normalizedSearch } : {}),
    sortKey: isBranchListSortKey(sortKey) ? sortKey : SortKey.LastActivity,
    sortDir: isBranchListSortDirection(sortDir) ? sortDir : SortDirection.Desc,
  };
}

/** True only for the complete additive v1 envelope, never a partial shape. */
export function isBranchServerPageResponse(response: unknown): boolean {
  return isValidBranchServerPageResponse(response);
}

function optionalValues<Key extends keyof BranchQueryFilters>(
  key: Key,
  values: string[]
): Partial<Pick<BranchQueryFilters, Key>> {
  return values.length > 0
    ? ({ [key]: values } as Partial<Pick<BranchQueryFilters, Key>>)
    : {};
}

/** ISS-10332: the one facet whose values are a closed enum rather than strings. */
function optionalPriorities(
  values: PriorityFilterValue[]
): Pick<BranchQueryFilters, "priorities"> {
  return values.length > 0 ? { priorities: values } : {};
}

function isBranchListSortKey(value: string): value is BranchListSortKey {
  return Object.values(SortKey).includes(value as BranchListSortKey);
}

function isBranchListSortDirection(
  value: string
): value is BranchListSortDirection {
  return Object.values(SortDirection).includes(
    value as BranchListSortDirection
  );
}
