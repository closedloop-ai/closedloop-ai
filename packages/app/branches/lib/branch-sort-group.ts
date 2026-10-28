import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  type BranchStatusOrdering,
  DEFAULT_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
import {
  PRIORITY_ORDINAL,
  priorityOrdinal,
} from "@repo/api/src/types/search-query";
import { type BranchRow, RENDER_MISSING, shortRepoName } from "./branch-row";

/** Sortable scalar columns in the approved Branches table. */
export const BranchSortKey = BranchListSortKey;
export type BranchSortKey = (typeof BranchSortKey)[keyof typeof BranchSortKey];

export const BranchSortDir = BranchListSortDirection;
export type BranchSortDir = (typeof BranchSortDir)[keyof typeof BranchSortDir];

type SortValue = string | number | { repo: string; number: number } | null;

/**
 * Sort populated values in the requested direction, always place unavailable
 * values last, and finish with the canonical Branch identity.
 *
 * ISS-9437: `ordering` is the resolved status ordering, and BOTH arms take it.
 * The legacy arm below is unreachable in production (`branch-page-state.ts`
 * always passes `approved: true`), but leaving it reading the module-level rank
 * directly would leave a third reference to the very thing the resolved shape
 * exists to replace. Omitted means today's ordering exactly.
 */
export function sortBranchRows(
  rows: BranchRow[],
  key: BranchSortKey,
  dir: BranchSortDir,
  approved = true,
  ordering: BranchStatusOrdering = DEFAULT_BRANCH_STATUS_ORDERING
): BranchRow[] {
  if (!approved) {
    return sortLegacyBranchRows(rows, key, dir, ordering);
  }
  return [...rows].sort((left, right) => {
    const compared = compareAvailable(
      sortValue(left, key, ordering),
      sortValue(right, key, ordering)
    );
    if (compared !== 0) {
      if (compared === null) {
        return compareMissing(
          sortValue(left, key, ordering),
          sortValue(right, key, ordering)
        );
      }
      return dir === BranchSortDir.Asc ? compared : -compared;
    }
    return compareListQueryText(
      left.canonicalIdentity ?? left.id,
      right.canonicalIdentity ?? right.id,
      ListQueryTextOrdering.Collated
    );
  });
}

function sortLegacyBranchRows(
  rows: BranchRow[],
  key: BranchSortKey,
  dir: BranchSortDir,
  ordering: BranchStatusOrdering
): BranchRow[] {
  const decorated = rows.map((row) => ({
    row,
    sortKey: legacySortValue(row, key, ordering),
  }));
  decorated.sort((left, right) => {
    const compared =
      typeof left.sortKey === "string" && typeof right.sortKey === "string"
        ? compareListQueryText(
            left.sortKey,
            right.sortKey,
            ListQueryTextOrdering.Collated
          )
        : Number(left.sortKey) - Number(right.sortKey);
    return dir === BranchSortDir.Asc ? compared : -compared;
  });
  return decorated.map(({ row }) => row);
}

