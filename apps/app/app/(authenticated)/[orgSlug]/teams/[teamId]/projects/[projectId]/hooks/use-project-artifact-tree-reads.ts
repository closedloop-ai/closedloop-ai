"use client";

import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import {
  PROJECT_TREE_MAX_ROOT_LIMIT,
  type ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import {
  collectDocumentRowsFromTree,
  type DocumentRowData,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { withPriorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import {
  useProjectTreeRootPages,
  useProjectTreeWithDetails,
} from "@repo/app/projects/hooks/use-project-tree";
import {
  useFeatureFlagEnabledOptional,
  useFeatureFlagGate,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCallback, useMemo } from "react";
import {
  buildProjectTreeCategoryReadOptions,
  buildProjectTreeReadOptions,
  isProjectArtifactTreeLoading,
  toProjectTreeCategory,
} from "../lib/project-artifacts-pagination";

type UseProjectArtifactTreeReadsInput = {
  projectId: string;
  /** Active tab's category; Overview is passed as `isOverview`, not a category. */
  filterCategory: FilterCategory;
  isOverview: boolean;
  /** Whether the ISS-5307 pagination flag is on for this viewer. */
  isPaginationEnabled: boolean;
  /** Whether that flag has RESOLVED — it shapes the request, so it gates it. */
  isPaginationFlagReady: boolean;
  /** Project/team context every derived row carries. */
  rowProject: DocumentRowData["project"];
};

type UseProjectArtifactTreeReadsResult = {
  /**
   * The project-wide tree. Still the source for Overview, the All tab, and the
   * "does this project have artifacts at all" signal, so it stays mounted on
   * every tab.
   */
  projectTreeData: ProjectTreeDetailsResponse | undefined;
  /** Refetch and merge bounded root pages after an inline artifact creation. */
  refreshProjectTree: () => Promise<ProjectTreeDetailsResponse | undefined>;
  /** Flat document rows derived from {@link projectTreeData}. */
  allDocuments: DocumentRowData[];
  /**
   * The corpus the ACTIVE tab counts, slices, and renders: the category-scoped
   * read on a filtered tab, the project-wide read otherwise.
   */
  tabTreeData: ProjectTreeDetailsResponse | undefined;
  /** Flat document rows for {@link tabTreeData}. */
  tabDocuments: DocumentRowData[];
  /** True while either read the active tab depends on is still in flight. */
  loadingArtifacts: boolean;
  /**
   * True when a read the active tab depends on FAILED.
   *
   * Its own state, distinct from `loadingArtifacts` and from an empty
   * `tabDocuments`, because the three mean three different things to a reader:
   * still arriving, could not be fetched, and genuinely has none. A failed
   * TanStack query clears `isLoading` and leaves `data` undefined, so folding
   * this into the other two would render "this project has no artifacts" over a
   * request that never answered — the UI asserting a fact nobody established
   * (whitlockk, PR #6745).
   */
  artifactsReadFailed: boolean;
  /** Whether another hierarchy root-subtree page is available. */
  hasMoreRootPages: boolean;
  /** Whether the next hierarchy root-subtree page is being read. */
  isLoadingMoreRootPages: boolean;
  /** Read the next hierarchy root-subtree page without draining all cursors. */
  loadMoreRootPages: () => void;
  /** Refetch every read the active tab depends on, for the failure state's retry. */
  retryArtifactReads: () => void;
};

/**
 * The project page's artifact tree reads, extracted from `page.tsx` so that
 * component stays an orchestrator under the cognitive-complexity ceiling.
 *
 * TWO reads, because a filtered tab needs the server to filter BEFORE it
 * bounds. The project-wide read's `?limit=` counts MIXED roots, so filtering
 * its prefix in the browser both under-fills pages ("1–93 of 148 issues" on a
 * 100-row page) and misses every match that sorts past the bound ("no PRDs" in
 * a project whose PRDs live after root 500). The category read asks the server
 * for that tab's population and bounds THAT, so the bound, the pages, and the
 * footer all count what the tab renders.
 *
 * The project-wide read is not replaced by it: Overview and the All tab render
 * the whole tree, and `hasArtifactItems` is a project-wide claim that must stay
 * true on a tab whose own category is empty — otherwise an empty PRDs tab would
 * report the project has no artifacts.
 */
export function useProjectArtifactTreeReads(
  input: UseProjectArtifactTreeReadsInput
): UseProjectArtifactTreeReadsResult {
  const {
    filterCategory,
    isOverview,
    isPaginationEnabled,
    isPaginationFlagReady,
    projectId,
    rowProject,
  } = input;
  const { enabled: isHierarchyEnabled, isReady: isHierarchyFlagReady } =
    useFeatureFlagGate(MANUAL_ARTIFACT_ORDERING_FLAG_KEY);
  const treeReadReady = isPaginationFlagReady && isHierarchyFlagReady;
  const projectTreeReadOptions = buildProjectTreeReadOptions(
    isPaginationEnabled,
    treeReadReady,
    projectId
  );
  projectTreeReadOptions.enabled =
    projectTreeReadOptions.enabled && !isHierarchyEnabled;

  const {
    data: legacyProjectTreeData,
    isLoading: isLegacyProjectTreeLoading,
    isError: isLegacyProjectTreeError,
    refetch: refetchLegacyProjectTree,
  } = useProjectTreeWithDetails(projectId, projectTreeReadOptions);
  const projectRootPages = useProjectTreeRootPages(projectId, {
    enabled: treeReadReady && isHierarchyEnabled,
    filters: projectTreeReadOptions.filters,
  });

  // Overview renders no table, so it needs no category read even though its
  // `FilterCategory` resolves to the All tab's value.
  const treeCategory = isOverview
    ? null
    : toProjectTreeCategory(filterCategory);
  const categoryReadOptions =
    isHierarchyEnabled && treeCategory !== null
      ? {
          enabled: treeReadReady && Boolean(projectId),
          filters: {
            category: treeCategory,
            ...(isPaginationEnabled && { limit: PROJECT_TREE_MAX_ROOT_LIMIT }),
          },
        }
      : (buildProjectTreeCategoryReadOptions(
          isPaginationEnabled,
          treeReadReady,
          projectId,
          treeCategory
        ) ?? { enabled: false });
  const {
    data: legacyCategoryTreeData,
    isLoading: isLegacyCategoryTreeLoading,
    isError: isLegacyCategoryTreeError,
    refetch: refetchLegacyCategoryTree,
  } = useProjectTreeWithDetails(projectId, categoryReadOptions);
  const isCategoryReadActive =
    (isPaginationEnabled || isHierarchyEnabled) && treeCategory !== null;
  const enhancedReadStateEnabled = isPaginationEnabled || isHierarchyEnabled;
  const projectTreeData = selectReadValue(
    isHierarchyEnabled,
    projectRootPages.data,
    legacyProjectTreeData
  );
  const categoryTreeData = legacyCategoryTreeData;
  const isProjectTreeLoading = selectReadValue(
    isHierarchyEnabled,
    projectRootPages.isLoading,
    isLegacyProjectTreeLoading
  );
  const isCategoryTreeLoading = isLegacyCategoryTreeLoading;
  const isProjectTreeError = selectReadValue(
    isHierarchyEnabled,
    projectRootPages.isError,
    isLegacyProjectTreeError
  );
  const isCategoryTreeError = isLegacyCategoryTreeError;

  // Retry whichever reads the tab actually depends on. `refetch` on a DISABLED
  // query still runs its queryFn, so an inactive category read is deliberately
  // not retried — it would fire a request the tab is not reading (the dead-end
  // "Try again" My Tasks already had to fix).
  const retryArtifactReads = useCallback(() => {
    retryProjectArtifactReads({
      categoryLegacy: refetchLegacyCategoryTree,
      isCategoryReadActive,
      isHierarchyEnabled,
      projectHierarchy: projectRootPages.refetch,
      projectLegacy: refetchLegacyProjectTree,
    });
  }, [
    isCategoryReadActive,
    isHierarchyEnabled,
    projectRootPages,
    refetchLegacyCategoryTree,
    refetchLegacyProjectTree,
  ]);

  // ISS-9665: an unset priority now reaches the table as `null`. Behind the
  // flag the table shows that; with it off the rows carry the `Medium` the
  // serializer used to fold to, so this page renders exactly as it shipped.
  // Substituted on the ROW MODEL so the cell, the priority group header, the
  // collapse rule and the sort comparator cannot disagree about one row.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  const allDocuments = useMemo(() => {
    const rows = collectDocumentRowsFromTree(projectTreeData, rowProject);
    return unsetPriorityEnabled ? rows : withPriorityDisplayFallback(rows);
  }, [projectTreeData, rowProject, unsetPriorityEnabled]);
  const categoryDocuments = useMemo(() => {
    const rows = collectDocumentRowsFromTree(categoryTreeData, rowProject);
    return unsetPriorityEnabled ? rows : withPriorityDisplayFallback(rows);
  }, [categoryTreeData, rowProject, unsetPriorityEnabled]);

  return {
    allDocuments,
    // The SAME two reads `loadingArtifacts` folds, folded again for failure —
    // the tab depends on the category read for its rows and on the project-wide
    // read for "does this project have artifacts at all", so either failing
    // leaves the table unable to say what it is showing.
    //
    // Gated on the flag for the reason every other behavior here is: with it
    // off no category read is issued, so the failure this surfaces cannot
    // happen, and the flag-off path stays byte-identical to what shipped.
    artifactsReadFailed:
      treeReadReady &&
      enhancedReadStateEnabled &&
      (isProjectTreeError || (isCategoryReadActive && isCategoryTreeError)),
    hasMoreRootPages:
      isHierarchyEnabled &&
      !isCategoryReadActive &&
      projectRootPages.hasNextPage === true,
    isLoadingMoreRootPages:
      isHierarchyEnabled &&
      !isCategoryReadActive &&
      projectRootPages.isFetchingNextPage,
    // Fold BOTH reads into the table's loading state: a category tab that
    // rendered while its own corpus was still in flight would paint the
    // project-wide "no artifacts" empty state over a tab that has rows.
    loadingArtifacts: isProjectArtifactTreeLoading(
      isProjectTreeLoading || (isCategoryReadActive && isCategoryTreeLoading),
      treeReadReady
    ),
    loadMoreRootPages: projectRootPages.loadMore,
    projectTreeData,
    refreshProjectTree: projectRootPages.refetchMerged,
    retryArtifactReads,
    tabDocuments: selectReadValue(
      isCategoryReadActive,
      categoryDocuments,
      allDocuments
    ),
    tabTreeData: selectReadValue(
      isCategoryReadActive,
      categoryTreeData,
      projectTreeData
    ),
  };
}

type RetryRead = () => unknown;

type RetryProjectArtifactReadsInput = {
  categoryLegacy: RetryRead;
  isCategoryReadActive: boolean;
  isHierarchyEnabled: boolean;
  projectHierarchy: RetryRead;
  projectLegacy: RetryRead;
};

function retryProjectArtifactReads(input: RetryProjectArtifactReadsInput) {
  selectReadValue(
    input.isHierarchyEnabled,
    input.projectHierarchy,
    input.projectLegacy
  )();
  if (input.isCategoryReadActive) {
    input.categoryLegacy();
  }
}

function selectReadValue<T>(condition: boolean, active: T, inactive: T): T {
  return condition ? active : inactive;
}
