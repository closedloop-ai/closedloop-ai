import type { FindIssuesOptions } from "@repo/api/src/types/issue";
import { IssueStatus } from "@repo/api/src/types/issue";
import type { MyTasksIssueFilters } from "./types";

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

export function buildIssueListParams(
  assigneeId: string | null,
  issueFilters?: MyTasksIssueFilters
): FindIssuesOptions {
  const params: FindIssuesOptions = {
    assigneeId: assigneeId ?? undefined,
  };
  if (issueFilters?.projectId) {
    params.projectId = issueFilters.projectId;
  }
  if (issueFilters?.status) {
    params.status = issueFilters.status;
  }
  if (issueFilters?.priority) {
    params.priority = issueFilters.priority;
  }
  return params;
}
