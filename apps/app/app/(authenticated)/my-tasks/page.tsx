"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { IssueStatus } from "@repo/api/src/types/issue";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { LayoutGridIcon, ListFilter, ListIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
import { buildIssueListParams } from "./utils";

const VIEW_KEY = "my-tasks-view";

const FILTER_ALL = "all";

export default function MyTasksPage() {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );
  const [filters, setFilters] = useState<MyTasksIssueFilters>({});
  const { data: projects = [] } = useProjects();

  const assigneeId = currentUser?.id ?? null;
  const listParams = useMemo(
    () => buildIssueListParams(assigneeId, filters),
    [assigneeId, filters]
  );
  const { data: issues = [] } = useIssues(listParams, {
    enabled: !!assigneeId && !isUserLoading,
  });

  const hasTasks = issues.length > 0;

  const isListView = view === "list";

  const hasActiveFilters =
    filters.projectId != null ||
    filters.status != null ||
    filters.priority != null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="shrink-0 px-4 py-4">
          <OnboardingChecklist />
        </div>
        {hasTasks && (
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
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    aria-label="Filter tasks"
                    className={`border border-input bg-transparent ${hasActiveFilters ? "border-primary/50" : ""}`}
                    variant="ghost"
                  >
                    <ListFilter className="size-4" />
                    <span className="hidden sm:inline">Filter</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56">
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label
                        className="font-medium text-muted-foreground text-xs"
                        htmlFor="my-tasks-filter-project"
                      >
                        Project
                      </Label>
                      <Select
                        onValueChange={(v) =>
                          setFilters((prev) => ({
                            ...prev,
                            projectId: v === FILTER_ALL ? undefined : v,
                          }))
                        }
                        value={filters.projectId ?? FILTER_ALL}
                      >
                        <SelectTrigger
                          className="w-full"
                          id="my-tasks-filter-project"
                        >
                          <SelectValue placeholder="All projects" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={FILTER_ALL}>
                            All projects
                          </SelectItem>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        className="font-medium text-muted-foreground text-xs"
                        htmlFor="my-tasks-filter-status"
                      >
                        Status
                      </Label>
                      <Select
                        onValueChange={(v) =>
                          setFilters((prev) => ({
                            ...prev,
                            status:
                              v === FILTER_ALL ? undefined : (v as IssueStatus),
                          }))
                        }
                        value={filters.status ?? FILTER_ALL}
                      >
                        <SelectTrigger
                          className="w-full"
                          id="my-tasks-filter-status"
                        >
                          <SelectValue placeholder="All statuses" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={FILTER_ALL}>
                            All statuses
                          </SelectItem>
                          {Object.entries(issueStatusLabels).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        className="font-medium text-muted-foreground text-xs"
                        htmlFor="my-tasks-filter-priority"
                      >
                        Priority
                      </Label>
                      <Select
                        onValueChange={(v) =>
                          setFilters((prev) => ({
                            ...prev,
                            priority:
                              v === FILTER_ALL ? undefined : (v as Priority),
                          }))
                        }
                        value={filters.priority ?? FILTER_ALL}
                      >
                        <SelectTrigger
                          className="w-full"
                          id="my-tasks-filter-priority"
                        >
                          <SelectValue placeholder="All priorities" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={FILTER_ALL}>
                            All priorities
                          </SelectItem>
                          {Object.entries(issuePriorityLabels).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        )}
        <div className="p-4">
          {!hasTasks && <MyTasksEmptyState projects={projects} />}
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
