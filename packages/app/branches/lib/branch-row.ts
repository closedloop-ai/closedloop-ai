import type { BranchPrState } from "@repo/api/src/types/branch";
import type { ChecksStatus } from "@repo/api/src/types/branch-checks";
import type { TableFilterOption } from "@repo/design-system/components/ui/table-filters";

export const BranchRowStatus = {
  Open: "open",
  Review: "review",
  Merged: "merged",
  Draft: "draft",
  Blocked: "blocked",
} as const;
export type BranchRowStatus =
  (typeof BranchRowStatus)[keyof typeof BranchRowStatus];

/** Render placeholder for a NULL string-valued enrichment column (repo/base). */
export const RENDER_MISSING = "—";
/** Render fallback for a NULL branch owner (no actor capture in v1). */
export const RENDER_UNATTRIBUTED = "unattributed";

export type BranchRow = {
  id: string;
  branchName: string;
  baseBranch: string;
  repo: string;
  owner: string;
  status: BranchRowStatus;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  /** PR lifecycle for the badge color; NULL when there is no linked PR. */
  prState: BranchPrState | null;
  checksPassed: number | null;
  checksTotal: number | null;
  /** Checks rollup; NULL = enrichment absent (rendered as empty, NOT passing). */
  checksStatus: ChecksStatus | null;
  /** NULL = unavailable/gated — rendered as the empty-value affordance, NOT 0. */
  behind: number | null;
  ahead: number | null;
  /** NULL = enrichment unavailable (`lines_added`/`removed`) — NOT 0. */
  additions: number | null;
  deletions: number | null;
  /** Count of sessions linked to the branch (0 → empty-value affordance). */
  sessionCount: number;
  /** PR comment count (soft Epic F3 consumer); NULL until that lands. */
  commentCount: number | null;
  lastActivityLabel: string;
  /**
   * PLN-1034: raw ISO genuine-activity timestamp — the sortable source
   * `lastActivityLabel` is formatted from. Optional so hand-built fixtures may
   * omit it, but the wire→render adapter always populates it, so every live row
   * sorts deterministically by recency regardless of the order the data source
   * returns rows in.
   */
  lastActivityAt?: string;
};

type BranchStatusVariant =
  | "info"
  | "warning"
  | "success"
  | "muted"
  | "destructive";

export const BRANCH_STATUS_CONFIG: Record<
  BranchRowStatus,
  { label: string; variant: BranchStatusVariant }
> = {
  [BranchRowStatus.Open]: { label: "Open", variant: "info" },
  [BranchRowStatus.Review]: { label: "In review", variant: "warning" },
  [BranchRowStatus.Merged]: { label: "Merged", variant: "success" },
  [BranchRowStatus.Draft]: { label: "Draft", variant: "muted" },
  [BranchRowStatus.Blocked]: {
    label: "Changes requested",
    variant: "destructive",
  },
};

export type BranchFilters = {
  statuses: string[];
  owners: string[];
  repos: string[];
};

export const DEFAULT_BRANCH_FILTERS: BranchFilters = {
  statuses: [],
  owners: [],
  repos: [],
};

export function shortRepoName(repo: string): string {
  const segments = repo.split("/").filter(Boolean);
  return segments.at(-1) ?? repo;
}

/** Status facet options (all defined statuses, with per-status counts). */
export function branchStatusFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const counts = new Map<BranchRowStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return Object.values(BranchRowStatus).map((status) => ({
    id: status,
    label: BRANCH_STATUS_CONFIG[status].label,
    count: counts.get(status) ?? 0,
  }));
}

/** Repository facet options derived from the rows in view, with counts. */
export function branchRepoFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const repo = shortRepoName(row.repo);
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((repo) => ({
    id: repo,
    label: repo,
    count: counts.get(repo) ?? 0,
  }));
}

export function filterBranchRows(
  rows: BranchRow[],
  filters: BranchFilters
): BranchRow[] {
  return rows.filter(
    (row) =>
      (filters.statuses.length === 0 ||
        filters.statuses.includes(row.status)) &&
      (filters.owners.length === 0 || filters.owners.includes(row.owner)) &&
      (filters.repos.length === 0 ||
        filters.repos.includes(shortRepoName(row.repo)))
  );
}
