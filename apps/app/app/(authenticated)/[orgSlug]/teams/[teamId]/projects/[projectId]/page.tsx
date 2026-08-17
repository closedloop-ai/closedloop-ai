"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { TagEntityType } from "@repo/api/src/types/tag";
import { ActiveFiltersBar } from "@repo/app/documents/components/table/active-filters-bar";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { FilterPopover } from "@repo/app/documents/components/table/filter-popover";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { useGroupBy } from "@repo/app/documents/hooks/use-group-by";
import { useProjectFilters } from "@repo/app/documents/hooks/use-project-filters";
import { collectDocumentRowsFromTree } from "@repo/app/documents/lib/artifact-row-adapter";
import { treeHasRenderableArtifacts } from "@repo/app/documents/lib/table-view-pipeline";
import { EditableProjectDescription } from "@repo/app/projects/components/editable-project-description";
import { EditableProjectTitle } from "@repo/app/projects/components/editable-project-title";
import { useProjectTreeWithDetails } from "@repo/app/projects/hooks/use-project-tree";
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
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  type ColumnVisibility,
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import { useTeamMembers } from "@repo/app/teams/hooks/use-team-members";
import { useTeam } from "@repo/app/teams/hooks/use-teams";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
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
import {
  ArchiveIcon,
  BoxIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FileIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CreateDocumentModal } from "./components/create-document-modal";
import { CreateIssueModal } from "./components/create-issue-modal";
import { DocumentsView } from "./components/documents-view";
import { OverviewProperties } from "./components/overview-properties";
import { ProjectActiveSessionsStatus } from "./components/project-active-sessions-status";
import { ProjectRenameDialog } from "./components/project-rename-dialog";
import { useProjectArtifactsPagination } from "./hooks/use-project-artifacts-pagination";
import { useStackRankReset } from "./hooks/use-stack-rank-reset";
import {
  buildProjectTreeReadOptions,
  isProjectArtifactTreeLoading,
} from "./lib/project-artifacts-pagination";

