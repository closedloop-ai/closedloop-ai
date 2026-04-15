import type {
  FeatureWithWorkstream,
  FindFeaturesOptions,
} from "@repo/api/src/types/feature";
import { FeatureStatus } from "@repo/api/src/types/feature";
import type { MyTasksFeatureFilters } from "./types";

export const EMPTY_FILTERS: MyTasksFeatureFilters = {
  priorities: [],
  projectIds: [],
  statuses: [],
};

export const DISPLAY_GROUPS: {
  key: string;
  label: string;
  statuses: FeatureStatus[];
}[] = [
  {
    key: "draft",
    label: "Draft",
    statuses: [FeatureStatus.Draft],
  },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: [FeatureStatus.InProgress],
  },
  { key: "in_review", label: "In Review", statuses: [FeatureStatus.InReview] },
  { key: "approved", label: "Approved", statuses: [FeatureStatus.Approved] },
  { key: "executed", label: "Executed", statuses: [FeatureStatus.Executed] },
  { key: "done", label: "Done", statuses: [FeatureStatus.Done] },
  { key: "obsolete", label: "Obsolete", statuses: [FeatureStatus.Obsolete] },
];

/**
 * Build API query params. Only passes assigneeId to the API;
 * all other filtering is done client-side via `applyClientFilters`.
 */
export function buildFeatureListParams(
  assigneeId: string | null
): FindFeaturesOptions {
  return {
    assigneeId: assigneeId ?? undefined,
  };
}

/**
 * Apply all selected filters client-side.
 */
export function applyClientFilters(
  features: FeatureWithWorkstream[],
  filters: MyTasksFeatureFilters
): FeatureWithWorkstream[] {
  return features.filter((feature) => {
    if (
      filters.projectIds.length > 0 &&
      !filters.projectIds.includes(feature.projectId)
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
