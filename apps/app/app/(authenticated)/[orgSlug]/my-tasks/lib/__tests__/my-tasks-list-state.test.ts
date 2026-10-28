import { describe, expect, it } from "vitest";
import {
  type MyTasksListStateInput,
  resolveMyTasksListState,
} from "../my-tasks-list-state";

/** Settled, signed-in, nothing failing, nothing loading. */
const SETTLED: MyTasksListStateInput = {
  isArtifactsError: false,
  isArtifactsFetching: false,
  isArtifactsLoading: false,
  isProjectsLoading: false,
  isServerPagedList: false,
  renderableRowCount: 0,
  isTreeDataLoading: false,
  isTreeStreamError: false,
  isUserError: false,
  isUserLoading: false,
  mergedTreeData: null,
  rawArtifactCount: 0,
};

describe("resolveMyTasksListState — the server-paged tab's row source", () => {
  // ISS-10472 (tamsinb, PR #9091): the All tab draws its rows from the tree
  // PAGE. A narrowing changes that read's key, its data goes undefined, and the
  // 500-row documents window would otherwise vouch for rows the board does not
  // have — `DocumentsView` then rendered "No items match your filters" for a
  // page still in flight, once per narrowing.
  it("counts the in-flight tree read as loading when the page holds no rows", () => {
    const state = resolveMyTasksListState({
      ...SETTLED,
      isServerPagedList: true,
      isTreeDataLoading: true,
      mergedTreeData: null,
      rawArtifactCount: 500,
      renderableRowCount: 0,
    });

    expect(state.isTasksLoading).toBe(true);
    // Still true, and deliberately: it is the UNPAGED "has any task at all"
    // signal that separates a zero-match filter from an empty queue.
    expect(state.hasAnyTasks).toBe(true);
  });

  it("stops loading once the narrowed page lands empty", () => {
    const state = resolveMyTasksListState({
      ...SETTLED,
      isServerPagedList: true,
      isTreeDataLoading: false,
      mergedTreeData: { externalParents: [], nodes: [] },
      rawArtifactCount: 500,
      renderableRowCount: 0,
    });

    expect(state.isTasksLoading).toBe(false);
    expect(state.hasAnyTasks).toBe(true);
  });

  it("does not hold a skeleton over a settled page of document roots", () => {
    // `treeHasRenderableArtifacts` asks whether a tree carries a BRANCH or
    // SESSION row, so it is false for the ordinary page — reading it as "the
    // board has nothing" would put a skeleton over 50 rendered rows every time
    // the documents stream refetched.
    const state = resolveMyTasksListState({
      ...SETTLED,
      isArtifactsFetching: true,
      isServerPagedList: true,
      mergedTreeData: { externalParents: [], nodes: [] },
      rawArtifactCount: 500,
      renderableRowCount: 50,
    });

    expect(state.isTasksLoading).toBe(false);
  });

  it("keeps the browser-paged tabs on the documents window", () => {
    // The counterfactual for the case above: the same inputs on a tab whose
    // rows ARE the documents stream must not hold a skeleton over rows it has.
    const state = resolveMyTasksListState({
      ...SETTLED,
      isServerPagedList: false,
      isTreeDataLoading: true,
      mergedTreeData: null,
      rawArtifactCount: 500,
      renderableRowCount: 500,
    });

    expect(state.isTasksLoading).toBe(false);
  });
});

describe("resolveMyTasksListState — which streams gate the total", () => {
  // ISS-10472 AC2/AC6 (tamsinb, PR #9091): the server-paged total is the
  // route's own count over the predicate the page was drawn from, so a
  // `/documents` refetch cannot move it by a row. Holding the figure on that
  // read withheld a number whose inputs had all landed.
  it("publishes the exact total while the documents read is refetching", () => {
    const state = resolveMyTasksListState({
      ...SETTLED,
      isArtifactsFetching: true,
      isServerPagedList: true,
      rawArtifactCount: 500,
      renderableRowCount: 50,
    });

    expect(state.isTotalSettled).toBe(true);
  });

  it("still holds the merged total while the documents read is refetching", () => {
    const state = resolveMyTasksListState({
      ...SETTLED,
      isArtifactsFetching: true,
      isServerPagedList: false,
      rawArtifactCount: 500,
      renderableRowCount: 500,
    });

    expect(state.isTotalSettled).toBe(false);
  });

  it("holds the server-paged total while the tree read is in flight", () => {
    const state = resolveMyTasksListState({
      ...SETTLED,
      isServerPagedList: true,
      isTreeDataLoading: true,
      rawArtifactCount: 500,
      renderableRowCount: 50,
    });

    expect(state.isTotalSettled).toBe(false);
  });
});
