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
import {
  collectDocumentRowsFromTree,
  treeHasActiveGeneration,
} from "@repo/app/documents/lib/artifact-row-adapter";
import { treeHasRenderableArtifacts } from "@repo/app/documents/lib/table-view-pipeline";
import { useActiveLoops } from "@repo/app/loops/hooks/use-active-loops";
import {
  useLoopSummaries,
  useLoopsByProject,
} from "@repo/app/loops/hooks/use-loops";
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
import {
  type ColumnVisibility,
  DocumentColumn,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
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
import { ActiveLoopsStatus } from "./components/active-loops-status";
import { CreateDocumentModal } from "./components/create-document-modal";
import { CreateFeatureModal } from "./components/create-feature-modal";
import { DocumentsView } from "./components/documents-view";
import { OverviewProperties } from "./components/overview-properties";
import { ProjectRenameDialog } from "./components/project-rename-dialog";
import { useStackRankReset } from "./hooks/use-stack-rank-reset";

const COLUMN_VISIBILITY_KEY = "table:columns:project-artifacts";

// Single merged tab control: "Overview" plus the artifact filter categories.
// `overview` shows the project overview (no table); the rest map 1:1 to
// `FilterCategory` and drive the document table. Defaults to "all".
const PROJECT_TABS = [
  "overview",
  "all",
  "documents",
  "features",
  "plans",
  "branches",
] as const;

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
  const { userVisibility, visibleColumns, toggleColumn } = useColumnVisibility({
    overrides: columnOverrides,
    storageKey: COLUMN_VISIBILITY_KEY,
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

  // Single project-scoped fetch for the whole documents table: the project
  // tree with artifact-level view details enriched onto every node (PLN-874).
  // The tree is passed down to DocumentsView so it skips its internal tree
  // fetch; the flat document row list is derived from the same tree.
  const { data: projectTreeData, isLoading: loadingArtifacts } =
    useProjectTreeWithDetails(projectId, {
      refetchInterval: (query) =>
        treeHasActiveGeneration(query.state.data) ? 5000 : false,
    });
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

  const { data: loops = [] } = useLoopsByProject(projectId, {
    refetchInterval: 10_000,
  });
  const activeLoops = useActiveLoops(loops);

  // Derive an O(1) document-id → active-loop lookup once so the loop cells
  // (rendered once per row) avoid an O(activeLoops) scan per row. Keep the
  // first active loop per document id to match the cells' prior `.find`.
  const activeLoopsByDocumentId = useMemo(() => {
    const map = new Map<string, (typeof activeLoops)[number]>();
    for (const loop of activeLoops) {
      // A null documentId never matched a (string) row id under the prior
      // `.find`, so skipping it preserves the existing lookup semantics.
      if (loop.documentId && !map.has(loop.documentId)) {
        map.set(loop.documentId, loop);
      }
    }
    return map;
  }, [activeLoops]);

  const documentSummaryIds = useMemo(
    () => allDocuments.map((d) => d.id),
    [allDocuments]
  );
  const { data: loopSummaries } = useLoopSummaries(documentSummaryIds);

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
      activeLoops,
      activeLoopsByDocumentId,
      loopVariant: "team",
      loopSummaries,
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
    [
      teamMembers,
      activeLoops,
      activeLoopsByDocumentId,
      loopSummaries,
      updateDocumentMutation,
    ]
  );

  const handleResetView = useCallback(() => {
    filtersReturn.clearPersistedFilters();
    clearSearch();
    clearScroll();
    clearSort();
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

  // Project (facet) filters apply only when active; the text search is folded
  // into `isAnyArtifactFilterActive` so the table's empty state surfaces a
  // clear affordance for a text-only filter.
  const projectFilters = filtersReturn.isAnyFilterActive
    ? filtersReturn.applyFilters
    : undefined;
  const isAnyArtifactFilterActive = hasAnyArtifactFilter(
    filtersReturn.isAnyFilterActive,
    filterText
  );

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
              Create Feature
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
              <ToggleGroupItem value="features">Features</ToggleGroupItem>
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
        <main className="flex-1 overflow-auto" ref={setScrollContainer}>
          <ActiveLoopsStatus projectId={projectId} />
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
                documents={allDocuments}
                editHandlers={artifactEditHandlers}
                filterCategory={filterCategory}
                filterText={filterText}
                groupBy={groupBy}
                isFilterActive={isAnyArtifactFilterActive}
                isTreeDataLoading={loadingArtifacts}
                onClearFilters={handleClearArtifactFilters}
                onDelete={handleDeleteArtifact}
                projectId={projectId}
                sortPersistenceKey={`table:sort:project-artifacts:${projectId}`}
                teamId={teamId}
                treeData={projectTreeData ?? null}
                visibleColumns={visibleColumns}
              />
            </div>
          )}
        </main>
      </div>
      <CreateDocumentModal
        documentType={selectedDocumentType}
        onOpenChange={setCreateArtifactOpen}
        open={createArtifactOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <CreateFeatureModal
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
  return tab === "overview" ? "all" : tab;
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
