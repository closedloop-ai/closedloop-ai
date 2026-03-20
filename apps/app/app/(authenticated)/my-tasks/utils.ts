import type {
  FindIssuesOptions,
  IssueWithWorkstream,
} from "@repo/api/src/types/issue";
import { IssueStatus } from "@repo/api/src/types/issue";
import type { MyTasksIssueFilters } from "./types";

export const EMPTY_FILTERS: MyTasksIssueFilters = {
  priorities: [],
  projectIds: [],
  statuses: [],
};

export const DISPLAY_GROUPS: {
  key: string;
  label: string;
  statuses: IssueStatus[];
}[] = [
  {
    key: "not_started",
    label: "Not started",
    statuses: [IssueStatus.NotStarted],
  },
  {
    key: "in_progress",
    label: "In progress",
    statuses: [IssueStatus.InProgress],
  },
  { key: "in_review", label: "In review", statuses: [IssueStatus.InReview] },
  { key: "completed", label: "Completed", statuses: [IssueStatus.Completed] },
  { key: "obsolete", label: "Obsolete", statuses: [IssueStatus.Obsolete] },
];

/**
 * Build API query params. The API only supports single-value filters,
 * so we only pass a filter when exactly one value is selected.
 * Multi-value filtering is handled client-side via `applyClientFilters`.
 */
export function buildIssueListParams(
  assigneeId: string | null,
  issueFilters?: MyTasksIssueFilters
): FindIssuesOptions {
  const params: FindIssuesOptions = {
    assigneeId: assigneeId ?? undefined,
  };
  if (issueFilters?.projectIds.length === 1) {
    params.projectId = issueFilters.projectIds[0];
  }
  if (issueFilters?.statuses.length === 1) {
    params.status = issueFilters.statuses[0];
  }
  if (issueFilters?.priorities.length === 1) {
    params.priority = issueFilters.priorities[0];
  }
  return params;
}

/**
 * Apply multi-value filters client-side for dimensions with >1 selection.
 */
export function applyClientFilters(
  issues: IssueWithWorkstream[],
  filters: MyTasksIssueFilters
): IssueWithWorkstream[] {
  return issues.filter((issue) => {
    if (
      filters.projectIds.length > 1 &&
      !filters.projectIds.includes(issue.projectId)
    ) {
      return false;
    }
    if (
      filters.statuses.length > 1 &&
      !filters.statuses.includes(issue.status)
    ) {
      return false;
    }
    if (
      filters.priorities.length > 1 &&
      !filters.priorities.includes(issue.priority)
    ) {
      return false;
    }
    return true;
  });
}

export function hasActiveFilters(filters: MyTasksIssueFilters): boolean {
  return (
    filters.projectIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.priorities.length > 0
  );
}
