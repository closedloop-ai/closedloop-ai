"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { ActiveFiltersBar } from "@repo/app/documents/components/table/active-filters-bar";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { FilterPopover } from "@repo/app/documents/components/table/filter-popover";
import {
  SORT_KEYS,
  SortKey,
} from "@repo/app/documents/components/table/sort-keys";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import { useDocumentsGroupLink } from "@repo/app/documents/hooks/use-documents-group-link";
import { useProjectFilters } from "@repo/app/documents/hooks/use-project-filters";
import { treeHasRenderableArtifacts } from "@repo/app/documents/lib/table-view-pipeline";
import { CreateIssueModal } from "@repo/app/issues/components/create-issue-modal";
import { ProjectArtifactList } from "@repo/app/projects/components/project-artifact-list";
import { useArtifactPlacementCapability } from "@repo/app/projects/hooks/use-artifact-placement";
import {
  useDeleteProject,
  useIsFavorite,
  useProject,
  useProjectStatusHandler,
  useToggleFavorite,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import { projectBoardSort } from "@repo/app/projects/lib/project-artifact-board-filters";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useManualArtifactOrderingEnabled } from "@repo/app/shared/feature-flags/use-manual-artifact-ordering";
import { useResponsiveNarrowGridviewEnabled } from "@repo/app/shared/feature-flags/use-responsive-narrow-gridview";
import {
  type ColumnVisibility,
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useTeamMembers } from "@repo/app/teams/hooks/use-team-members";
import { useTeam } from "@repo/app/teams/hooks/use-teams";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Loader2Icon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import {
  projectTeamIdsOf,
  useProjectPermalinkCanonicalization,
} from "@/lib/project-permalink-redirect";
import { ArtifactTruncationEmptyNote } from "./components/artifact-truncation-empty-note";
import { CreateDocumentModal } from "./components/create-document-modal";
import { ProjectActiveSessionsStatus } from "./components/project-active-sessions-status";
import { ProjectArtifactLayoutToggle } from "./components/project-artifact-layout-toggle";
import { ProjectArtifactsRegion } from "./components/project-artifacts-region";
import { ProjectArtifactsView } from "./components/project-artifacts-view";
import { ProjectOverviewPanel } from "./components/project-overview-panel";
import { ProjectRenameDialog } from "./components/project-rename-dialog";
import { useProjectArtifactEditHandlers } from "./hooks/use-project-artifact-edit-handlers";
import { useProjectArtifactLayout } from "./hooks/use-project-artifact-layout";
import { useProjectArtifactTreeReads } from "./hooks/use-project-artifact-tree-reads";
import { useProjectArtifactsPagination } from "./hooks/use-project-artifacts-pagination";
import { useStackRankReset } from "./hooks/use-stack-rank-reset";
import { replaceProjectArtifactLayout } from "./lib/project-detail-view-helpers";
import {
  buildRowProject,
  isProjectPagePending,
} from "./lib/project-page-state";
import { useProjectArtifactsViewStateKeys } from "./project-artifacts-view-state-keys";
import { ProjectDetailHeader } from "./project-detail-header";

// ISS-9726: these two are NOT project-suffixed, so one stored value served
// every project in every organization. Their siblings on this page carry a
// project id, which already isolates them by ORGANIZATION — but not by user, so
// they are namespaced too, through `useProjectArtifactsViewStateKeys`.
const COLUMN_VISIBILITY_BASE_KEY = "table:columns:project-artifacts";
const COLUMN_ORDER_BASE_KEY = "table:column-order:project-artifacts";

// Single merged tab control: "Overview" plus the artifact filter categories.
// `overview` shows the project overview (no table); the rest map 1:1 to
// `FilterCategory` and drive the document table. Defaults to "all".
// FEA-4137: the artifact formerly called "Feature" is now "Issue", so the
// URL-facing tab value is `issues` (the toggle already labels it "Issues"). The
// legacy `?tab=features` deep-link is accepted as a compat alias via
// PROJECT_TAB_ALIASES below and normalized to `issues` on the next tab write.
// The underlying `FilterCategory` stays `features` (see toFilterCategory) so the
// document-table filter/query contract is unchanged.
const PROJECT_TABS = [
  "overview",
  "all",
  "documents",
  "issues",
  "plans",
  "branches",
] as const;

