/**
 * Placeholder data for the Branches page (web `/branches` and the desktop
 * Branches view).
 *
 * There is no branch-list endpoint yet on either surface — branches today live
 * only inside per-project trees and the per-branch `branch-view`. This module
 * is the wiring seam: the fast-follow should replace `BRANCH_SAMPLE_ROWS` with
 * a real `useBranches`-style hook returning `BranchRow[]` from a new aggregate
 * endpoint (branch name, repo, PR state, checks rollup, ahead/behind, diff
 * size) — locally sourced on desktop, API-sourced on web.
 */

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

export function shortRepoName(repo: string): string {
  const segments = repo.split("/").filter(Boolean);
  return segments.at(-1) ?? repo;
}

export const BRANCH_SAMPLE_ROWS: BranchRow[] = [
  {
    id: "br_1270",
    branchName: "agent/repo-overrides-workspace-config",
    baseBranch: "main",
    repo: "closedloop-web",
    owner: "Parker Byrd",
    status: BranchRowStatus.Merged,
    prNumber: 1270,
    prTitle: "Migrate repositoryOverrides → workspace config",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1270",
    prState: "MERGED",
    checksPassed: 12,
    checksTotal: 12,
    checksStatus: "PASSING",
    behind: 0,
    ahead: 2,
    additions: 261,
    deletions: 150,
    sessionCount: 3,
    commentCount: null,
    lastActivityLabel: "2h ago",
  },
  {
    id: "br_1271",
    branchName: "agent/repo-overrides-backfill",
    baseBranch: "main",
    repo: "closedloop-web",
    owner: "Parker Byrd",
    status: BranchRowStatus.Merged,
    prNumber: 1271,
    prTitle: "Backfill workspace_settings + keep legacy alias",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1271",
    prState: "MERGED",
    checksPassed: 12,
    checksTotal: 12,
    checksStatus: "PASSING",
    behind: 0,
    ahead: 2,
    additions: 268,
    deletions: 0,
    sessionCount: 2,
    commentCount: null,
    lastActivityLabel: "2h ago",
  },
  {
    id: "br_1284",
    branchName: "agent/synthetic-seed-generator",
    baseBranch: "main",
    repo: "symphony-alpha",
    owner: "Alex Rivera",
    status: BranchRowStatus.Review,
    prNumber: 1284,
    prTitle: "Synthetic seed generator for fixtures",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1284",
    prState: "OPEN",
    checksPassed: 9,
    checksTotal: 11,
    checksStatus: "FAILING",
    behind: 3,
    ahead: 4,
    additions: 412,
    deletions: 38,
    sessionCount: 4,
    commentCount: null,
    lastActivityLabel: "1h ago",
  },
  {
    id: "br_1281",
    branchName: "agent/inbox-realtime-v2",
    baseBranch: "main",
    repo: "closedloop-web",
    owner: "Sam Chen",
    status: BranchRowStatus.Open,
    prNumber: 1281,
    prTitle: "Inbox v2 — realtime updates",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1281",
    prState: "OPEN",
    checksPassed: 12,
    checksTotal: 12,
    checksStatus: "PASSING",
    behind: 1,
    ahead: 6,
    additions: 188,
    deletions: 44,
    sessionCount: 2,
    commentCount: null,
    lastActivityLabel: "3h ago",
  },
  {
    id: "br_session_cost",
    branchName: "fix/session-cost-rounding",
    baseBranch: "develop",
    repo: "closedloop-api",
    owner: "Jordan Lee",
    status: BranchRowStatus.Draft,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: 0,
    ahead: 1,
    additions: 24,
    deletions: 6,
    sessionCount: 1,
    commentCount: null,
    lastActivityLabel: "5h ago",
  },
  {
    id: "br_1289",
    branchName: "agent/skill-registry-loader",
    baseBranch: "main",
    repo: "infra",
    owner: "Alex Rivera",
    status: BranchRowStatus.Blocked,
    prNumber: 1289,
    prTitle: "Skill registry loader",
    prUrl: "https://github.com/closedloop-ai/infra/pull/1289",
    prState: "OPEN",
    checksPassed: 3,
    checksTotal: 9,
    checksStatus: "FAILING",
    behind: 8,
    ahead: 3,
    additions: 96,
    deletions: 210,
    sessionCount: 5,
    commentCount: null,
    lastActivityLabel: "1d ago",
  },
  {
    id: "br_saml",
    branchName: "agent/saml-sso-implementation",
    baseBranch: "main",
    repo: "symphony-alpha",
    owner: "Sam Chen",
    status: BranchRowStatus.Open,
    prNumber: 1290,
    prTitle: "SAML SSO — implementation",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1290",
    prState: "OPEN",
    checksPassed: 10,
    checksTotal: 12,
    checksStatus: "FAILING",
    behind: 2,
    ahead: 5,
    additions: 540,
    deletions: 72,
    sessionCount: 3,
    commentCount: null,
    lastActivityLabel: "6h ago",
  },
  {
    id: "br_dark_mode",
    branchName: "agent/design-system-dark-mode",
    baseBranch: "main",
    repo: "closedloop-web",
    owner: "Jordan Lee",
    status: BranchRowStatus.Review,
    prNumber: 1288,
    prTitle: "Implement dark mode",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1288",
    prState: "OPEN",
    checksPassed: 12,
    checksTotal: 12,
    checksStatus: "PASSING",
    behind: 0,
    ahead: 3,
    additions: 314,
    deletions: 58,
    sessionCount: 2,
    commentCount: null,
    lastActivityLabel: "yesterday",
  },
];

/**
 * Multi-select branch filters: each facet holds the set of selected values
 * (status keys, owner names, short repo names). An empty array means "no
 * constraint" for that facet. Drives the `FilterPopover` facet-group UX shared
 * by web `/branches` and the desktop Branches view.
 */
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

/** Status facet options (all defined statuses, with per-status counts). */
export function branchStatusFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  return Object.values(BranchRowStatus).map((status) => ({
    id: status,
    label: BRANCH_STATUS_CONFIG[status].label,
    count: rows.filter((row) => row.status === status).length,
  }));
}

/** Repository facet options derived from the rows in view, with counts. */
export function branchRepoFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const repos = [...new Set(rows.map((row) => shortRepoName(row.repo)))].sort();
  return repos.map((repo) => ({
    id: repo,
    label: repo,
    count: rows.filter((row) => shortRepoName(row.repo) === repo).length,
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
