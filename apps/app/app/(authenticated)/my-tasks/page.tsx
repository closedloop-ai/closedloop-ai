"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  FeatureStatus,
  FeatureWithWorkstream,
} from "@repo/api/src/types/feature";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { BoxIcon, LayoutGridIcon, ListIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { ActiveFiltersBar } from "@/components/artifact-table/active-filters-bar";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { DeleteRowActions } from "@/components/artifact-table/delete-row-actions";
import { FilterPopover } from "@/components/artifact-table/filter-popover";
import { FlatArtifactTable } from "@/components/artifact-table/flat-artifact-table";
import { TableViewMenu } from "@/components/artifact-table/table-view-menu";
import {
  useDeleteFeature,
  useFeatures,
  useUpdateFeature,
} from "@/hooks/queries/use-features";
import { useProjects } from "@/hooks/queries/use-projects";
import { useCurrentUser } from "@/hooks/queries/use-users";
import {
  MY_TASKS_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useGroupByStatus } from "@/hooks/use-group-by-status";
import { useItemsParentTitles } from "@/hooks/use-items-parent-titles";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { useOrgUsersAsPopoverUsers } from "@/hooks/use-org-users-as-popover-users";
import { useTableFilters } from "@/hooks/use-table-filters";
import { OnboardingChecklist } from "../components/onboarding-checklist";
import { MyTasksEmptyState } from "./components/my-tasks-empty-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import { buildFeatureListParams } from "./utils";

const VIEW_KEY = "my-tasks-view";
const COLUMN_VISIBILITY_KEY = "table:columns:my-tasks";

export default function MyTasksPage() {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filterText, setFilterText] = useState("");
  const { data: projects = [] } = useProjects();
  const assigneeId = currentUser?.id ?? null;
  const listParams = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawFeatures = [], isLoading: isFeaturesLoading } = useFeatures(
    listParams,
    { enabled: !!assigneeId && !isUserLoading }
  );

  const isListView = view === "list";

  // ---- Column visibility ----

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
  });
  const visibleColumns = useMemo(
    () => MY_TASKS_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  const { groupByStatus, toggleGroupByStatus } = useGroupByStatus(
    "table:groupByStatus:my-tasks"
  );

  // ---- Edit handlers ----

  const updateFeatureMutation = useUpdateFeature();
  const deleteFeatureMutation = useDeleteFeature();

  const orgUsers = useOrgUsersAsPopoverUsers();

  const editHandlers: RowEditHandlers = useMemo(
    () => ({
      teamMembers: orgUsers,
      onUpdateAssignee: (id, assigneeId) =>
        updateFeatureMutation.mutate({ id, assigneeId }),
      onUpdatePriority: (id, priority: Priority) =>
        updateFeatureMutation.mutate({ id, priority }),
      onUpdateStatus: (id, status) =>
        updateFeatureMutation.mutate({ id, status: status as FeatureStatus }),
    }),
    [orgUsers, updateFeatureMutation.mutate]
  );

  const handleDelete = async (item: ArtifactRowItem): Promise<boolean> => {
    const result = await deleteFeatureMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  // ---- Items & filters ----

  const allItems: ArtifactRowItem[] = useMemo(
    () => rawFeatures.map((f) => ({ kind: "feature" as const, data: f })),
    [rawFeatures]
  );

  const filtersReturn = useTableFilters({
    items: allItems,
    currentUserId: currentUser?.id,
  });

  const { isAnyFilterActive, applyFilters } = filtersReturn;

  const displayItems = useMemo(() => {
    let filtered = rawFeatures;
    if (filterText.trim()) {
      const q = filterText.toLowerCase().trim();
      filtered = rawFeatures.filter(
        (f) =>
          f.title.toLowerCase().includes(q) || f.slug.toLowerCase().includes(q)
      );
    }
    let items: ArtifactRowItem[] = filtered.map((f) => ({
      kind: "feature" as const,
      data: f,
    }));
    if (isAnyFilterActive) {
      items = applyFilters(items);
    }
    return items;
  }, [rawFeatures, filterText, isAnyFilterActive, applyFilters]);

  const parentTitleMap = useItemsParentTitles(allItems);

  const kanbanFeatures = useMemo(
    () =>
      displayItems
        .filter((item) => item.kind === "feature")
        .map((item) => item.data as FeatureWithWorkstream),
    [displayItems]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Onboarding checklist — renders null when dismissed, no space taken */}
        <OnboardingChecklist />

        {/* Title bar */}
        <div className={isListView ? "border-b" : ""}>
          <div className="flex min-w-fit shrink-0 items-center justify-between gap-3 px-4 py-3">
            <h1 className="font-semibold text-xl">My Tasks</h1>
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
              <FilterPopover
                filtersReturn={filtersReturn}
                hideAssignee
                teamMembers={[]}
                teamMembersError={null}
                teamMembersLoading={false}
              />
              {isListView && (
                <TableViewMenu
                  columns={MY_TASKS_DEFAULT_COLUMNS}
                  groupByStatus={groupByStatus}
                  onToggle={toggleColumn}
                  onToggleGroupByStatus={toggleGroupByStatus}
                  visibility={visibility}
                />
              )}
              <Button
                aria-label={
                  isListView ? "Switch to card view" : "Switch to list view"
                }
                className="h-8 border border-input-border bg-transparent shadow-none"
                onClick={() => setView(isListView ? "card" : "list")}
                size="sm"
                variant="ghost"
              >
                {isListView ? (
                  <>
                    <LayoutGridIcon />
                    <span className="hidden sm:inline">Card</span>
                  </>
                ) : (
                  <>
                    <ListIcon />
                    <span className="hidden sm:inline">List</span>
                  </>
                )}
              </Button>
            </div>
          </div>
          {filtersReturn.isAnyFilterActive && (
            <ActiveFiltersBar
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
              assigneeId={assigneeId}
              features={kanbanFeatures}
              isLoading={isFeaturesLoading}
              isUserLoading={isUserLoading}
            />
          </div>
        )}

        {/* Content — list view, no tasks yet */}
        {isListView &&
          rawFeatures.length === 0 &&
          !isFeaturesLoading &&
          !isUserLoading && (
            <div className="p-4">
              <MyTasksEmptyState projects={projects} />
            </div>
          )}

        {/* Content — list view, table */}
        {isListView &&
          (rawFeatures.length > 0 || isFeaturesLoading || isUserLoading) && (
            <div className="flex-1 overflow-auto">
              <FlatArtifactTable
                editHandlers={editHandlers}
                emptyDescription="Try adjusting your filters."
                emptyIcon={BoxIcon}
                emptyTitle="No matching tasks"
                groupByStatus={groupByStatus}
                items={displayItems}
                moreMenuContent={(_item, onRequestDelete) => (
                  <DeleteRowActions onDelete={onRequestDelete} />
                )}
                onDelete={handleDelete}
                parentTitleMap={parentTitleMap}
                statusExpansionKey="table:expand:my-tasks-status"
                visibleColumns={visibleColumns}
              />
            </div>
          )}
      </div>
    </div>
  );
}
