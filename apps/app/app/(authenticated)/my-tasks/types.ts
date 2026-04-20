import type { Priority } from "@repo/api/src/types/common";
import type { DocumentStatus } from "@repo/api/src/types/document";

export type MyTasksFeatureFilters = {
  priorities: Priority[];
  projectIds: string[];
  statuses: DocumentStatus[];
};
