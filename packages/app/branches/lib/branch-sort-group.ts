import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  shortRepoName,
} from "./branch-row";

/**
 * Client-side sort keys for the Branches table. Values match the table column
 * ids so a column-header click can pass the id straight through as the sort key.
 */
export const BranchSortKey = {
  Name: "name",
  Repo: "repo",
  Owner: "owner",
  Status: "status",
  LastActivity: "lastActivity",
  Sessions: "sessions",
  Changes: "changes",
} as const;
export type BranchSortKey = (typeof BranchSortKey)[keyof typeof BranchSortKey];

export const BranchSortDir = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type BranchSortDir = (typeof BranchSortDir)[keyof typeof BranchSortDir];

function changeTotal(row: BranchRow): number {
  return (row.additions ?? 0) + (row.deletions ?? 0);
}

/**
 * Parse the producer-owned `lastActivityAt` to an epoch ms for ordering. It may
 * be a mixed timestamp format (space- vs `T`-separated), so compare by true
 * instant via `Date.parse` rather than lexically (a space `0x20` sorts before
 * `T` `0x54`, which would misorder same-day rows). Missing or unparseable values
 * sort oldest, landing at the bottom of the default newest-first order.
 */
function parseActivityMs(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Sort the (already filtered) rows. `desc` is newest-first; "lastActivity"
 * compares by parsed instant (see `parseActivityMs`), the other keys compare
 * their render field. Correct no matter what order the data source returned rows
 * in — the local SQLite source pre-sorts newest-first, but the HTTP source may
 * not.
 */
export function sortBranchRows(
  rows: BranchRow[],
  key: BranchSortKey,
  dir: BranchSortDir
): BranchRow[] {
  // Decorate-sort-undecorate: derive each row's sort key exactly once (O(N))
  // instead of recomputing it for both operands on every comparison
  // (~2·N·log₂N `Date.parse` / `shortRepoName` / status-label lookups for the
  // default lastActivity sort). String keys compare by `localeCompare`, every
  // other key by numeric subtraction — the same field, comparison, and
  // fall-through the per-row comparator used.
  const stringKey =
    key === BranchSortKey.Name ||
    key === BranchSortKey.Repo ||
    key === BranchSortKey.Owner ||
    key === BranchSortKey.Status;
  const sortKeyOf = (row: BranchRow): string | number => {
    switch (key) {
      case BranchSortKey.Name:
        return row.branchName;
      case BranchSortKey.Repo:
        return shortRepoName(row.repo);
      case BranchSortKey.Owner:
        return row.owner;
      case BranchSortKey.Status:
        return BRANCH_STATUS_CONFIG[row.status].label;
      case BranchSortKey.Changes:
        return changeTotal(row);
      case BranchSortKey.LastActivity:
        return parseActivityMs(row.lastActivityAt);
      default:
        return row.sessionCount;
    }
  };
  const decorated = rows.map((row) => ({ row, sortKey: sortKeyOf(row) }));
  decorated.sort((a, b) => {
    const compared = stringKey
      ? (a.sortKey as string).localeCompare(b.sortKey as string)
      : (a.sortKey as number) - (b.sortKey as number);
    return dir === BranchSortDir.Asc ? compared : -compared;
  });
  return decorated.map((entry) => entry.row);
}

/**
 * Filter rows to those active on/after `startDate` (an ISO instant from
 * `getStartDateForRange`). Compares by true instant via `Date.parse` rather than
 * a byte-wise string compare: `lastActivityAt` is the producer-owned wire value
 * (`eventActivity ?? updatedAt`) and may be a mixed timestamp format (space- vs
 * `T`-separated), where a lexicographic compare would mis-drop a recent row
 * (a space `0x20` sorts before `T` `0x54`). Rows with no — or an unparseable —
 * timestamp are kept rather than silently dropped. `startDate` undefined (the
 * "All time" window) returns the rows unchanged.
 */
export function filterBranchRowsByWindow(
  rows: BranchRow[],
  startDate: string | undefined
): BranchRow[] {
  if (!startDate) {
    return rows;
  }
  const startMs = Date.parse(startDate);
  if (Number.isNaN(startMs)) {
    return rows;
  }
  return rows.filter((row) => {
    if (row.lastActivityAt == null) {
      return true;
    }
    const ms = Date.parse(row.lastActivityAt);
    return Number.isNaN(ms) || ms >= startMs;
  });
}