// Legacy `?tab=<old>` values kept working as compat aliases (FEA-4137).
const PROJECT_TAB_ALIASES: Readonly<
  Record<string, (typeof PROJECT_TABS)[number]>
> = { features: "issues" };

export default function ProjectDetailPage() {
  const responsiveNarrowGridview = useResponsiveNarrowGridviewEnabled();
  const params = useRouteParams();
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const { readLatest, replaceSearch } = useLinkedSearchWriter(
    pathname,
    searchParams,
    navigation.replace
  );
  const orgSlug = useOrgSlug();
  const teamId = getStringRouteParam(params, "teamId");
  const projectId = getStringRouteParam(params, "projectId");

  const { activeTab, setActiveTab } = useTabParam({
    validTabs: PROJECT_TABS,
    defaultTab: "all",
    tabAliases: PROJECT_TAB_ALIASES,
  });
  const isOverview = activeTab === "overview";
  // Overview has no table; the remaining tab values are FilterCategory values.
  const filterCategory = toFilterCategory(activeTab);
  const [createArtifactOpen, setCreateArtifactOpen] = useState(false);
  const [createFeatureOpen, setCreateFeatureOpen] = useState(false);
  const [createIssueStatus, setCreateIssueStatus] = useState<IssueStatus>(
    IssueStatus.Backlog
  );
  const [selectedDocumentType, setSelectedDocumentType] =
    useState<DocumentType>(DocumentType.Prd);
  // ISS-9726: one resolution of every persisted key on this surface. A project
  // id isolates these by organization; this adds the USER half, so two accounts
  // sharing a browser profile stop restoring each other's view (whitlockk, #6875).
  const viewStateKeys = useProjectArtifactsViewStateKeys(
    projectId,
    filterCategory
  );
  const [filterText, setFilterText, clearSearch] =
    useViewStatePersistence<string>(viewStateKeys.search, "");
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  // Overview has no scrollable list to restore; the key is already scoped per
  // category, so each of All/Documents/Issues/Plans/Branches keeps its own
  // offset instead of inheriting a neighbouring tab's.
  const { clearPosition: clearScroll } = useScrollRestore(
    isOverview ? null : viewStateKeys.scroll,
    scrollContainer
  );
  const [, , clearSort] = useViewStatePersistence<null>(
    viewStateKeys.sort,
    null
  );
  // ISS-12929 (724-F5): the table's own sort state, read the way DocumentsView
  // reads it, so the board orders its cards as the list orders its rows.
  const tableSort = useSortParams<SortKey>({
    validColumns: SORT_KEYS,
    defaultColumn: SortKey.StackRank,
    defaultDirection: "asc",
    persistenceKey: viewStateKeys.sort,
  });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  // Column visibility — hide the Type column when the active filter already
  // pins items to a single type (Type would be a constant column otherwise).
  // Parent stays user-controlled across all categories.
  const columnOverrides = useMemo((): Partial<ColumnVisibility> => {
    switch (filterCategory) {
      case "documents":
      case "features":
      case "plans":
      case "branches":
        return { [DocumentColumn.Type]: false };
      default:
        return {};
    }
  }, [filterCategory]);
  const columnVisibilityKey = useViewStateKey(COLUMN_VISIBILITY_BASE_KEY);
  const columnOrderKey = useViewStateKey(COLUMN_ORDER_BASE_KEY);
  const {
    userVisibility,
    visibleColumns,
    toggleColumn,
    reorderColumns,
    resetColumnOrder,
  } = useColumnVisibility({
    overrides: columnOverrides,
    storageKey: columnVisibilityKey,
    orderStorageKey: columnOrderKey,
  });
  // PRD-720 AC3: grouping and closed bands ride the URL, over the stored view.
  const {
    collapsedGroups: baseCollapsedGroups,
    groupBy: baseGroupBy,
    setCollapsedGroups: setBaseCollapsedGroups,
    setGroupBy: setBaseGroupBy,
  } = useDocumentsGroupLink({
    expansionStorageKey: viewStateKeys.expansion,
    groupByStorageKey: "table:groupByStatus:project-artifacts",
  });
  const artifactLayoutState = useProjectArtifactLayout({
    activeTab,
    baseCollapsedGroups,
    baseGroupBy,
    onBaseCollapsedGroupsChange: setBaseCollapsedGroups,
    onBaseGroupByChange: setBaseGroupBy,
    onToggleColumn: toggleColumn,
    projectId,
    requestedLayout: searchParams.get("layout"),
    search: searchParams.toString(),
    storageKey: viewStateKeys.board,
    visibleColumns,
  });
  const {
    collapsedGroups,
    groupBy,
    layout: artifactLayout,
    persistCollapsedGroups: setCollapsedGroups,
    persistGroupBy: setGroupBy,
    toggleColumn: handleToggleColumn,
  } = artifactLayoutState;
  const isFavorite = useIsFavorite(projectId);
  const toggleFavorite = useToggleFavorite();
  const deleteProjectMutation = useDeleteProject();

  // Queries
  const {
    data: teamData,
    isLoading: loadingTeam,
    error: teamError,
  } = useTeam(teamId);
  const {
    data: project,
    isLoading: loadingProject,
    error: projectError,
  } = useProject(projectId);

  // ISS-8588: this URL embeds `teamId`, a mutable ancestor, so every link ever
  // shared for the project keeps naming whichever team it was in at the time.
  // Once the project is re-teamed (or that team is deleted — `ProjectTeam`
  // cascades) the team read fails while the org-scoped project read still
  // succeeds, and the `!team` guard below reports "Project not found" over a
  // project that plainly exists.
  //
  // Resolved from `project.teams` rather than the URL, and hoisted ABOVE the
  // loading/error early returns: the guard that swallows this case fires on the
  // TEAM read, so a reconciliation placed after it could never run for the one
  // state it exists to repair.
  const permalinkRedirect = useProjectPermalinkCanonicalization({
    orgSlug,
    requestedTeamId: teamId,
    projectId,
    projectTeamIds: projectTeamIdsOf(project),
    search: searchParams.toString(),
  });

  // ISS-5307: pagination for the artifact tabs, default OFF. With the flag off
  // every line below resolves to the pre-ISS-5307 behavior — an unbounded tree
  // read, no slice, no footer.
  //
  // Gate, not a bare read (whitlockk): this flag SHAPES the tree request, and
  // PostHog resolves asynchronously. `useFeatureFlagEnabled` reads `false`
  // while unresolved, so an enabled viewer would fire the unbounded request
  // first and refetch bounded once the flag landed — paying, at first paint,
  // exactly the cost this ticket removes. `isReady` holds the read until the
  // flag answers, and is bounded, so a flag service that never answers
  // degrades to the closed default rather than an endless skeleton.
  const {
    enabled: isArtifactPaginationEnabled,
    isReady: isArtifactPaginationFlagReady,
  } = useFeatureFlagGate(PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY);
  const rowProject = useMemo(
    () => buildRowProject(project, teamData),
    [project, teamData]
  );
  // The artifact tree reads (PLN-874, ISS-5307), in their own hook so this
  // component stays an orchestrator. TWO reads: the project-wide tree that
  // Overview, the All tab, and the "has artifacts at all" signal render from,
  // and — on a filtered tab — a category-scoped read the SERVER filters before
  // it bounds, so that tab's pages and totals count only rows it renders.
  const {
    allDocuments,
    artifactsReadFailed,
    hasMoreRootPages,
    isLoadingMoreRootPages,
    loadMoreRootPages,
    loadingArtifacts,
    projectTreeData,
    refreshProjectTree,
    retryArtifactReads,
    tabDocuments,
    tabTreeData,
  } = useProjectArtifactTreeReads({
    filterCategory,
    isOverview,
    isPaginationEnabled: isArtifactPaginationEnabled,
    isPaginationFlagReady: isArtifactPaginationFlagReady,
    projectId,
    rowProject,
  });

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;

  const hasArtifactItems = hasRenderableRows(allDocuments, projectTreeData);
  // Filter controls only apply to the artifact table — hidden on Overview and
  // when the project has no artifacts to filter.
  const manualOrderingEnabled = useManualArtifactOrderingEnabled();
  const showSharedProjectTree =
    !isOverview && activeTab === "all" && manualOrderingEnabled;
  const showArtifactControls =
    !(isOverview || showSharedProjectTree) && hasArtifactItems;

  const loading = loadingTeam || loadingProject || loadingArtifacts;
  const error = teamError?.message || projectError?.message || null;

  // Team members for inline editing
  const {
    members: teamMembers,
    isLoading: teamMembersLoading,
    error: teamMembersError,
  } = useTeamMembers({
    teamIds: teamData ? [teamData.id] : [],
  });

  // Current user for "Assigned to me" filter
  const { data: currentUser } = useCurrentUser();
  const canPlaceArtifacts = useArtifactPlacementCapability(projectId);
  const canReorderArtifacts = resolveCanReorderArtifacts(
    manualOrderingEnabled,
    canPlaceArtifacts
  );

  const { data: favoriteArtifacts } = useFavoriteArtifacts();
  const favoriteArtifactIds = useMemo(
    () => favoriteArtifacts?.map((f) => f.id) ?? [],
    [favoriteArtifacts]
  );

  // Project filters. Driven by the ACTIVE tab's corpus, the same one the table
  // counts and renders — not the project-wide read. The facet options are
  // derived from the rows handed in, so sourcing them from the base (bounded)
  // read while the table renders the category read would offer a tab facets
  // that cannot see its own rows: the user filters by an assignee who is
  // plainly on screen and the matching rows vanish (whitlockk, PR #6745). Identical
  // to the previous corpus on the All tab and whenever the flag is off, where
  // `tabDocuments` IS `allDocuments`.
  const filtersReturn = useProjectFilters({
    documents: tabDocuments,
    filterCategory,
    currentUserId: currentUser?.id,
    persistenceKey: viewStateKeys.filters,
    favoriteArtifactIds,
  });

  const filterCurrentUser = useFilterCurrentUser(currentUser);

  // Mutations
  const updatePriorityMutation = useUpdateProjectPriority();
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const {
    handleUpdateStatus: handleProjectStatusUpdate,
    isPending: statusPending,
  } = useProjectStatusHandler({
    onArchived: () =>
      navigation.navigate(`/${orgSlug}/teams/${teamId}/projects`),
  });
  const artifactEditHandlers = useProjectArtifactEditHandlers(teamMembers);
  // Type-scoped delete dispatch (branch vs document endpoint) lives in the
  // shared hook (PLN-874 Task 3.5).
  const handleDeleteArtifact = useDeleteRowItem();

  const handleUpdatePriority = (priority: Priority | null) => {
    if (!project) {
      return;
    }
    updatePriorityMutation.mutate({
      projectId: project.id,
      priority,
    });
  };

  const handleUpdateAssignee = (assigneeId: string | null) => {
    if (!project) {
      return;
    }
    updateAssigneeMutation.mutate({ projectId: project.id, assigneeId });
  };

  const handleUpdateTargetDate = (date: Date | null) => {
    if (!project) {
      return;
    }
    updateTargetDateMutation.mutate({
      projectId: project.id,
      targetDate: date,
    });
  };

  const handleCreateArtifact = (type: DocumentType) => {
    setSelectedDocumentType(type);
    setCreateArtifactOpen(true);
  };

  const handleUpdateProjectStatus = (status: ProjectStatus) => {
    if (!project) {
      return;
    }
    handleProjectStatusUpdate(project.id, status, project.status);
  };

  const handleResetView = useCallback(() => {
    filtersReturn.clearPersistedFilters();
    clearSearch();
    clearScroll();
    clearSort();
    resetColumnOrder();
    const params = readLatest();
    params.delete("sortBy");
    params.delete("sortDir");
    replaceSearch(params);
  }, [
    filtersReturn.clearPersistedFilters,
    clearSearch,
    clearScroll,
    clearSort,
    resetColumnOrder,
    readLatest,
    replaceSearch,
  ]);

  // Clear both facet filters and the (popover-hosted) text search, so the
  // empty-state "Clear filters" action can dismiss a text-only filter.
  const handleClearArtifactFilters = useCallback(() => {
    filtersReturn.clearAllFilters();
    clearSearch();
  }, [filtersReturn.clearAllFilters, clearSearch]);

  const handleArtifactLayoutChange = useCallback(
    (layout: string) => {
      replaceProjectArtifactLayout({
        layout,
        onValidLayout: artifactLayoutState.persistLayout,
        pathname,
        replace: (href) => replaceSearch(new URL(href, ORIGIN).searchParams),
        search: readLatest().toString(),
      });
    },
    [artifactLayoutState.persistLayout, pathname, readLatest, replaceSearch]
  );

  // PRD-421 / PLN-755 Phase D: encapsulated in `useStackRankReset` to keep
  // this component under the cognitive-complexity limit.
  const handleResetToStackRank = useStackRankReset({
    clearSort,
    setGroupBy,
    searchParams,
    navigation,
    pathname,
  });

  // Project (facet) filters apply only when active; the text search is folded
  // into `isAnyArtifactFilterActive` so the table's empty state surfaces a
  // clear affordance for a text-only filter.
  //
  // Hoisted above the loading/error early returns (ISS-5307) because the
  // paginator below is a hook and both values are among its inputs.
  const projectFilters = filtersReturn.isAnyFilterActive
    ? filtersReturn.applyFilters
    : undefined;
  const isAnyArtifactFilterActive = hasAnyArtifactFilter(
    filtersReturn.isAnyFilterActive,
    filterText
  );

  // ISS-5307: page the active tab. The counting and slicing live in the shared
  // `useTableViewPagination` (ISS-4466) via this binding, so the footer's total
  // is the tab's TRUE row count and page membership cannot skip or repeat a
  // row. Does no work and slices nothing while the flag is off.
  const artifactPagination = useProjectArtifactsPagination({
    applyProjectFilters: projectFilters,
    // The ACTIVE tab's corpus: the category-scoped read on filtered tabs, the
    // base read on All (and always when the flag is off). Counting, slicing,
    // and the truncation caveat all describe the same population the tab
    // renders.
    documents: tabDocuments,
    filterCategory,
    filterText,
    groupBy,
    hasArtifactItems,
    isEnabled: isArtifactPaginationEnabled,
    isFilterActive: isAnyArtifactFilterActive,
    isOverview,
    pageSizeStorageKey: viewStateKeys.pageSize,
    scrollContainer,
    sortPersistenceKey: viewStateKeys.sort,
    treeData: tabTreeData,
  });

  if (isProjectPagePending(loading, permalinkRedirect)) {
    // Named, because ISS-8588 routes a NEW case through this branch: a stale
    // permalink used to render a sentence ("Project not found") and now renders
    // this. Without a name that swap leaves a screen-reader user with silence
    // where there used to be words. Same argument the truncation note makes.
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading project</span>
      </div>
    );
  }

  if (error || !project || !team) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{error || "Project not found"}</p>
      </div>
    );
  }

  const favoritesDisabled =
    toggleFavorite.isPending || project.status === ProjectStatus.Archived;

  return (
    <>
      <ProjectDetailHeader
        favoritesDisabled={favoritesDisabled}
        isFavorite={isFavorite}
        onCreateArtifact={handleCreateArtifact}
        onCreateFeature={() => setCreateFeatureOpen(true)}
        onDelete={() => setDeleteDialogOpen(true)}
        onRename={() => setRenameDialogOpen(true)}
        onToggleFavorite={() =>
          toggleFavorite.mutate({ projectId: project.id, isFavorite })
        }
        onUpdateStatus={handleUpdateProjectStatus}
        orgSlug={orgSlug}
        project={project}
        statusPending={statusPending}
        teamId={teamId}
        teamName={team.name}
      />
      <div className="flex flex-1 flex-col gap-0 overflow-hidden">
        <ProjectArtifactTabsBar
          activeFiltersBar={
            <ActiveFiltersBar
              currentUser={filterCurrentUser}
              filtersReturn={filtersReturn}
              teamMembers={teamMembers}
              teamMembersError={teamMembersError}
              teamMembersLoading={teamMembersLoading}
            />
          }
          activeTab={activeTab}
          filterPopover={
            <FilterPopover
              currentUser={filterCurrentUser}
              filtersReturn={filtersReturn}
              teamMembers={teamMembers}
              teamMembersError={teamMembersError}
              teamMembersLoading={teamMembersLoading}
              textFilter={{
                value: filterText,
                onChange: setFilterText,
                placeholder: "Filter items...",
              }}
            />
          }
          hasActiveFilters={filtersReturn.isAnyFilterActive}
          layoutToggle={
            <ProjectArtifactLayoutToggle
              activeTab={activeTab}
              layout={artifactLayout}
              onChange={handleArtifactLayoutChange}
            />
          }
          onTabChange={setActiveTab}
          showArtifactControls={showArtifactControls}
          showFilterPopover={filterCategory !== "branches"}
          tableViewMenu={
            <TableViewMenu
              groupBy={groupBy}
              onChangeGroupBy={setGroupBy}
              onResetToStackRank={handleResetToStackRank}
              onResetView={handleResetView}
              onToggle={handleToggleColumn}
              visibility={userVisibility}
            />
          }
        />
        {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
        <div className="flex-1 overflow-auto" ref={setScrollContainer}>
          <ProjectActiveSessionsStatus
            orgSlug={orgSlug}
            projectId={projectId}
          />
          {isOverview && (
            <ProjectOverviewPanel
              onUpdateAssignee={handleUpdateAssignee}
              onUpdatePriority={handleUpdatePriority}
              onUpdateTargetDate={handleUpdateTargetDate}
              project={project}
            />
          )}
          {showSharedProjectTree && (
            <ProjectArtifactList
              category="all"
              failed={artifactsReadFailed}
              hasMoreRootPages={hasMoreRootPages}
              isLoadingMoreRootPages={isLoadingMoreRootPages}
              loading={loadingArtifacts}
              loadMoreRootPages={loadMoreRootPages}
              onRefresh={refreshProjectTree}
              onRequestCreate={() => setCreateFeatureOpen(true)}
              onRetry={retryArtifactReads}
              project={project}
              teamId={teamId}
              tree={projectTreeData}
            />
          )}
          {!(isOverview || showSharedProjectTree) && (
            <div
              className={artifactsContainmentClass(
                artifactLayout,
                responsiveNarrowGridview
              )}
            >
              <ProjectArtifactsRegion
                hasReadFailed={artifactsReadFailed}
                onRetry={retryArtifactReads}
              >
                <ProjectArtifactsView
                  boardProps={{
                    editHandlers: artifactEditHandlers,
                    filterText,
                    filters: filtersReturn.filters,
                    sort: projectBoardSort(tableSort.sortBy, tableSort.sortDir),
                    groupBy,
                    boardView: artifactLayoutState.view,
                    onAddIssue: (status) => {
                      setCreateIssueStatus(status);
                      setCreateFeatureOpen(true);
                    },
                    project: rowProject,
                    projectId,
                    teamId,
                  }}
                  documentsViewProps={{
                    applyProjectFilters: projectFilters,
                    canReorderArtifacts,
                    collapsedGroups,
                    // ISS-4704: this tab pages by whole sections under the same
                    // gate My Tasks does, so its headers get the same two — the
                    // status's real population, and the mark on a section that
                    // continues from the previous page. Both `undefined` while
                    // that plan is not in force.
                    continuedSectionKeys:
                      artifactPagination.continuedSectionKeys,
                    documents: artifactPagination.pagedDocuments,
                    editHandlers: artifactEditHandlers,
                    filterCategory,
                    filterText,
                    groupBy,
                    // ISS-5307: with paging on, `documents`/`treeData` above are
                    // only this page's subset, so a filter matching nothing on the
                    // current page would otherwise read as "this project has no
                    // artifacts". Hand the view the unpaged truth so it keeps
                    // offering "Clear filters" instead.
                    hasUnpagedItems: artifactPagination.hasUnpagedItems,
                    isFilterActive: isAnyArtifactFilterActive,
                    isTreeDataLoading: loadingArtifacts,
                    onClearFilters: handleClearArtifactFilters,
                    onCollapsedGroupsChange: setCollapsedGroups,
                    onDelete: handleDeleteArtifact,
                    onReorderColumns: reorderColumns,
                    projectId,
                    sectionTotalsByKey: artifactPagination.sectionTotalsByKey,
                    sortPersistenceKey: viewStateKeys.sort,
                    storageKey: viewStateKeys.expansion,
                    teamId,
                    treeData: artifactPagination.pagedTreeData,
                    visibleColumns,
                  }}
                  layout={artifactLayout}
                />
                <ArtifactTruncationEmptyNote
                  note={artifactPagination.emptyStateTruncationNote}
                />
                <HierarchyRootPageContinuation
                  hasMore={hasMoreRootPages}
                  isLoading={isLoadingMoreRootPages}
                  loadMore={loadMoreRootPages}
                />
              </ProjectArtifactsRegion>
            </div>
          )}
        </div>
        {!showSharedProjectTree &&
          artifactLayout !== "board" &&
          artifactPagination.showFooter && (
            <TablePaginationFooter
              className="shrink-0"
              onPageChange={artifactPagination.onPageChange}
              onPageSizeChange={artifactPagination.onPageSizeChange}
              page={artifactPagination.page}
              pageSize={artifactPagination.pageSize}
              pageSizeOptions={artifactPagination.pageSizeOptions}
              readout={artifactPagination.readout}
              totalPages={artifactPagination.totalPages}
              truncationNote={artifactPagination.truncationNote}
            />
          )}
      </div>
      <CreateDocumentModal
        documentType={selectedDocumentType}
        onOpenChange={setCreateArtifactOpen}
        open={createArtifactOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <CreateIssueModal
        initialStatus={createIssueStatus}
        onOpenChange={setCreateFeatureOpen}
        open={createFeatureOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <ProjectRenameDialog
        currentName={project.name}
        onOpenChange={setRenameDialogOpen}
        open={renameDialogOpen}
        projectId={project.id}
      />
      <DeleteConfirmationDialog
        isPending={deleteProjectMutation.isPending}
        itemName={project.name}
        onConfirm={() =>
          confirmProjectDeletion(
            () => deleteProjectMutation.mutateAsync(project.id),
            () => navigation.navigate(`/${orgSlug}/teams/${teamId}/projects`)
          )
        }
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title="Project"
      />
    </>
  );
}

async function confirmProjectDeletion(
  deleteProject: () => Promise<unknown>,
  navigateToProjects: () => void
): Promise<boolean> {
  try {
    await deleteProject();
    navigateToProjects();
    return true;
  } catch {
    return false;
  }
}

// The merged tab control includes "overview" (no table) plus the artifact
// filter categories. Map the active tab to the `FilterCategory` the table
// consumes — "overview" has no table, so it collapses to the harmless "all".
// Whether any artifact filter is applied — facet filters or the (popover-
// hosted) text search. Extracted so the page component stays under the
// cognitive-complexity limit.
function hasAnyArtifactFilter(
  facetsActive: boolean,
  filterText: string
): boolean {
  return facetsActive || filterText.length > 0;
}

function resolveCanReorderArtifacts(
  manualOrderingEnabled: boolean,
  canPlaceArtifacts: boolean
): boolean {
  return manualOrderingEnabled ? canPlaceArtifacts : true;
}

function toFilterCategory(tab: (typeof PROJECT_TABS)[number]): FilterCategory {
  if (tab === "overview") {
    return "all";
  }
  // FEA-4137: the URL-facing `issues` tab drives the unchanged `features`
  // FilterCategory (the document-table filter/query key stays `features`).
  if (tab === "issues") {
    return "features";
  }
  return tab;
}

/**
 * Renderable rows include branch/session artifacts from the tree, not just
 * documents — a project containing only PRs/sessions still shows its toolbar
 * and table (pre-existing gap fixed in PLN-874 Phase 3).
 */
function hasRenderableRows(
  documents: unknown[],
  treeData: ProjectTreeResponse | null | undefined
): boolean {
  return documents.length > 0 || treeHasRenderableArtifacts(treeData);
}
function HierarchyRootPageContinuation({
  hasMore,
  isLoading,
  loadMore,
}: {
  hasMore: boolean;
  isLoading: boolean;
  loadMore: () => void;
}) {
  if (!hasMore) {
    return null;
  }
  return (
    <div className="flex justify-center px-4 pb-4">
      <Button disabled={isLoading} onClick={loadMore} variant="outline">
        {isLoading ? "Loading..." : "Load more"}
      </Button>
    </div>
  );
}

function ProjectArtifactTabsBar({
  activeFiltersBar,
  activeTab,
  filterPopover,
  hasActiveFilters,
  layoutToggle,
  onTabChange,
  showArtifactControls,
  showFilterPopover,
  tableViewMenu,
}: {
  activeFiltersBar: ReactNode;
  activeTab: (typeof PROJECT_TABS)[number];
  filterPopover: ReactNode;
  hasActiveFilters: boolean;
  layoutToggle: ReactNode;
  onTabChange: (tab: string) => void;
  showArtifactControls: boolean;
  showFilterPopover: boolean;
  tableViewMenu: ReactNode;
}) {
  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <ToggleGroup
          aria-label="Filter by artifact type"
          onValueChange={(value) => {
            if (value) {
              onTabChange(value);
            }
          }}
          size="sm"
          type="single"
          value={activeTab}
          variant="outline"
        >
          <ToggleGroupItem value="overview">Overview</ToggleGroupItem>
          <ToggleGroupItem value="all">All Artifacts</ToggleGroupItem>
          <ToggleGroupItem value="documents">PRDs</ToggleGroupItem>
          <ToggleGroupItem value="issues">Issues</ToggleGroupItem>
          <ToggleGroupItem value="plans">Plans</ToggleGroupItem>
          <ToggleGroupItem value="branches">Branches</ToggleGroupItem>
        </ToggleGroup>
        {showArtifactControls && (
          <div className="flex flex-wrap items-center gap-2">
            {showFilterPopover && filterPopover}
            {tableViewMenu}
            {layoutToggle}
          </div>
        )}
      </div>
      {showArtifactControls && hasActiveFilters && activeFiltersBar}
    </div>
  );
}

/**
 * Flag off keeps main's intrinsic-width list (#8980); the board and the
 * phone-width grid need the region to shrink (ISS-12631).
 */
function artifactsContainmentClass(
  layout: string,
  responsiveNarrowGridview: boolean
): string {
  return layout === "board" || responsiveNarrowGridview
    ? "mt-0 min-w-0"
    : "mt-0 min-w-fit";
}

const ORIGIN = "http://localhost";