const COLUMN_VISIBILITY_KEY = "table:columns:project-artifacts";
const COLUMN_ORDER_KEY = "table:column-order:project-artifacts";

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
  const params = useRouteParams();
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
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
  const [selectedDocumentType, setSelectedDocumentType] =
    useState<DocumentType>(DocumentType.Prd);
  const [filterText, setFilterText, clearSearch] =
    useViewStatePersistence<string>(
      `table:search:project-artifacts:${projectId}`,
      ""
    );
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  // Scope the scroll offset per category — each of All/PRDs/Features/Plans/
  // Branches renders a different list (Branches a different DOM entirely), so a
  // shared key would leak one tab's offset onto another.
  const { clearPosition: clearScroll } = useScrollRestore(
    isOverview
      ? null
      : `table:scroll:project-artifacts:${projectId}:${filterCategory}`,
    scrollContainer
  );
  const [, , clearSort] = useViewStatePersistence<null>(
    `table:sort:project-artifacts:${projectId}`,
    null
  );
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
  const {
    userVisibility,
    visibleColumns,
    toggleColumn,
    reorderColumns,
    resetColumnOrder,
  } = useColumnVisibility({
    overrides: columnOverrides,
    storageKey: COLUMN_VISIBILITY_KEY,
    orderStorageKey: COLUMN_ORDER_KEY,
  });
  const { groupBy, setGroupBy } = useGroupBy(
    "table:groupByStatus:project-artifacts"
  );
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

  // ISS-5307: pagination for the artifact tabs, default OFF. With the flag off
  // every line below resolves to the pre-ISS-5307 behavior — an unbounded tree
  // read, no slice, no footer.
  //
  // Gate, not a bare read (wongk): this flag SHAPES the tree request, and
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
  // Single project-scoped fetch for the whole documents table: the project
  // tree with artifact-level view details enriched onto every node (PLN-874).
  // The tree is passed down to DocumentsView so it skips its internal tree
  // fetch; the flat document row list is derived from the same tree.
  //
  // ISS-5307: with pagination on, that read is BOUNDED. The bound is on root
  // nodes and is deliberately much larger than a page — paging is a render
  // concern and the tabs filter, sort, and group this corpus client-side, so
  // fetching exactly one page would give every one of those controls a
  // different, smaller corpus to work over and make the tab counts disagree
  // with each other. What the bound buys is that the payload stops growing
  // with the project; what the page slice buys is that the DOM does too. When
  // the bound bites, the response says so and the footer repeats it, so the
  // count above it is never presented as the project's true size.
  const { data: projectTreeData, isLoading: isProjectTreeLoading } =
    useProjectTreeWithDetails(
      projectId,
      buildProjectTreeReadOptions(
        isArtifactPaginationEnabled,
        isArtifactPaginationFlagReady,
        projectId
      )
    );
  const loadingArtifacts = isProjectArtifactTreeLoading(
    isProjectTreeLoading,
    isArtifactPaginationFlagReady
  );
  const rowProject = useMemo(
    () =>
      project
        ? {
            id: project.id,
            name: project.name,
            ...(teamData && {
              teams: [{ id: teamData.id, name: teamData.name }],
            }),
          }
        : null,
    [project, teamData]
  );
  const allDocuments = useMemo(
    () => collectDocumentRowsFromTree(projectTreeData, rowProject),
    [projectTreeData, rowProject]
  );

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;

  const hasArtifactItems = hasRenderableRows(allDocuments, projectTreeData);
  // Filter controls only apply to the artifact table — hidden on Overview and
  // when the project has no artifacts to filter.
  const showArtifactControls = !isOverview && hasArtifactItems;

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

  const { data: favoriteArtifacts } = useFavoriteArtifacts();
  const favoriteArtifactIds = useMemo(
    () => favoriteArtifacts?.map((f) => f.id) ?? [],
    [favoriteArtifacts]
  );

  // Project filters
  const filtersReturn = useProjectFilters({
    documents: allDocuments,
    filterCategory,
    currentUserId: currentUser?.id,
    persistenceKey: `table:filters:project-artifacts:${projectId}`,
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
  const updateDocumentMutation = useUpdateDocument();
  // Type-scoped delete dispatch (branch vs document endpoint) lives in the
  // shared hook (PLN-874 Task 3.5).
  const handleDeleteArtifact = useDeleteRowItem();

  const handleUpdatePriority = (priority: Priority) => {
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

  // Inline cell edit handlers for artifact rows
  const artifactEditHandlers = useMemo(
    (): RowEditHandlers => ({
      teamMembers,
      surfaceVariant: "team",
      onUpdateAssignee: (itemId, assigneeId) => {
        updateDocumentMutation.mutate({ id: itemId, assigneeId });
      },
      onUpdatePriority: (itemId, priority) => {
        updateDocumentMutation.mutate({ id: itemId, priority });
      },
      onUpdateDueDate: (_itemId, _date) => {
        // Due date update not yet supported on artifacts/issues — placeholder
      },
      onUpdateStatus: (itemId, status) => {
        updateDocumentMutation.mutate({ id: itemId, status });
      },
    }),
    [teamMembers, updateDocumentMutation]
  );

  const handleResetView = useCallback(() => {
    filtersReturn.clearPersistedFilters();
    clearSearch();
    clearScroll();
    clearSort();
    resetColumnOrder();
    const params = new URLSearchParams(searchParams.toString());
    params.delete("sortBy");
    params.delete("sortDir");
    const qs = params.toString();
    navigation.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [
    filtersReturn.clearPersistedFilters,
    clearSearch,
    clearScroll,
    clearSort,
    resetColumnOrder,
    searchParams,
    navigation,
    pathname,
  ]);

  // Clear both facet filters and the (popover-hosted) text search, so the
  // empty-state "Clear filters" action can dismiss a text-only filter.
  const handleClearArtifactFilters = useCallback(() => {
    filtersReturn.clearAllFilters();
    clearSearch();
  }, [filtersReturn.clearAllFilters, clearSearch]);

  // PRD-421 / PLN-755 Phase D: handler is `undefined` when the flag is off so
  // the view menu hides the item; encapsulated in `useStackRankReset` to keep
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
    documents: allDocuments,
    filterCategory,
    filterText,
    groupBy,
    hasArtifactItems,
    isEnabled: isArtifactPaginationEnabled,
    isFilterActive: isAnyArtifactFilterActive,
    isOverview,
    projectId,
    scrollContainer,
    treeData: projectTreeData,
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
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
  const favoriteButtonLabel = getFavoriteButtonLabel(
    project.status,
    isFavorite
  );
  const favoriteMenuLabel = getFavoriteMenuLabel(project.status, isFavorite);

  return (
    <>
      <Header
        afterBreadcrumbs={
          <Button
            className="h-6 w-6"
            disabled={favoritesDisabled}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleFavorite.mutate({
                projectId: project.id,
                isFavorite,
              });
            }}
            size="icon"
            variant="ghost"
          >
            <StarIcon
              className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
            />
            <span className="sr-only">{favoriteButtonLabel}</span>
          </Button>
        }
        breadcrumbs={[
          { label: team.name, href: `/${orgSlug}/teams/${teamId}/projects` },
          { label: project.name },
        ]}
        moreMenu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="h-6 w-6" size="icon" variant="ghost">
                <MoreHorizontalIcon className="h-4 w-4" />
                <span className="sr-only">Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={favoritesDisabled}
                onClick={() =>
                  toggleFavorite.mutate({
                    projectId: project.id,
                    isFavorite,
                  })
                }
              >
                <StarIcon
                  className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
                />
                {favoriteMenuLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenameDialogOpen(true)}>
                <PencilIcon className="h-4 w-4" />
                Rename Project
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={statusPending}
                onClick={() =>
                  handleUpdateProjectStatus(
                    project.status === ProjectStatus.Archived
                      ? ProjectStatus.NotStarted
                      : ProjectStatus.Archived
                  )
                }
              >
                <ArchiveIcon className="h-4 w-4" />
                {project.status === ProjectStatus.Archived
                  ? "Unarchive Project"
                  : "Archive Project"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setDeleteDialogOpen(true)}
                variant="destructive"
              >
                <TrashIcon className="h-4 w-4 text-destructive" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              Actions
              <ChevronDownIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleCreateArtifact(DocumentType.Prd)}
            >
              <FileIcon className="h-4 w-4" />
              Create PRD
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFeatureOpen(true)}>
              <BoxIcon className="h-4 w-4" />
              Create Issue
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                handleCreateArtifact(DocumentType.ImplementationPlan)
              }
            >
              <FileCode2Icon className="h-4 w-4" />
              Create Implementation Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Header>
      <div className="flex flex-1 flex-col gap-0 overflow-hidden">
        <div className="border-b">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <ToggleGroup
              onValueChange={(value) => {
                if (value) {
                  setActiveTab(value);
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
              <div className="flex items-center gap-2">
                {filterCategory !== "branches" && (
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
                )}
                <TableViewMenu
                  groupBy={groupBy}
                  onChangeGroupBy={setGroupBy}
                  onResetToStackRank={handleResetToStackRank}
                  onResetView={handleResetView}
                  onToggle={toggleColumn}
                  visibility={userVisibility}
                />
              </div>
            )}
          </div>
          {showArtifactControls && filtersReturn.isAnyFilterActive && (
            <ActiveFiltersBar
              currentUser={filterCurrentUser}
              filtersReturn={filtersReturn}
              teamMembers={teamMembers}
              teamMembersError={teamMembersError}
              teamMembersLoading={teamMembersLoading}
            />
          )}
        </div>
        {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
        <div className="flex-1 overflow-auto" ref={setScrollContainer}>
          <ProjectActiveSessionsStatus
            orgSlug={orgSlug}
            projectId={projectId}
          />
          {isOverview ? (
            <ProjectOverviewPanel
              onUpdateAssignee={handleUpdateAssignee}
              onUpdatePriority={handleUpdatePriority}
              onUpdateTargetDate={handleUpdateTargetDate}
              project={project}
            />
          ) : (
            <div className="mt-0 min-w-fit">
              <DocumentsView
                applyProjectFilters={projectFilters}
                documents={artifactPagination.pagedDocuments}
                editHandlers={artifactEditHandlers}
                filterCategory={filterCategory}
                filterText={filterText}
                groupBy={groupBy}
                // ISS-5307: with paging on, `documents`/`treeData` above are
                // only this page's subset, so a filter matching nothing on the
                // current page would otherwise read as "this project has no
                // artifacts". Hand the view the unpaged truth so it keeps
                // offering "Clear filters" instead.
                hasUnpagedItems={artifactPagination.hasUnpagedItems}
                isFilterActive={isAnyArtifactFilterActive}
                isTreeDataLoading={loadingArtifacts}
                onClearFilters={handleClearArtifactFilters}
                onDelete={handleDeleteArtifact}
                onReorderColumns={reorderColumns}
                projectId={projectId}
                sortPersistenceKey={`table:sort:project-artifacts:${projectId}`}
                teamId={teamId}
                treeData={artifactPagination.pagedTreeData}
                visibleColumns={visibleColumns}
              />
              <ArtifactTruncationEmptyNote
                note={artifactPagination.emptyStateTruncationNote}
              />
            </div>
          )}
        </div>
        {artifactPagination.showFooter && (
          <TablePaginationFooter
            className="shrink-0"
            onPageChange={artifactPagination.onPageChange}
            onPageSizeChange={artifactPagination.onPageSizeChange}
            page={artifactPagination.page}
            pageSize={artifactPagination.pageSize}
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
        onConfirm={async () => {
          try {
            await deleteProjectMutation.mutateAsync(project.id);
            navigation.navigate(`/${orgSlug}/teams/${teamId}/projects`);
            return true;
          } catch {
            return false;
          }
        }}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title="Project"
      />
    </>
  );
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

function ProjectOverviewPanel({
  project,
  onUpdateAssignee,
  onUpdatePriority,
  onUpdateTargetDate,
}: {
  project: ProjectWithDetails;
  onUpdateAssignee: (assigneeId: string | null) => void;
  onUpdatePriority: (priority: Priority) => void;
  onUpdateTargetDate: (date: Date | null) => void;
}) {
  return (
    <div className="mx-auto mt-0 flex max-w-[950px] flex-col gap-10 p-6">
      <div className="flex flex-col gap-2">
        <EditableProjectTitle
          initialTitle={project.name}
          projectId={project.id}
        />
        <EditableProjectDescription
          initialDescription={project.description ?? ""}
          projectId={project.id}
        />
      </div>
      <FeatureFlagged flag="artifact-tags">
        <TagPicker
          appliedTags={project.tags ?? []}
          entityId={project.id}
          entityType={TagEntityType.Project}
        />
      </FeatureFlagged>
      <OverviewProperties
        onUpdateAssignee={onUpdateAssignee}
        onUpdatePriority={onUpdatePriority}
        onUpdateTargetDate={onUpdateTargetDate}
        project={project}
      />
    </div>
  );
}

function getFavoriteButtonLabel(status: ProjectStatus, isFavorite: boolean) {
  if (status === ProjectStatus.Archived) {
    return "Archived projects cannot be favorited";
  }
  if (isFavorite) {
    return "Remove from favorites";
  }
  return "Add to favorites";
}

function getFavoriteMenuLabel(status: ProjectStatus, isFavorite: boolean) {
  if (status === ProjectStatus.Archived) {
    return "Favorites unavailable while archived";
  }
  if (isFavorite) {
    return "Remove from Favorites";
  }
  return "Add to Favorites";
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

/**
 * The bounded-read caveat for a tab that ended up with no rows.
 *
 * The pagination footer normally carries this sentence, but the footer renders
 * only when the tab HAS rows — so on a truncated project filtered down to zero
 * matches the caveat disappeared at the exact moment it decides what the screen
 * means: "this project has no PRDs" versus "none in the prefix we loaded".
 *
 * `role="status"`: a filter change swaps this in with no route change, so
 * without a live region a screen-reader user gets the empty table and none of
 * the reason for it.
 */
function ArtifactTruncationEmptyNote({ note }: { note: string | null }) {
  if (!note) {
    return null;
  }
  return (
    <p className="px-4 pb-3 text-muted-foreground text-xs" role="status">
      {note}
    </p>
  );
}
