import {
  type ArtifactStatus,
  DocumentStatus,
  type DocumentWithProject,
  FeatureStatus,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { MyTasksArtifactFilters } from "./types";

export const EMPTY_FILTERS: MyTasksArtifactFilters = {
  priorities: [],
  projectIds: [],
  statuses: [],
};

/**
 * Unified My Tasks columns (PRD-495). The board mixes Documents and Features,
 * which carry disjoint status vocabularies, so each column groups the
 * equivalent statuses from both. Drag-to-set-status resolves the per-type
 * target via `columnTargetStatus` in my-tasks-kanban.tsx.
 */
export const DISPLAY_GROUPS: {
  key: string;
  label: string;
  statuses: ArtifactStatus[];
}[] = [
  {
    key: "backlog",
    label: "Backlog",
    statuses: [
      DocumentStatus.Draft,
      FeatureStatus.Triage,
      FeatureStatus.Backlog,
    ],
  },
  { key: "todo", label: "To Do", statuses: [FeatureStatus.Todo] },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: [FeatureStatus.InProgress],
  },
  {
    key: "in_review",
    label: "In Review",
    statuses: [DocumentStatus.InReview],
  },
  {
    key: "blocked",
    label: "Blocked / Changes",
    statuses: [DocumentStatus.ChangesRequested, FeatureStatus.Blocked],
  },
  { key: "approved", label: "Approved", statuses: [DocumentStatus.Approved] },
  { key: "executed", label: "Executed", statuses: [DocumentStatus.Executed] },
  { key: "done", label: "Done", statuses: [FeatureStatus.Done] },
  {
    key: "closed",
    label: "Closed",
    statuses: [DocumentStatus.Obsolete, FeatureStatus.Canceled],
  },
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
  artifacts: DocumentWithProject[],
  filters: MyTasksArtifactFilters
): DocumentWithProject[] {
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
