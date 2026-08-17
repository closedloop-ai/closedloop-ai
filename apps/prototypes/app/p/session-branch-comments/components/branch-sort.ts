import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { type BranchRow, shortRepoName } from "../mock";

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
    if (aValue < bValue) {
      return direction === "asc" ? -1 : 1;
    }
    if (aValue > bValue) {
      return direction === "asc" ? 1 : -1;
    }
    return 0;
  });
}

function sortValue(row: BranchRow, key: string): string | number {
  switch (key) {
    case "name":
      return row.branchName;
    case "owner":
      return row.owner ?? "";
    case "status":
      return row.status;
    case "pullRequest":
      return row.prNumber ?? -1;
    case "sessions":
      return row.sessionCount;
    case "lastActivity":
      return Date.parse(row.lastActivityAt);
    case "changes":
      return (row.additions ?? 0) + (row.deletions ?? 0);
    case "repo":
      return shortRepoName(row.repo);
    default:
      return row.branchName;
  }
}
