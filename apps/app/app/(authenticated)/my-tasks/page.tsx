"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { IssueStatus } from "@repo/api/src/types/issue";
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
import { LayoutGridIcon, ListFilter, ListIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import {
  issuePriorityLabels,
  issueStatusLabels,
} from "@/components/status-badge";
import { useIssues } from "@/hooks/queries/use-issues";
import { useProjects } from "@/hooks/queries/use-projects";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { OnboardingChecklist } from "../components/onboarding-checklist";
import { MyTasksEmptyState } from "./components/my-tasks-empty-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import { MyTasksList } from "./components/my-tasks-list";
import type { MyTasksIssueFilters } from "./types";
import {
  applyClientFilters,
  buildIssueListParams,
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
  const [filters, setFilters] = useState<MyTasksIssueFilters>(EMPTY_FILTERS);
  const { data: projects = [] } = useProjects();

  const assigneeId = currentUser?.id ?? null;
  const listParams = useMemo(
    () => buildIssueListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawIssues = [], isLoading: isIssuesLoading } = useIssues(
    listParams,
    {
      enabled: !!assigneeId && !isUserLoading,
    }
  );

  const issues = useMemo(
    () => applyClientFilters(rawIssues, filters),
    [rawIssues, filters]
  );

  const hasTasks = issues.length > 0;

  const isListView = view === "list";

  const filtersActive = hasActiveFilters(filters);

  const toggleProject = useCallback((id: string) => {
    setFilters((prev) => ({
      ...prev,
      projectIds: toggleArrayValue(prev.projectIds, id),
    }));
  }, []);

  const toggleStatus = useCallback((status: IssueStatus) => {
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
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="shrink-0 px-4 py-4">
          <OnboardingChecklist />
        </div>
        {(hasTasks || filtersActive) && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="font-semibold text-lg tracking-tight">
              Pending Work
            </h2>
            <div className="flex items-center gap-2">
              <Button
                aria-label={
                  isListView ? "Switch to card view" : "Switch to list view"
                }
                className="border border-input bg-transparent"
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
                    className={`border border-input bg-transparent ${filtersActive ? "border-primary/50" : ""}`}
                    variant="ghost"
                  >
                    <ListFilter className="size-4" />
                    <span className="hidden sm:inline">Filter</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Project</DropdownMenuLabel>
                    {projects.map((p) => (
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
                    {Object.entries(issueStatusLabels).map(([value, label]) => (
                      <DropdownMenuCheckboxItem
                        checked={filters.statuses.includes(
                          value as IssueStatus
                        )}
                        key={value}
                        onCheckedChange={() =>
                          toggleStatus(value as IssueStatus)
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
                    {Object.entries(issuePriorityLabels).map(
                      ([value, label]) => (
                        <DropdownMenuCheckboxItem
                          checked={filters.priorities.includes(
                            value as Priority
                          )}
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
        )}
        <div className="p-4">
          {!(hasTasks || isUserLoading || isIssuesLoading) && (
            <MyTasksEmptyState projects={projects} />
          )}
          {hasTasks && view === "list" && (
            <MyTasksList
              assigneeId={assigneeId}
              issueFilters={filters}
              isUserLoading={isUserLoading}
            />
          )}
          {hasTasks && view !== "list" && (
            <MyTasksKanban
              assigneeId={assigneeId}
              issueFilters={filters}
              isUserLoading={isUserLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
