import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { BRANCH_STATUS_CONFIG, type BranchRow, shortRepoName } from "../mock";
import { PullRequestPresence, pullRequestPresence } from "./branch-list-filter";

type SortValue = string | number | { repo: string; number: number } | null;

/**
 * Sort prototype branch rows by the same underlying fields used in production.
 */
export function sortBranchRows(
  rows: readonly BranchRow[],
  key: string,
  direction: SortDirection
): BranchRow[] {
  return [...rows].sort((a, b) => {
    const aValue = sortValue(a, key);
    const bValue = sortValue(b, key);
    const compared = compareAvailable(aValue, bValue);
    if (compared !== 0) {
      if (compared === null) {
        return compareMissing(aValue, bValue);
      }
      return direction === "asc" ? compared : -compared;
    }
    const nameOrder = a.branchName.localeCompare(b.branchName);
    if (nameOrder !== 0) {
      return nameOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

function sortValue(row: BranchRow, key: string): SortValue {
  switch (key) {
    case "name":
      return row.branchName;
    case "owner":
      return row.owner;
    case "status":
      return BRANCH_STATUS_CONFIG[row.status].label;
    case "pullRequest":
      if (pullRequestPresence(row) === PullRequestPresence.None) {
        return null;
      }
      return row.prNumber === null
        ? null
        : { repo: row.repo, number: row.prNumber };
    case "sessions":
      return row.sessionCount;
    case "lastActivity":
      return finiteTimestamp(row.lastActivityAt);
    case "changes":
      return row.additions === null && row.deletions === null
        ? null
        : (row.additions ?? 0) + (row.deletions ?? 0);
    case "repo":
      return shortRepoName(row.repo);
    default:
      return row.branchName;
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

function finiteTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
