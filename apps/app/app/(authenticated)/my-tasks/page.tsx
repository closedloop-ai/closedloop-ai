"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { FeatureStatus } from "@repo/api/src/types/feature";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import {
  BoxIcon,
  LayoutGridIcon,
  ListFilter,
  ListIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { ColumnVisibilityPanel } from "@/components/artifact-table/column-visibility-panel";
import { FlatArtifactTable } from "@/components/artifact-table/flat-artifact-table";
import {
  featurePriorityLabels,
  featureStatusLabels,
} from "@/components/status-badge";
import {
  useDeleteFeature,
  useFeatures,
  useUpdateFeature,
} from "@/hooks/queries/use-features";
import { useProjects } from "@/hooks/queries/use-projects";
import {
  useCurrentUser,
  useOrganizationUsers,
} from "@/hooks/queries/use-users";
import {
  MY_TASKS_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import { OnboardingChecklist } from "../components/onboarding-checklist";
import { FeatureRowActions } from "../teams/[teamId]/features/components/feature-row-actions";
import { MyTasksEmptyState } from "./components/my-tasks-empty-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import type { MyTasksFeatureFilters } from "./types";
import {
  applyClientFilters,
  buildFeatureListParams,
  EMPTY_FILTERS,
  hasActiveFilters,
} from "./utils";

const VIEW_KEY = "my-tasks-view";

function toggleArrayValue<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

const preventClose = (e: Event) => {
  e.preventDefault();
};

export default function MyTasksPage() {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filters, setFilters] = useState<MyTasksFeatureFilters>(EMPTY_FILTERS);
  const { data: projects = [] } = useProjects();
  const { data: usersResult } = useOrganizationUsers();

  const assigneeId = currentUser?.id ?? null;
  const listParams = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawFeatures = [], isLoading: isFeaturesLoading } = useFeatures(
    listParams,
    { enabled: !!assigneeId && !isUserLoading }
  );

  const features = useMemo(
    () => applyClientFilters(rawFeatures, filters),
    [rawFeatures, filters]
  );

  // Derive unique projects from the user's assigned features (not the full org list).
  const filterProjects = useMemo(() => {
    const seen = new Set<string>();
    const result: { id: string; name: string }[] = [];
    for (const f of rawFeatures) {
      if (f.project && !seen.has(f.project.id)) {
        seen.add(f.project.id);
        result.push({ id: f.project.id, name: f.project.name });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [rawFeatures]);

  const isListView = view === "list";
  const filtersActive = hasActiveFilters(filters);

  // ---- Column visibility ----

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility();
  const visibleColumns = useMemo(
    () => MY_TASKS_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  // ---- Edit handlers ----

  const updateFeatureMutation = useUpdateFeature();
  const deleteFeatureMutation = useDeleteFeature();

  const orgUsers: PopoverUser[] = useMemo(() => {
    if (!usersResult) {
      return [];
    }
    return usersResult.map((user) => ({
      id: user.id,
      name: getUserDisplayName(user),
      email: user.email,
      avatarUrl: user.avatarUrl ?? undefined,
      initials: getUserInitials(user.firstName, user.lastName),
    }));
  }, [usersResult]);

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
    [orgUsers, updateFeatureMutation]
  );

  const handleDelete = async (item: ArtifactRowItem): Promise<boolean> => {
    const result = await deleteFeatureMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  // ---- Items ----

  const items: ArtifactRowItem[] = useMemo(
    () => features.map((f) => ({ kind: "feature" as const, data: f })),
    [features]
  );

  // ---- Filter toggles ----

  const toggleProject = useCallback((id: string) => {
    setFilters((prev) => ({
      ...prev,
      projectIds: toggleArrayValue(prev.projectIds, id),
    }));
  }, []);

  const toggleStatus = useCallback((status: FeatureStatus) => {
    setFilters((prev) => ({
      ...prev,
      statuses: toggleArrayValue(prev.statuses, status),
    }));
  }, []);

  const togglePriority = useCallback((priority: Priority) => {
    setFilters((prev) => ({
      ...prev,
      priorities: toggleArrayValue(prev.priorities, priority),
    }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Onboarding checklist — renders null when dismissed, no space taken */}
        <OnboardingChecklist />

        {/* Title bar */}
        <div className="flex min-w-fit shrink-0 items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">My Tasks</h1>
          <div className="flex items-center gap-2">
            {isListView && (
              <ColumnVisibilityPanel
                columns={MY_TASKS_DEFAULT_COLUMNS}
                onToggle={toggleColumn}
                visibility={visibility}
              />
            )}
            <Button
              aria-label={
                isListView ? "Switch to card view" : "Switch to list view"
              }
              className="border border-input-border bg-transparent"
              onClick={() => setView(isListView ? "card" : "list")}
              variant="ghost"
            >
              {isListView ? (
                <>
                  <LayoutGridIcon className="size-4" />
                  <span className="hidden sm:inline">Card</span>
                </>
              ) : (
                <>
                  <ListIcon className="size-4" />
                  <span className="hidden sm:inline">List</span>
                </>
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Filter tasks"
                  className={`border border-input-border bg-transparent ${filtersActive ? "border-primary/50" : ""}`}
                  variant="ghost"
                >
                  <ListFilter className="size-4" />
                  <span className="hidden sm:inline">Filter</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  {filterProjects.map((p) => (
                    <DropdownMenuCheckboxItem
                      checked={filters.projectIds.includes(p.id)}
                      key={p.id}
                      onCheckedChange={() => toggleProject(p.id)}
                      onSelect={preventClose}
                    >
                      <span className="truncate">{p.name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Status</DropdownMenuLabel>
                  {Object.entries(featureStatusLabels).map(([value, label]) => (
                    <DropdownMenuCheckboxItem
                      checked={filters.statuses.includes(
                        value as FeatureStatus
                      )}
                      key={value}
                      onCheckedChange={() =>
                        toggleStatus(value as FeatureStatus)
                      }
                      onSelect={preventClose}
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Priority</DropdownMenuLabel>
                  {Object.entries(featurePriorityLabels).map(
                    ([value, label]) => (
                      <DropdownMenuCheckboxItem
                        checked={filters.priorities.includes(value as Priority)}
                        key={value}
                        onCheckedChange={() =>
                          togglePriority(value as Priority)
                        }
                        onSelect={preventClose}
                      >
                        {label}
                      </DropdownMenuCheckboxItem>
                    )
                  )}
                </DropdownMenuGroup>
                {filtersActive && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setFilters(EMPTY_FILTERS)}
                    >
                      <XIcon className="size-4" />
                      Clear filters
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Content — card view */}
        {!isListView && (
          <div className="flex-1 overflow-auto p-4">
            <MyTasksKanban
              assigneeId={assigneeId}
              featureFilters={filters}
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
                items={items}
                moreMenuContent={(_item, onRequestDelete) => (
                  <FeatureRowActions onDelete={onRequestDelete} />
                )}
                onDelete={handleDelete}
                visibleColumns={visibleColumns}
              />
            </div>
          )}
      </div>
    </div>
  );
}
