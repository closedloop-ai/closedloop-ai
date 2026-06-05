import type { Priority } from "@repo/api/src/types/common";
import type { FeatureStatus } from "@repo/api/src/types/feature";

export type MyTasksFeatureFilters = {
  priorities: Priority[];
  projectIds: string[];
  statuses: FeatureStatus[];
};