function legacySortValue(
  row: BranchRow,
  key: BranchSortKey,
  ordering: BranchStatusOrdering
): string | number {
  switch (key) {
    case BranchSortKey.Name:
      return row.branchName;
    case BranchSortKey.Repo:
      return shortRepoName(row.repo);
    case BranchSortKey.Owner:
      return row.owner;
    case BranchSortKey.Status:
      // ISS-9666: the semantic rank, never the display label. Sorting on the
      // label made row order a function of presentation strings, so renaming
      // "Changes requested" reordered the table.
      //
      // ISS-9437: this arm negates its comparison wholesale and has no
      // unavailable-value handling at all, so an unranked status is parked at
      // the END of the order rather than expressed as `null`. Under the default
      // ordering that is the pre-existing rank exactly, which is what this
      // unreachable path is required to keep doing.
      return ordering.rank(row.status) ?? ordering.order.length;
    case BranchSortKey.Changes:
      return (row.additions ?? 0) + (row.deletions ?? 0);
    case BranchSortKey.LastActivity: {
      const occurredAt = row.lastActivityAt
        ? Date.parse(row.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      return Number.isNaN(occurredAt) ? Number.NEGATIVE_INFINITY : occurredAt;
    }
    case BranchSortKey.Priority:
      // ISS-10332: the wire ordinal (low→high), the same one the cloud sort
      // compares. This arm parks an unset value past every ranked one, the way
      // it parks an unranked status — and a member this build has no ordinal
      // for lands in the same slot, since `priorityOrdinal` misses rather than
      // handing the comparator `undefined`.
      return row.priority == null
        ? PRIORITY_MEMBER_COUNT
        : (priorityOrdinal(row.priority) ?? PRIORITY_MEMBER_COUNT);
    default:
      return row.sessionCount;
  }
}

function sortValue(
  row: BranchRow,
  key: BranchSortKey,
  ordering: BranchStatusOrdering
): SortValue {
  switch (key) {
    case BranchSortKey.Name:
      return row.branchName;
    case BranchSortKey.Owner:
      return row.owner;
    case BranchSortKey.Sessions:
      return row.sessionCount;
    case BranchSortKey.Changes:
      return row.additions === null && row.deletions === null
        ? null
        : (row.additions ?? 0) + (row.deletions ?? 0);
    case BranchSortKey.Status:
      // ISS-9666: the semantic rank, never the display label. Sorting on the
      // label made row order a function of presentation strings, so renaming
      // "Changes requested" reordered the table.
      //
      // ISS-9437: a `null` rank falls through to `compareMissing`, which
      // resolves before the direction sign — last ascending AND descending.
      return ordering.rank(row.status);
    case BranchSortKey.PullRequest:
      return row.prNumber === null || !row.prRepo
        ? null
        : { repo: row.prRepo, number: row.prNumber };
    case BranchSortKey.LastActivity: {
      if (!row.lastActivityAt) {
        return null;
      }
      const occurredAt = Date.parse(row.lastActivityAt);
      return Number.isNaN(occurredAt) ? null : occurredAt;
    }
    case BranchSortKey.Repo:
      return row.repo === RENDER_MISSING ? null : row.repo;
    case BranchSortKey.Priority:
      // ISS-10332: the wire ordinal (low→high), the SAME one the cloud sort
      // compares (`branch-list-dimension-sql.ts`), so a client re-sort and a
      // server page agree on which end "ascending" is. Unset AND unknown fall
      // to `compareMissing` — last in both directions — as every other absent
      // measurement here does; unknown gets there because `priorityOrdinal`
      // misses on a member this build does not know, where a raw index would
      // hand `compareAvailable` an `undefined` it string-compares.
      return row.priority == null
        ? null
        : (priorityOrdinal(row.priority) ?? null);
    default:
      return null;
  }
}

function compareAvailable(left: SortValue, right: SortValue): number | null {
  if (left === null || right === null) {
    return left === right ? 0 : null;
  }
  if (typeof left === "object" && typeof right === "object") {
    const repository = compareListQueryText(
      left.repo,
      right.repo,
      ListQueryTextOrdering.Collated
    );
    return repository === 0 ? left.number - right.number : repository;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return compareListQueryText(
    String(left),
    String(right),
    ListQueryTextOrdering.Collated
  );
}

/** One past the highest ordinal: where the legacy arm parks an unranked priority. */
const PRIORITY_MEMBER_COUNT = Object.keys(PRIORITY_ORDINAL).length;

function compareMissing(left: SortValue, right: SortValue): number {
  if (left === null && right !== null) {
    return 1;
  }
  if (left !== null && right === null) {
    return -1;
  }
  return 0;
}

/**
 * The ordering a Branches list falls back to.
 *
 * Here rather than in `useBranchViewState` (ISS-9447 M5) because it now has
 * four readers, two of them schemas: both persisted stores fall back to it when
 * a stored sort value is absent or unusable, the toolbar's "Clear sort"
 * reinstates it, and the default named arrangement is built from it. Spelling it
 * per reader is how two of them would come to disagree about what "default"
 * means — and the list is always ordered by something, so clearing means
 * returning here rather than to an unordered state no store can represent.
 */
export const DEFAULT_BRANCH_SORT_KEY: BranchSortKey =
  BranchSortKey.LastActivity;
export const DEFAULT_BRANCH_SORT_DIR: BranchSortDir = BranchSortDir.Desc;
