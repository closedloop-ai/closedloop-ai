import {
  DocumentStatus,
  type DocumentWithWorkstream,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { MyTasksArtifactFilters } from "./types";

export const EMPTY_FILTERS: MyTasksArtifactFilters = {
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
 * Build API query params for the My Tasks page. Returns artifacts of any
 * document type (PRDs, Plans, Features) assigned to the given user.
 * Client-side filtering is applied via `applyClientFilters`.
 */
export function buildArtifactListParams(
  assigneeId: string | null
): FindDocumentsOptions {
  return {
    assigneeId: assigneeId ?? undefined,
  };
}

/**
 * Apply all selected filters client-side.
 */
export function applyClientFilters(
  artifacts: DocumentWithWorkstream[],
  filters: MyTasksArtifactFilters
): DocumentWithWorkstream[] {
  return artifacts.filter((artifact) => {
    if (
      filters.projectIds.length > 0 &&
      !(artifact.projectId && filters.projectIds.includes(artifact.projectId))
    ) {
      return false;
    }
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(artifact.status)
    ) {
      return false;
    }
    if (
      filters.priorities.length > 0 &&
      !filters.priorities.includes(artifact.priority)
    ) {
      return false;
    }
    return true;
  });
}

export function hasActiveFilters(filters: MyTasksArtifactFilters): boolean {
  return (
    filters.projectIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.priorities.length > 0
  );
}
