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
  /** True when the tree read (the second task stream) failed. */
  isTreeStreamError: boolean;
  /**
   * Whether the SERVER drew this page, in which case the tree is the board's
   * only row source and `rawArtifactCount` cannot vouch for what is on screen
   * (ISS-10472).
   */
  isServerPagedList: boolean;
  /**
   * Rows the ACTIVE source yielded for this page — `treeDocumentRows` on the
   * server-paged tab, the documents window on the others.
   *
   * Distinct from `rawArtifactCount`, which counts one stream whether or not
   * the board draws from it, and from `treeHasRenderableArtifacts`, which asks
   * whether a tree carries a BRANCH or SESSION row and is therefore false for a
   * page of documents.
   */
  renderableRowCount: number;
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
 * - `hasAnyTasks`: rows come from two independent streams — the documents list
 *   and the tree read. Branches are not tasks, so `mergedTreeData` arrives
 *   already pruned of every branch and the sessions under it (ISS-12463): a
 *   user whose tree held only a branch and its sessions gets the empty state.
 *   The tree check stays because the prune drops branches and their subtrees
 *   only, so a session row that does not hang off a branch survives it and
 *   renders; keying "empty" off the document count alone would hide that row
 *   behind the empty state, because `DocumentsView` never mounts.
 * - `isTasksError`: a failed `/me`, `/documents`, or tree read
 *   (`isTreeStreamError`) settles `isLoading` to false while the hooks default
 *   missing data to empty values, so without this the page would render "your
 *   queue is clear" — or a total-bearing footer missing a whole stream — for a
 *   failed read. Folding the tree failure in means a degraded second
 *   stream surfaces the Try-again error state instead of a partial honest total
 *   (ISS-4466, davetho).
 * - `isTasksLoading`: every window that must settle before we can decide
 *   empty-vs-has-tasks — the resolving user, the artifacts fetch, the projects
 *   list the empty state renders from, and, while no rows exist yet, the tree
 *   read that can supply rows of its own. `isFetching` (not just `isLoading`)
 *   covers a stale-cache `[]` refetch, whose `isLoading` is already false, so the
 *   skeleton holds instead of flashing empty until the refetched rows arrive.
 *   "No rows exist yet" is read off the ACTIVE source: on the server-paged tab
 *   the board draws from the tree page alone, so a narrowing — a status toggle,
 *   a keystroke — changes that read's key, its data goes undefined, and the
 *   documents window would otherwise report rows the board does not have. The
 *   view then rendered "No items match your filters" for a page still in
 *   flight, once per narrowing (tamsinb, PR #9091).
 * - `isTotalSettled`: every stream the TOTAL is counted over has settled. On a
 *   browser-paged tab that is both: the paginator counts root groups over the
 *   documents merged with the tree, which nests them and can add rows of its
 *   own, so a count taken before the tree lands is a partial "of N" that
 *   changes when it does (davetho). On the SERVER-paged tab the total is the
 *   route's `count(*)` over the predicate the page was drawn from, so the
 *   documents read cannot move it by a single row — holding an exact figure on
 *   that read's `isFetching` withheld a number whose inputs had all landed
 *   (ISS-10472 AC2/AC6, tamsinb PR #9091).
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
  isServerPagedList,
  renderableRowCount,
}: MyTasksListStateInput): MyTasksListState {
  const hasAnyTasks =
    rawArtifactCount > 0 || treeHasRenderableArtifacts(mergedTreeData);
  // What the board can actually RENDER right now, which is not the same claim
  // as `hasAnyTasks`: the latter stays the unpaged "has any task at all" signal
  // that separates a zero-match filter from an empty queue, and on the
  // server-paged tab it is the only thing the documents window can still
  // honestly say.
  const hasRenderableRows = isServerPagedList
    ? renderableRowCount > 0
    : hasAnyTasks;
  const isTasksError = isUserError || isArtifactsError || isTreeStreamError;
  const isSettling =
    isUserLoading ||
    isArtifactsLoading ||
    isProjectsLoading ||
    (!hasRenderableRows && (isArtifactsFetching || isTreeDataLoading));
  // Which streams the total is counted over decides which ones gate it. The
  // browser-paged total merges documents WITH the tree; the server-paged one is
  // the route's own count over the tree predicate, and no documents row enters
  // it.
  const isDocumentsStreamCounted = !isServerPagedList;
  const isTotalSettled = !(
    isUserLoading ||
    (isDocumentsStreamCounted && (isArtifactsLoading || isArtifactsFetching)) ||
    isTreeDataLoading
  );
  return {
    hasAnyTasks,
    isTasksError,
    isTasksLoading: !isTasksError && isSettling,
    isTotalSettled,
  };
}
