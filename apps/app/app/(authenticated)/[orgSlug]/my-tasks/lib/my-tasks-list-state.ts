import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { treeHasRenderableArtifacts } from "@repo/app/documents/lib/table-view-pipeline";

export type MyTasksListStateInput = {
  rawArtifactCount: number;
  mergedTreeData: ProjectTreeResponse | null | undefined;
  isUserLoading: boolean;
  isUserError: boolean;
  isArtifactsLoading: boolean;
  isArtifactsFetching: boolean;
  isArtifactsError: boolean;
  isProjectsLoading: boolean;
  isTreeDataLoading: boolean;
  /** True when the branch or merged-tree read (the second task stream) failed. */
  isTreeStreamError: boolean;
};

export type MyTasksListState = {
  hasAnyTasks: boolean;
  isTasksError: boolean;
  isTasksLoading: boolean;
  isTotalSettled: boolean;
};

/**
 * Resolve the list view's loading / error / empty decision from the (many)
 * async signals feeding My Tasks (FEA-3938). Extracted from `page.tsx` so the
 * render body stays under the cognitive-complexity ceiling and the decision is
 * unit-testable on its own (ISS-4576 moved it into `lib/` alongside the other
 * pure list-state helpers).
 *
 * - `hasAnyTasks`: tasks come from two independent streams — the documents list
 *   and the branch/session rows nested in the merged project tree. A branch-only
 *   user has zero documents but a non-empty tree, so keying "empty" off the
 *   document count alone would flash (and keep) the empty state for that user
 *   because `DocumentsView` never mounts.
 * - `isTasksError`: a failed `/me`, `/documents`, or the branch/tree read
 *   (`isTreeStreamError`) settles `isLoading` to false while the hooks default
 *   missing data to empty values, so without this the page would render "your
 *   queue is clear" — or a total-bearing footer missing a whole stream — for a
 *   failed read. Folding the branch/tree failure in means a degraded second
 *   stream surfaces the Try-again error state instead of a partial honest total
 *   (ISS-4466, shafty023).
 * - `isTasksLoading`: every window that must settle before we can decide
 *   empty-vs-has-tasks — the resolving user, the artifacts fetch, the projects
 *   list the empty state renders from, and, while no rows exist yet, the tree
 *   read that supplies branch/session tasks. `isFetching` (not just `isLoading`)
 *   covers a stale-cache `[]` refetch, whose `isLoading` is already false, so the
 *   skeleton holds instead of flashing empty until the refetched rows arrive.
 * - `isTotalSettled`: BOTH task streams (documents + branch/tree) have finished
 *   loading, so the paginator's `total` counts every stream — not a partial "of
 *   N" that grows as the tree stream lands after documents. The footer's honest
 *   count is gated on this so it never publishes a total mid-load (shafty023).
 */
export function resolveMyTasksListState({
  rawArtifactCount,
  mergedTreeData,
  isUserLoading,
  isUserError,
  isArtifactsLoading,
  isArtifactsFetching,
  isArtifactsError,
  isProjectsLoading,
  isTreeDataLoading,
  isTreeStreamError,
}: MyTasksListStateInput): MyTasksListState {
  const hasAnyTasks =
    rawArtifactCount > 0 || treeHasRenderableArtifacts(mergedTreeData);
  const isTasksError = isUserError || isArtifactsError || isTreeStreamError;
  const isSettling =
    isUserLoading ||
    isArtifactsLoading ||
    isProjectsLoading ||
    (!hasAnyTasks && (isArtifactsFetching || isTreeDataLoading));
  // The total covers documents AND branch/tree rows, so it is only honest once
  // both streams have settled. Gate the count footer on this so it never shows
  // a partial "of N" while the tree stream is still landing after documents.
  const isTotalSettled = !(
    isUserLoading ||
    isArtifactsLoading ||
    isArtifactsFetching ||
    isTreeDataLoading
  );
  return {
    hasAnyTasks,
    isTasksError,
    isTasksLoading: !isTasksError && isSettling,
    isTotalSettled,
  };
}
