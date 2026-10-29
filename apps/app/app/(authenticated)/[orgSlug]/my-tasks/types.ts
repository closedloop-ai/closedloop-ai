import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { PriorityFacetValue } from "@repo/app/documents/components/table/document-table-filters";

export type MyTasksArtifactFilters = {
  /** ISS-9665: includes the unset facet value, so "no priority" is filterable. */
  priorities: PriorityFacetValue[];
  projectIds: string[];
  // Mixed board: Document and Feature statuses (PRD-495).
  statuses: ArtifactStatus[];
};
