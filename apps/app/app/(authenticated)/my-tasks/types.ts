import type { Priority } from "@repo/api/src/types/common";
import type { IssueStatus } from "@repo/api/src/types/issue";

export type MyTasksIssueFilters = {
  priorities: Priority[];
  projectIds: string[];
  statuses: IssueStatus[];
};
