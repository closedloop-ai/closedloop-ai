"use client";

import type { Priority } from "@repo/api/src/types/common";
import { Input } from "@repo/design-system/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  DocumentsView,
  type FilterCategory,
} from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/components/documents-view";
import { useProjectFilters } from "@/app/(authenticated)/teams/[teamId]/projects/[projectId]/use-project-filters";
import { ActiveFiltersBar } from "@/components/document-table/active-filters-bar";
import type {
  DocumentRowItem,
  RowEditHandlers,
} from "@/components/document-table/document-row";
import { FilterPopover } from "@/components/document-table/filter-popover";
import { TableViewMenu } from "@/components/document-table/table-view-menu";
import {
  useDeleteDocument,
  useDocuments,
  useUpdateDocument,
} from "@/hooks/queries/use-documents";
import { useLoopSummaries } from "@/hooks/queries/use-loops";
import { useProjects } from "@/hooks/queries/use-projects";
import { useCurrentUser } from "@/hooks/queries/use-users";
import {
  DocumentColumn,
  MY_TASKS_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useFilterCurrentUser } from "@/hooks/use-filter-current-user";
import { useGroupBy } from "@/hooks/use-group-by";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { useMergedProjectTrees } from "@/hooks/use-merged-project-trees";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";
import { matchesFilter } from "@/lib/document-filter";
import { isNavigableDocument } from "@/lib/document-navigation";
import { OnboardingChecklist } from "../components/onboarding-checklist";
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
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filterText, setFilterText] = useState("");
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const { data: projects = [] } = useProjects();
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

  const { visibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
    defaults: COLUMN_DEFAULTS,
  });
  const visibleColumns = useMemo(
    () => MY_TASKS_DEFAULT_COLUMNS.filter((c) => visibility[c] !== false),
    [visibility]
  );

  const { groupBy, setGroupBy } = useGroupBy("table:groupByStatus:my-tasks");

  // ---- Edit handlers ----

  const updateArtifactMutation = useUpdateDocument();
  const deleteArtifactMutation = useDeleteDocument();

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

  const handleDelete = async (item: DocumentRowItem): Promise<boolean> => {
    const result = await deleteArtifactMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  // ---- Items & filters ----

  const filtersReturn = useProjectFilters({
    documents: rawArtifacts,
    filterCategory,
    currentUserId: currentUser?.id,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Onboarding checklist — renders null when dismissed, no space taken */}
        <OnboardingChecklist />

        {/* Title bar */}
        <div className={isListView ? "border-b" : ""}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <h1 className="font-semibold text-xl">My Tasks</h1>
              {isListView && (
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
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-[200px] max-w-[350px]">
                <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                  <SearchIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <Input
                  aria-label="Filter items"
                  className="h-8 pl-9 shadow-none"
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter items..."
                  value={filterText}
                />
              </div>
              {filterCategory !== "branches" && (
                <FilterPopover
                  currentUser={filterCurrentUser}
                  filtersReturn={filtersReturn}
                  hideAssignee
                  teamMembers={[]}
                  teamMembersError={null}
                  teamMembersLoading={false}
                />
              )}
              <TableViewMenu
                columns={isListView ? MY_TASKS_DEFAULT_COLUMNS : undefined}
                groupBy={isListView ? groupBy : undefined}
                onChangeGroupBy={isListView ? setGroupBy : undefined}
                onChangeView={setView}
                onToggle={isListView ? toggleColumn : undefined}
                view={view}
                visibility={isListView ? visibility : undefined}
              />
            </div>
          </div>
          {filtersReturn.isAnyFilterActive && (
            <ActiveFiltersBar
              currentUser={filterCurrentUser}
              filtersReturn={filtersReturn}
              hideAssignee
              teamMembers={[]}
              teamMembersError={null}
              teamMembersLoading={false}
            />
          )}
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
          !isUserLoading && (
            <div className="p-4">
              <MyTasksEmptyState projects={projects} />
            </div>
          )}

        {/* Content — list view, table */}
        {isListView &&
          (rawArtifacts.length > 0 || isArtifactsLoading || isUserLoading) && (
            <main className="flex-1 overflow-auto">
              <DocumentsView
                applyProjectFilters={
                  filtersReturn.isAnyFilterActive
                    ? filtersReturn.applyFilters
                    : undefined
                }
                documents={rawArtifacts}
                editHandlers={editHandlers}
                filterCategory={filterCategory}
                filterText={filterText}
                groupBy={groupBy}
                isFilterActive={filtersReturn.isAnyFilterActive}
                isTreeDataLoading={isTreeDataLoading}
                onClearFilters={filtersReturn.clearAllFilters}
                onDelete={handleDelete}
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

function isDocumentRowItem(
  item: DocumentRowItem
): item is Extract<DocumentRowItem, { kind: "feature" | "artifact" }> {
  return item.kind === "feature" || item.kind === "artifact";
}
