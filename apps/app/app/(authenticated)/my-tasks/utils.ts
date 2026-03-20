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
 * Build API query params. Only passes assigneeId to the API;
 * all other filtering is done client-side via `applyClientFilters`.
 */
export function buildIssueListParams(
  assigneeId: string | null
): FindIssuesOptions {
  return {
    assigneeId: assigneeId ?? undefined,
  };
}

/**
 * Apply all selected filters client-side.
 */
export function applyClientFilters(
  issues: IssueWithWorkstream[],
  filters: MyTasksIssueFilters
): IssueWithWorkstream[] {
  return issues.filter((issue) => {
    if (
      filters.projectIds.length > 0 &&
      !filters.projectIds.includes(issue.projectId)
    ) {
      return false;
    }
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(issue.status)
    ) {
      return false;
    }
    if (
      filters.priorities.length > 0 &&
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
