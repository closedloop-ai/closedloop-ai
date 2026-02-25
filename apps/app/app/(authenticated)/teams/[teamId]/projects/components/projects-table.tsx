"use client";

import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { HexagonProgress } from "@repo/design-system/components/ui/hexagon-progress";
import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  type User as PopoverUser,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import {
  FolderIcon,
  MoreHorizontalIcon,
  TrashIcon,
  UserIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { SortableColumnHeader } from "@/components/sortable-column-header";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { useSortParams } from "@/hooks/use-sort-params";
import {
  ensureDate,
  formatDateCompact,
  formatRelativeTime,
} from "@/lib/date-utils";
import type { SortConfig } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import { SortableProjectRow } from "./sortable-project-row";

type ProjectsTableProps = {
  projects: ProjectWithDetails[];
  teamId: string;
  onUpdateAssignee?: (projectId: string, assigneeId: string | null) => void;
  onUpdateTargetDate?: (projectId: string, date: Date | null) => void;
  onDelete?: (projectId: string) => Promise<boolean>;
};

const PROJECT_SORT_COLUMNS = [
  "name",
  "priority",
  "assignee",
  "targetDate",
  "status",
  "updatedAt",
] as const;

type ProjectSortColumn = (typeof PROJECT_SORT_COLUMNS)[number];

const PRIORITY_ORDER: Record<string, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const PROJECT_SORT_CONFIGS: Record<
  ProjectSortColumn,
  SortConfig<ProjectWithDetails>
> = {
  name: { key: "name", columnType: "string" },
  priority: {
    key: "priority",
    comparator: (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99),
  },
  assignee: {
    key: "assignee",
    comparator: (a, b) => {
      const aName = a.assignee ? getUserDisplayName(a.assignee) : "";
      const bName = b.assignee ? getUserDisplayName(b.assignee) : "";
      return aName.localeCompare(bName);
    },
  },
  targetDate: {
    key: "targetDate",
    columnType: "date",
  },
  status: { key: "completionPercentage", columnType: "number" },
  updatedAt: { key: "updatedAt", columnType: "date" },
};

export function ProjectsTable({
  projects,
  teamId,
  onUpdateAssignee,
  onUpdateTargetDate,
  onDelete,
}: ProjectsTableProps) {
  const router = useRouter();
  const { data: usersResult } = useOrganizationUsers();
  const { sortBy, sortDir, setSort } = useSortParams<ProjectSortColumn>({
    defaultColumn: "updatedAt",
    defaultDirection: "desc",
    validColumns: PROJECT_SORT_COLUMNS,
  });

  const sortedProjects = useMemo(
    () => sortTableData(projects, sortBy, PROJECT_SORT_CONFIGS, sortDir),
    [projects, sortBy, sortDir]
  );

  const deleteConfirmation = useDeleteConfirmation({
    onDelete: onDelete ?? (async () => false),
    getId: (project: ProjectWithDetails) => project.id,
  });

  // Transform organization users for the popover
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

  const handleRowClick = (project: ProjectWithDetails) => {
    router.push(`/teams/${teamId}/projects/${project.id}`);
  };

  const handleDateChange = (projectId: string, date: Date | null) => {
    if (onUpdateTargetDate) {
      onUpdateTargetDate(projectId, date);
    }
  };

  const handleAssigneeChange = (
    projectId: string,
    user: PopoverUser | null
  ) => {
    if (onUpdateAssignee) {
      onUpdateAssignee(projectId, user?.id ?? null);
    }
  };

  // Memoize project IDs to provide a stable reference for SortableContext
  const projectIds = useMemo(
    () => sortedProjects.map((p) => p.id),
    [sortedProjects]
  );

  if (projects.length === 0) {
    return (
      <EmptyState
        description="Create your first project to get started."
        icon={FolderIcon}
        title="No projects yet"
      />
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <SortableColumnHeader
              column="name"
              label="Project Name"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              column="priority"
              label="Priority"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              column="assignee"
              label="Assignee"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              column="targetDate"
              label="Target Date"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              column="status"
              label="Status"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              column="updatedAt"
              label="Updated"
              onSort={setSort}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <SortableContext
          id="projects-list"
          items={projectIds}
          strategy={verticalListSortingStrategy}
        >
          <TableBody>
            {sortedProjects.map((project) => (
              <SortableProjectRow
                className="cursor-pointer"
                key={project.id}
                onClick={() => handleRowClick(project)}
                project={project}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <FolderIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{project.name}</span>
                  </div>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <PriorityBadge priority={project.priority} />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <UserSelectPopover
                    onSelect={(user) => handleAssigneeChange(project.id, user)}
                    placeholder="Assign owner"
                    trigger={
                      project.assignee ? (
                        <button
                          className="-mx-1 flex items-center gap-2 rounded px-1 hover:bg-muted/50"
                          type="button"
                        >
                          <Avatar className="h-6 w-6">
                            {project.assignee.avatarUrl ? (
                              <AvatarImage
                                alt={getUserDisplayName(project.assignee)}
                                src={project.assignee.avatarUrl}
                              />
                            ) : null}
                            <AvatarFallback className="text-[10px]">
                              {getUserInitials(
                                project.assignee.firstName,
                                project.assignee.lastName
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm">
                            {getUserDisplayName(project.assignee)}
                          </span>
                        </button>
                      ) : (
                        <button
                          className="-mx-1 flex items-center gap-2 rounded px-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          type="button"
                        >
                          <UserIcon className="h-4 w-4" />
                          <span className="text-sm">Unassigned</span>
                        </button>
                      )
                    }
                    users={orgUsers}
                    value={
                      project.assignee
                        ? {
                            id: project.assignee.id,
                            name: getUserDisplayName(project.assignee),
                            avatarUrl: project.assignee.avatarUrl ?? undefined,
                            initials: getUserInitials(
                              project.assignee.firstName,
                              project.assignee.lastName
                            ),
                          }
                        : null
                    }
                  />
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {project.targetDate ? (
                    <DatePickerPopover
                      fromDate={new Date()}
                      onSelect={(date) => handleDateChange(project.id, date)}
                      trigger={
                        <button
                          className="text-sm hover:underline"
                          type="button"
                        >
                          {formatDateCompact(project.targetDate)}
                        </button>
                      }
                      value={ensureDate(project.targetDate)}
                    />
                  ) : (
                    <DatePickerPopover
                      fromDate={new Date()}
                      iconOnly
                      onSelect={(date) => handleDateChange(project.id, date)}
                      placeholder="Set target date"
                      value={null}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <HexagonProgress value={project.completionPercentage} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      % of artifacts in &quot;Complete&quot; status
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground text-sm">
                    {formatRelativeTime(project.updatedAt)}
                  </span>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button className="h-8 w-8" size="icon" variant="ghost">
                        <MoreHorizontalIcon className="h-4 w-4" />
                        <span className="sr-only">Open menu</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        onClick={() =>
                          deleteConfirmation.requestDelete(project)
                        }
                      >
                        <TrashIcon className="mr-2 h-4 w-4" />
                        Delete project
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </SortableProjectRow>
            ))}
          </TableBody>
        </SortableContext>
      </Table>

      <DeleteConfirmationDialog
        isPending={deleteConfirmation.isPending}
        itemName={deleteConfirmation.itemToDelete?.name ?? ""}
        onConfirm={deleteConfirmation.confirmDelete}
        onOpenChange={deleteConfirmation.setOpen}
        open={deleteConfirmation.isOpen}
        title="Project"
      />
    </div>
  );
}
