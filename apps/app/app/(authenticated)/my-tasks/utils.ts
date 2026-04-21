import {
  DocumentStatus,
  DocumentType,
  type DocumentWithWorkstream,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { MyTasksFeatureFilters } from "./types";

export const EMPTY_FILTERS: MyTasksFeatureFilters = {
  priorities: [],
  projectIds: [],
  statuses: [],
};

export const DISPLAY_GROUPS: {
  key: string;
  label: string;
  statuses: DocumentStatus[];
}[] = [
  {
    key: "draft",
    label: "Draft",
    statuses: [DocumentStatus.Draft],
  },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: [DocumentStatus.InProgress],
  },
  {
    key: "in_review",
    label: "In Review",
    statuses: [DocumentStatus.InReview],
  },
  { key: "approved", label: "Approved", statuses: [DocumentStatus.Approved] },
  { key: "executed", label: "Executed", statuses: [DocumentStatus.Executed] },
  { key: "done", label: "Done", statuses: [DocumentStatus.Done] },
  { key: "obsolete", label: "Obsolete", statuses: [DocumentStatus.Obsolete] },
];

/**
 * Build API query params. Only passes assigneeId to the API;
 * all other filtering is done client-side via `applyClientFilters`.
 */
export function buildFeatureListParams(
  assigneeId: string | null
): FindDocumentsOptions {
  return {
    type: DocumentType.Feature,
    assigneeId: assigneeId ?? undefined,
  };
}

/**
 * Apply all selected filters client-side.
 */
export function applyClientFilters(
  features: DocumentWithWorkstream[],
  filters: MyTasksFeatureFilters
): DocumentWithWorkstream[] {
  return features.filter((feature) => {
    if (
      filters.projectIds.length > 0 &&
      !(feature.projectId && filters.projectIds.includes(feature.projectId))
    ) {
      return false;
    }
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(feature.status)
    ) {
      return false;
    }
    if (
      filters.priorities.length > 0 &&
      !filters.priorities.includes(feature.priority)
    ) {
      return false;
    }
    return true;
  });
}

export function hasActiveFilters(filters: MyTasksFeatureFilters): boolean {
  return (
    filters.projectIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.priorities.length > 0
  );
}
