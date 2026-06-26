"use client";

import type { Priority } from "@repo/api/src/types/common";
import { DocumentTableToolbar } from "@repo/app/documents/components/table/document-table-toolbar";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import { useDeleteRowItem } from "@repo/app/documents/hooks/use-delete-row-item";
import {
  useDocuments,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import { useGroupBy } from "@repo/app/documents/hooks/use-group-by";
import { useProjectFilters } from "@repo/app/documents/hooks/use-project-filters";
import { matchesFilter } from "@repo/app/documents/lib/document-filter";
import { isNavigableDocument } from "@repo/app/documents/lib/document-navigation";
import { useLoopSummaries } from "@repo/app/loops/hooks/use-loops";
import { useMergedProjectTrees } from "@repo/app/projects/hooks/use-merged-project-trees";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import {
  DocumentColumn,
  MY_TASKS_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { useScrollRestore } from "@repo/app/shared/hooks/use-scroll-restore";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { useOrgUsersAsPopoverUsers } from "@repo/app/users/hooks/use-org-users-as-popover-users";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback, useMemo, useState } from "react";
import { DocumentsView } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/documents-view";
import { Header } from "@/app/(authenticated)/components/header";
import { AgentOnboardingCard } from "../../components/agent-onboarding-card";
import { OnboardingChecklist } from "../../components/onboarding-checklist";
import { MyTasksEmptyState } from "./components/my-tasks-empty-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import { buildArtifactListParams } from "./utils";

const VIEW_KEY = "my-tasks-view";
const COLUMN_VISIBILITY_KEY = "table:columns:my-tasks";
const STORAGE_KEY = "my-tasks-artifacts";

const COLUMN_DEFAULTS = {
  [DocumentColumn.Type]: true,
};

export default function MyTasksPage() {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filterText, setFilterText, clearSearch] =
    useViewStatePersistence<string>("table:search:my-tasks", "");
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  const { clearPosition: clearScroll } = useScrollRestore(
    "table:scroll:my-tasks",
    scrollContainer
  );
  const [, , clearSort] = useViewStatePersistence<null>(
    "table:sort:my-tasks",
    null
  );
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const { data: projects = [], isLoading: isProjectsLoading } = useProjects();
  const assigneeId = currentUser?.id ?? null;
  const listParams = useMemo(
    () => buildArtifactListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawArtifacts = [], isLoading: isArtifactsLoading } =
    useDocuments(listParams, {
      enabled: !!assigneeId && !isUserLoading,
    });

  const isListView = view === "list";

  // ---- Column visibility ----

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
    defaults: COLUMN_DEFAULTS,
  });
  const visibleColumns = useMemo(
    () => MY_TASKS_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { groupBy, setGroupBy } = useGroupBy("table:groupByStatus:my-tasks");

  // ---- Edit handlers ----

  const updateArtifactMutation = useUpdateDocument();
  // Type-scoped delete dispatch (branch vs document endpoint) lives in the
  // shared hook (PLN-874 Task 3.5).
  const handleDelete = useDeleteRowItem();

  const orgUsers = useOrgUsersAsPopoverUsers();

  const artifactIds = useMemo(
    () => rawArtifacts.map((artifact) => artifact.id),
    [rawArtifacts]
  );
  const { data: loopSummaries } = useLoopSummaries(artifactIds);

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      loopVariant: "my-tasks",
      loopSummaries,
      onUpdateAssignee: (id, assigneeId) =>
        updateArtifactMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateArtifactMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateArtifactMutation.mutate({ id, status }),
    }),
    [orgUsers, loopSummaries, updateArtifactMutation.mutate]
  );

  // ---- Items & filters ----

  const { data: favoriteArtifacts } = useFavoriteArtifacts();
  const favoriteArtifactIds = useMemo(
    () => favoriteArtifacts?.map((f) => f.id) ?? [],
    [favoriteArtifacts]
  );

  const filtersReturn = useProjectFilters({
    documents: rawArtifacts,
    filterCategory,
    currentUserId: currentUser?.id,
    persistenceKey: "table:filters:my-tasks",
    favoriteArtifactIds,
  });

  const filterCurrentUser = useFilterCurrentUser(currentUser);

  // ---- Merged project trees for cross-project nesting ----

  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const doc of rawArtifacts) {
      if (doc.projectId) {
        ids.add(doc.projectId);
      }
    }
    return Array.from(ids);
  }, [rawArtifacts]);

  const { data: mergedTreeData, isLoading: isTreeDataLoading } =
    useMergedProjectTrees(projectIds, { enabled: isListView });

  // ---- Kanban data ----

  const kanbanArtifacts = useMemo(() => {
    const docItems = filtersReturn.rootItems.filter(isDocumentRowItem);
    let filtered = filterText.trim()
      ? docItems.filter((item) => matchesFilter(item.data, filterText))
      : docItems;
    if (filtersReturn.isAnyFilterActive) {
      filtered = filtersReturn.applyFilters(filtered).filter(isDocumentRowItem);
    }
    return filtered
      .map((item) => item.data)
      .filter((doc) => isNavigableDocument(doc));
  }, [
    filterText,
    filtersReturn.applyFilters,
    filtersReturn.isAnyFilterActive,
    filtersReturn.rootItems,
  ]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Onboarding checklist — renders null when dismissed, no space taken */}
        <OnboardingChecklist />
        <AgentOnboardingCard />

        {/* Title bar */}
        <div className={isListView ? "border-b" : ""}>
          <DocumentTableToolbar
            activeFiltersBarProps={{
              currentUser: filterCurrentUser,
              filtersReturn,
              hideAssignee: true,
              teamMembers: [],
              teamMembersError: null,
              teamMembersLoading: false,
            }}
            filterPopoverProps={
              filterCategory === "branches"
                ? undefined
                : {
                    currentUser: filterCurrentUser,
                    filtersReturn,
                    hideAssignee: true,
                    teamMembers: [],
                    teamMembersError: null,
                    teamMembersLoading: false,
                  }
            }
            filterText={filterText}
            leadingContent={
              isListView && (
                <ToggleGroup
                  onValueChange={(value) => {
                    if (value) {
                      setFilterCategory(value as FilterCategory);
                    }
                  }}
                  size="sm"
                  type="single"
                  value={filterCategory}
                  variant="outline"
                >
                  <ToggleGroupItem value="all">All</ToggleGroupItem>
                  <ToggleGroupItem value="documents">PRDs</ToggleGroupItem>
                  <ToggleGroupItem value="features">Features</ToggleGroupItem>
                  <ToggleGroupItem value="plans">Plans</ToggleGroupItem>
                  <ToggleGroupItem value="branches">Branches</ToggleGroupItem>
                </ToggleGroup>
              )
            }
            onFilterTextChange={setFilterText}
            tableViewMenuProps={{
              columns: isListView ? MY_TASKS_DEFAULT_COLUMNS : undefined,
              groupBy: isListView ? groupBy : undefined,
              onChangeGroupBy: isListView ? setGroupBy : undefined,
              onChangeView: setView,
              onResetView: handleResetView,
              onToggle: isListView ? toggleColumn : undefined,
              view,
              visibility: isListView ? visibility : undefined,
            }}
          />
        </div>

        {/* Content — card view */}
        {!isListView && (
          <div className="min-h-0 flex-1 overflow-hidden">
            <MyTasksKanban
              artifacts={kanbanArtifacts}
              assigneeId={assigneeId}
              isLoading={isArtifactsLoading}
              isUserLoading={isUserLoading}
            />
          </div>
        )}

        {/* Content — list view, no tasks yet */}
        {isListView &&
          rawArtifacts.length === 0 &&
          !isArtifactsLoading &&
          !isUserLoading &&
          !isProjectsLoading && (
            <div className="p-4">
              <MyTasksEmptyState projects={projects} />
            </div>
          )}

        {/* Content — list view, table */}
        {isListView &&
          (rawArtifacts.length > 0 || isArtifactsLoading || isUserLoading) && (
            <main className="flex-1 overflow-auto" ref={setScrollContainer}>
              <DocumentsView
                applyProjectFilters={
                  filtersReturn.isAnyFilterActive
                    ? filtersReturn.applyFilters
                    : undefined
                }
                branchAssigneeFilter={assigneeId}
                documents={rawArtifacts}
                editHandlers={editHandlers}
                filterCategory={filterCategory}
                filterText={filterText}
                groupBy={groupBy}
                isFilterActive={filtersReturn.isAnyFilterActive}
                isTreeDataLoading={isTreeDataLoading}
                onClearFilters={filtersReturn.clearAllFilters}
                onDelete={handleDelete}
                sortPersistenceKey="table:sort:my-tasks"
                storageKey={STORAGE_KEY}
                treeData={mergedTreeData}
                visibleColumns={visibleColumns}
              />
            </main>
          )}
      </div>
    </div>
  );
}
