"use client";

import { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { FolderIcon } from "lucide-react";
import { useMemo } from "react";
import type {
  ArtifactRowItem,
  RowEditHandlers,
} from "@/components/artifact-table/artifact-row";
import { ArtifactRow } from "@/components/artifact-table/artifact-row";
import { ArtifactTableHeader } from "@/components/artifact-table/table-header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EmptyState } from "@/components/empty-state";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import { PROJECT_DEFAULT_COLUMNS } from "@/hooks/use-column-visibility";
import { useDeleteConfirmation } from "@/hooks/use-delete-confirmation";
import { useSortParams } from "@/hooks/use-sort-params";
import type { SortConfig, SortDirection } from "@/lib/table-utils";
import { sortTableData } from "@/lib/table-utils";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";
import { ProjectRowActions } from "./project-row-actions";

type ProjectsTableProps = {
  projects: ProjectWithDetails[];
  teamId: string;
  visibleColumns?: ArtifactColumn[];
  onUpdateAssignee?: (projectId: string, assigneeId: string | null) => void;
  onUpdateTargetDate?: (projectId: string, date: Date | null) => void;
  onUpdatePriority?: (projectId: string, priority: Priority) => void;
  onUpdateStatus?: (
    projectId: string,
    status: ProjectStatus,
    previousStatus: ProjectStatus
  ) => void;
  onDelete?: (projectId: string) => Promise<boolean>;
  onCreateProject?: () => void;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
};

const PROJECT_SORT_COLUMNS = [
  "title",
  "priority",
  "assignee",
  "dueDate",
  "updated",
] as const;
type ProjectSortColumn = (typeof PROJECT_SORT_COLUMNS)[number];

const PRIORITY_ORDER: Record<Priority, number> = {
  [Priority.Urgent]: 0,
  [Priority.High]: 1,
  [Priority.Medium]: 2,
  [Priority.Low]: 3,
};

const PROJECT_SORT_CONFIGS: Record<
  ProjectSortColumn,
  SortConfig<ProjectWithDetails>
> = {
  title: { key: "name", columnType: "string" },
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
  dueDate: { key: "targetDate", columnType: "date" },
  updated: { key: "updatedAt", columnType: "date" },
};

export function ProjectsTable({
  projects,
  visibleColumns = PROJECT_DEFAULT_COLUMNS,
  onUpdateAssignee,
  onUpdateTargetDate,
  onUpdatePriority,
  onUpdateStatus,
  onDelete,
  onCreateProject,
  emptyStateTitle = "No projects yet",
  emptyStateDescription = "Create your first project to get started.",
}: ProjectsTableProps) {
  const { data: usersResult } = useOrganizationUsers();
  const { sortBy, sortDir, setSort } = useSortParams<ProjectSortColumn>({
    defaultColumn: "title",
    defaultDirection: "asc",
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
      onUpdateAssignee: onUpdateAssignee
        ? (id, assigneeId) => onUpdateAssignee(id, assigneeId)
        : undefined,
      onUpdatePriority: onUpdatePriority
        ? (id, priority) => onUpdatePriority(id, priority)
        : undefined,
      onUpdateDueDate: onUpdateTargetDate
        ? (id, date) => onUpdateTargetDate(id, date)
        : undefined,
    }),
    [orgUsers, onUpdateAssignee, onUpdatePriority, onUpdateTargetDate]
  );

  if (projects.length === 0) {
    return (
      <EmptyState
        action={
          onCreateProject ? (
            <Button onClick={onCreateProject}>Create Project</Button>
          ) : undefined
        }
        description={emptyStateDescription}
        icon={FolderIcon}
        title={emptyStateTitle}
      />
    );
  }

  return (
    <>
      <div className="min-w-fit">
        <ArtifactTableHeader
          onSort={(column, dir: SortDirection) =>
            setSort(column as ProjectSortColumn, dir)
          }
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {sortedProjects.map((project) => {
          const item: ArtifactRowItem = { kind: "project", data: project };
          return (
            <ArtifactRow
              editHandlers={editHandlers}
              item={item}
              key={project.id}
              moreMenuContent={
                <ProjectRowActions
                  onDelete={() => deleteConfirmation.requestDelete(project)}
                  onUpdateStatus={(nextStatus, previousStatus) =>
                    onUpdateStatus?.(project.id, nextStatus, previousStatus)
                  }
                  projectId={project.id}
                  status={project.status}
                />
              }
              visibleColumns={visibleColumns}
            />
          );
        })}
      </div>

      <DeleteConfirmationDialog
        isPending={deleteConfirmation.isPending}
        itemName={deleteConfirmation.itemToDelete?.name ?? ""}
        onConfirm={deleteConfirmation.confirmDelete}
        onOpenChange={deleteConfirmation.setOpen}
        open={deleteConfirmation.isOpen}
        title="Project"
      />
    </>
  );
}
