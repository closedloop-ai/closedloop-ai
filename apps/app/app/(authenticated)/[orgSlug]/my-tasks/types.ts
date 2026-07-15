import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";

export type MyTasksArtifactFilters = {
  priorities: Priority[];
  projectIds: string[];
  // Mixed board: Document and Feature statuses (PRD-495).
  statuses: ArtifactStatus[];
};
