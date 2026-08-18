import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  RENDER_MISSING,
  shortRepoName,
} from "./branch-row";

/** Sortable scalar columns in the approved Branches table. */
export const BranchSortKey = {
  Name: "name",
  Owner: "owner",
  Sessions: "sessions",
  Changes: "changes",
  Status: "status",
  PullRequest: "pr",
  LastActivity: "lastActivity",
  Repo: "repo",
} as const;
export type BranchSortKey = (typeof BranchSortKey)[keyof typeof BranchSortKey];

export const BranchSortDir = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type BranchSortDir = (typeof BranchSortDir)[keyof typeof BranchSortDir];

type SortValue = string | number | { repo: string; number: number } | null;

/**
 * Sort populated values in the requested direction, always place unavailable
 * values last, and finish with the canonical Branch identity.
 */
export function sortBranchRows(
  rows: BranchRow[],
  key: BranchSortKey,
  dir: BranchSortDir,
  approved = true
): BranchRow[] {
  if (!approved) {
    return sortLegacyBranchRows(rows, key, dir);
  }
  return [...rows].sort((left, right) => {
    const compared = compareAvailable(
      sortValue(left, key),
      sortValue(right, key)
    );
    if (compared !== 0) {
      if (compared === null) {
        return compareMissing(sortValue(left, key), sortValue(right, key));
      }
      return dir === BranchSortDir.Asc ? compared : -compared;
    }
    return (left.canonicalIdentity ?? left.id).localeCompare(
      right.canonicalIdentity ?? right.id
    );
  });
}

function sortLegacyBranchRows(
  rows: BranchRow[],
  key: BranchSortKey,
  dir: BranchSortDir
): BranchRow[] {
  const decorated = rows.map((row) => ({
    row,
    sortKey: legacySortValue(row, key),
  }));
  decorated.sort((left, right) => {
    const compared =
      typeof left.sortKey === "string" && typeof right.sortKey === "string"
        ? left.sortKey.localeCompare(right.sortKey)
        : Number(left.sortKey) - Number(right.sortKey);
    return dir === BranchSortDir.Asc ? compared : -compared;
  });
  return decorated.map(({ row }) => row);
}

function legacySortValue(row: BranchRow, key: BranchSortKey): string | number {
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
      return (row.additions ?? 0) + (row.deletions ?? 0);
    case BranchSortKey.LastActivity: {
      const occurredAt = row.lastActivityAt
        ? Date.parse(row.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      return Number.isNaN(occurredAt) ? Number.NEGATIVE_INFINITY : occurredAt;
    }
    default:
      return row.sessionCount;
  }
}

/** Finite top-level windows retain unavailable Last-active rows. */
export function filterBranchRowsByWindow(
  rows: BranchRow[],
  startDate: string | undefined,
  endDate?: string
): BranchRow[] {
  if (!(startDate || endDate)) {
    return rows;
  }
  const startMs = startDate ? Date.parse(startDate) : Number.NEGATIVE_INFINITY;
  const endMs = endDate ? Date.parse(endDate) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return rows;
  }
  return rows.filter((row) => {
    if (!row.lastActivityAt) {
      return true;
    }
    const occurredAt = Date.parse(row.lastActivityAt);
    return (
      Number.isNaN(occurredAt) || (occurredAt >= startMs && occurredAt <= endMs)
    );
  });
}

function sortValue(row: BranchRow, key: BranchSortKey): SortValue {
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
      return BRANCH_STATUS_CONFIG[row.status].label;
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
    default:
      return null;
  }
}

function compareAvailable(left: SortValue, right: SortValue): number | null {
  if (left === null || right === null) {
    return left === right ? 0 : null;
  }
  if (typeof left === "object" && typeof right === "object") {
    const repository = left.repo.localeCompare(right.repo);
    return repository === 0 ? left.number - right.number : repository;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

function compareMissing(left: SortValue, right: SortValue): number {
  if (left === null && right !== null) {
    return 1;
  }
  if (left !== null && right === null) {
    return -1;
  }
  return 0;
}
