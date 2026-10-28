import {
  BranchListFilterFacet,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import {
  BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS,
  BRANCH_LIST_FILTER_VALUE_SEMANTICS,
  BRANCH_LIST_SORT_VALUE_SEMANTICS,
} from "@repo/api/src/types/branch-list-value-semantics";
import type { BranchStatusOrdering } from "@repo/api/src/types/branch-status-order";
import {
  LIST_QUERY_TEXT_COLLATION,
  ListQueryTextOrdering,
  listQueryWindowBoundMs,
} from "@repo/api/src/types/list-query-ordering-semantics";
import {
  listQueryFoldedRowDisposition,
  listQueryOrdersUnrankedRowFirst,
  listQueryRetainsUnjudgeableRow,
} from "@repo/api/src/types/list-query-value-semantics";
import {
  type PriorityFilterValue,
  splitPriorityFilter,
} from "@repo/api/src/types/priority-filter";
import { PRIORITY_VALUES } from "@repo/api/src/types/search-query";
import { Prisma } from "@repo/database";
import { toSqlContainsPattern } from "@/lib/sql-like";

/**
 * The ICU root collation, which orders byte-identically to the kernel's
 * `compareListQueryText(…, Collated)` — measured against an adversarial set
 * covering case, accents, `-`/`_`/`/` and digit runs. The database's libc
 * default and `C` both order differently, so every string comparison the Branch
 * list kernel collates names this explicitly.
 *
 * ISS-9585 took the literal out: `LIST_QUERY_TEXT_COLLATION` is where the two
 * mirrors agree on the name, so this one cannot be retuned without the
 * comparator following.
 */
export function branchListTextCollationSql(): Prisma.Sql {
  return Prisma.raw(
    `COLLATE "${LIST_QUERY_TEXT_COLLATION[ListQueryTextOrdering.Collated]}"`
  );
}

/**
 * `matchesDateWindow`, mirrored. Whether a branch with no trustworthy
 * last-active instant survives the window is declared by
 * `BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS`, not decided here.
 *
 * `branchListLastActiveAtSql` has already folded both row-value cases into one
 * NULL by the time this predicate runs, so it reads the FOLDED disposition: this
 * mirror cannot select different rows for the two cases, and a declaration that
 * asked it to is refused rather than half-applied. The kernel, which holds the
 * metric's availability state, does tell them apart.
 */
export function branchListDateWindowSql(
  query: BranchServerPageQuery,
  lastActiveAt: Prisma.Sql = Prisma.sql`dims.last_active_at`
): Prisma.Sql {
  if (!(query.startDate || query.endDate)) {
    return Prisma.sql`TRUE`;
  }
  const bounds: Prisma.Sql[] = [];
  if (query.startDate) {
    bounds.push(
      Prisma.sql`${lastActiveAt} >= ${new Date(listQueryWindowBoundMs(query.startDate))}`
    );
  }
  if (query.endDate) {
    bounds.push(
      Prisma.sql`${lastActiveAt} <= ${new Date(listQueryWindowBoundMs(query.endDate))}`
    );
  }
  const bounded = Prisma.sql`(${Prisma.join(bounds, " AND ")})`;
  if (
    !listQueryRetainsUnjudgeableRow(
      listQueryFoldedRowDisposition(BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS)
    )
  ) {
    return bounded;
  }
  return Prisma.sql`(
    ${lastActiveAt} IS NULL
    OR ${bounded}
  )`;
}

/**
 * PRD-721: the free-text term, mirrored from `matchesSearch`. A scope like the
 * date window rather than a facet: it narrows the cohort every facet count is
 * read over, so a count never offers an option the term has already removed.
 * Branch name and repository, the two fields Desktop also carries.
 */
export function branchListSearchSql(query: BranchServerPageQuery): Prisma.Sql {
  const term = query.search?.trim();
  if (!term) {
    return Prisma.sql`TRUE`;
  }
  const pattern = toSqlContainsPattern(term);
  return Prisma.sql`(
    dims.branch_name ILIKE ${pattern} ESCAPE '\\'
    OR dims.repository ILIKE ${pattern} ESCAPE '\\'
  )`;
}

/**
 * One boolean column per filter facet, so a facet's own cross-filtered count
 * can drop exactly its own predicate and keep the other eight. `matchesFilters`
 * omits one facet at a time for the same reason.
 */
export function branchListFilterFlagsSql(
  query: BranchServerPageQuery
): Prisma.Sql {
  const flags = Object.values(BranchListFilterFacet).map(
    (facet) =>
      Prisma.sql`${branchListFacetPredicateSql(facet, query)} AS ${Prisma.raw(
        branchListPassColumn(facet)
      )}`
  );
  return Prisma.join(flags, ",\n      ");
}

/** The pass-column name for one facet, shared by the writer and the readers. */
export function branchListPassColumn(facet: BranchListFilterFacet): string {
  return `pass_${facet.replace(UPPERCASE_RUN, "_$1").toLowerCase()}`;
}

/** Every pass column ANDed — the fully filtered cohort the page is cut from. */
export function branchListAllPassSql(): Prisma.Sql {
  return branchListPassSql(undefined);
}

/** Every pass column except `omitted`, which is a facet's counted population. */
export function branchListPassSql(
  omitted: BranchListFilterFacet | undefined
): Prisma.Sql {
  const columns = Object.values(BranchListFilterFacet)
    .filter((facet) => facet !== omitted)
    .map((facet) => Prisma.raw(`flagged.${branchListPassColumn(facet)}`));
  return Prisma.join(columns, " AND ");
}

/**
 * `sortValue` plus the `compareAvailable`/`compareMissing` pair: a row the key
 * cannot rank resolves BEFORE the direction sign is applied, so the side it
 * lands on is the same in both directions and is declared by
 * `BRANCH_LIST_SORT_VALUE_SEMANTICS`. `canonicalIdentity` breaks ties ascending
 * whichever way the column is sorted.
 */
export function branchListOrderBySql(
  query: BranchServerPageQuery,
  ordering: BranchStatusOrdering
): Prisma.Sql {
  const direction =
    query.sortDir === BranchListSortDirection.Asc
      ? Prisma.raw("ASC")
      : Prisma.raw("DESC");
  const keys = branchListSortExpressionsSql(query.sortKey, ordering).map(
    (expression) => Prisma.sql`${expression} ${direction}`
  );
  const unrankedDirection = listQueryOrdersUnrankedRowFirst(
    BRANCH_LIST_SORT_VALUE_SEMANTICS[query.sortKey]
  )
    ? Prisma.raw("DESC")
    : Prisma.raw("ASC");
  return Prisma.sql`
    (${branchListSortNullSql(query.sortKey, ordering)}) ${unrankedDirection},
    ${Prisma.join(keys, ",\n    ")},
    flagged.id::text ${branchListTextCollationSql()} ASC
  `;
}

function branchListSortNullSql(
  sortKey: BranchListSortKey,
  ordering: BranchStatusOrdering
): Prisma.Sql {
  const [first] = branchListSortExpressionsSql(sortKey, ordering);
  return Prisma.sql`${first ?? Prisma.sql`NULL`} IS NULL`;
}

/**
 * The Pull-request key is a PAIR — repository then number — and the repository
 * half is the BRANCH's, un-normalized, exactly as `repositoryFor` reads it.
 */
function branchListSortExpressionsSql(
  sortKey: BranchListSortKey,
  ordering: BranchStatusOrdering
): Prisma.Sql[] {
  switch (sortKey) {
    case BranchListSortKey.Name:
      return [Prisma.sql`flagged.branch_name ${branchListTextCollationSql()}`];
    case BranchListSortKey.Owner:
      return [Prisma.sql`flagged.owner_label ${branchListTextCollationSql()}`];
    case BranchListSortKey.Sessions:
      return [Prisma.sql`flagged.session_count`];
    case BranchListSortKey.Changes:
      return [Prisma.sql`flagged.loc_change`];
    case BranchListSortKey.Status:
      return [branchListStatusRankSql(ordering)];
    case BranchListSortKey.PullRequest:
      return [
        Prisma.sql`CASE
          WHEN flagged.pull_request_number IS NOT NULL THEN flagged.repository
        END ${branchListTextCollationSql()}`,
        Prisma.sql`flagged.pull_request_number`,
      ];
    case BranchListSortKey.LastActivity:
      return [Prisma.sql`flagged.last_active_at`];
    case BranchListSortKey.Repo:
      return [Prisma.sql`flagged.repository ${branchListTextCollationSql()}`];
    case BranchListSortKey.Priority:
      return [branchListPriorityRankSql()];
    default:
      return unsupportedSortKey(sortKey);
  }
}

/** A sort key added to the union without an expression here fails `tsc`. */
function unsupportedSortKey(sortKey: never): Prisma.Sql[] {
  throw new TypeError(`Unsupported Branch list sort key: ${String(sortKey)}`);
}

/**
 * ISS-10332: the kernel's `priorityOrdinal`, ranked off the same low→high
 * member list rather than the Postgres enum's declaration order, so the page
 * cannot order differently from a client re-sort. No priority ranks nowhere
 * and falls to the unavailable arm — last in both directions.
 */
function branchListPriorityRankSql(): Prisma.Sql {
  return Prisma.sql`array_position(
    ${textArraySql(PRIORITY_VALUES)},
    flagged.priority::text
  )`;
}

/**
 * ISS-9437: the rank comes from the RESOLVED ordering the page is built with,
 * so the order rows sort in is the order the Status filter menu lists. A status
 * the ordering does not name ranks nowhere and falls to the unavailable arm.
 */
function branchListStatusRankSql(ordering: BranchStatusOrdering): Prisma.Sql {
  const members = ordering.order.map((status) => Prisma.sql`${status}`);
  return Prisma.sql`array_position(
    ARRAY[${Prisma.join(members)}]::text[],
    flagged.status
  )`;
}

function branchListFacetPredicateSql(
  facet: BranchListFilterFacet,
  query: BranchServerPageQuery
): Prisma.Sql {
  switch (facet) {
    case BranchListFilterFacet.Name:
      return includesSql(Prisma.sql`dims.branch_name`, query.names);
    case BranchListFilterFacet.Owner:
      return includesSql(Prisma.sql`dims.owner_key`, query.owners);
    case BranchListFilterFacet.Collaborators:
      return overlapsSql(
        Prisma.sql`dims.collaborator_keys`,
        query.collaborators
      );
    case BranchListFilterFacet.Status:
      return includesSql(Prisma.sql`dims.status`, query.statuses);
    case BranchListFilterFacet.PullRequest:
      return includesSql(
        Prisma.sql`dims.pull_request_presence`,
        query.pullRequests
      );
    case BranchListFilterFacet.LastActive:
      // `?? ""` in the kernel: a row with no range can never match a non-empty
      // selection, and the empty string is not an offered option.
      return includesSql(
        Prisma.sql`COALESCE(dims.last_active_range, '')`,
        query.lastActiveRanges
      );
    case BranchListFilterFacet.Repository:
      return includesSql(Prisma.sql`dims.repository`, query.repositories);
    case BranchListFilterFacet.Tags:
      return overlapsSql(Prisma.sql`dims.tag_ids`, query.tags);
    case BranchListFilterFacet.Changes:
      return branchListLocRangeSql(query);
    case BranchListFilterFacet.Priority:
      return branchListPriorityFilterSql(query.priorities);
    default:
      return unsupportedFilterFacet(facet);
  }
}

/** A facet added to the union without a predicate here fails `tsc`, not a page. */
function unsupportedFilterFacet(facet: never): Prisma.Sql {
  throw new TypeError(`Unsupported Branch list filter facet: ${String(facet)}`);
}

/**
 * `matchesLocRange`, mirrored. Whether a branch with no change count survives
 * an active bound is declared by the Changes facet.
 *
 * Both arms are explicit. Leaving the retaining arm as bare comparisons would
 * read as "no cut" and still drop the row: `NULL >= n` is NULL, not TRUE, and
 * `branchListPassSql` ANDs the result.
 *
 * Folded, like the kernel's `matchesLocRange`: `dims.loc_change` is one nullable
 * column with no availability state beside it, so a Changes declaration naming
 * two different answers is refused rather than half-applied.
 */
function branchListLocRangeSql(query: BranchServerPageQuery): Prisma.Sql {
  if (query.locMin === undefined && query.locMax === undefined) {
    return Prisma.sql`TRUE`;
  }
  const bounds: Prisma.Sql[] = [];
  if (query.locMin !== undefined) {
    bounds.push(Prisma.sql`dims.loc_change >= ${query.locMin}`);
  }
  if (query.locMax !== undefined) {
    bounds.push(Prisma.sql`dims.loc_change <= ${query.locMax}`);
  }
  const bounded = Prisma.sql`(${Prisma.join(bounds, " AND ")})`;
  if (
    listQueryRetainsUnjudgeableRow(
      listQueryFoldedRowDisposition(
        BRANCH_LIST_FILTER_VALUE_SEMANTICS[BranchListFilterFacet.Changes]
      )
    )
  ) {
    return Prisma.sql`(dims.loc_change IS NULL OR ${bounded})`;
  }
  return Prisma.sql`(dims.loc_change IS NOT NULL AND ${bounded})`;
}

/**
 * `matchesPriorityFilter`: the unset arm is `IS NULL`, which no `= ANY(...)`
 * list can express, so the two arms are ORed.
 */
function branchListPriorityFilterSql(
  selected: readonly PriorityFilterValue[] | undefined
): Prisma.Sql {
  const { members, includesUnset } = splitPriorityFilter(selected);
  const arms: Prisma.Sql[] = [];
  if (members.length > 0) {
    arms.push(Prisma.sql`dims.priority::text = ANY(${textArraySql(members)})`);
  }
  if (includesUnset) {
    arms.push(Prisma.sql`dims.priority IS NULL`);
  }
  return arms.length === 0
    ? Prisma.sql`TRUE`
    : Prisma.sql`(${Prisma.join(arms, " OR ")})`;
}

function includesSql(
  value: Prisma.Sql,
  selected: readonly string[] | undefined
): Prisma.Sql {
  if (!selected || selected.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`${value} = ANY(${textArraySql(selected)})`;
}

function overlapsSql(
  values: Prisma.Sql,
  selected: readonly string[] | undefined
): Prisma.Sql {
  if (!selected || selected.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`${values} && ${textArraySql(selected)}`;
}

function textArraySql(values: readonly string[]): Prisma.Sql {
  return Prisma.sql`ARRAY[${Prisma.join(
    values.map((value) => Prisma.sql`${value}`)
  )}]::text[]`;
}

const UPPERCASE_RUN = /([A-Z])/g;
