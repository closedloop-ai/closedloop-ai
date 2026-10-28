"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import type { ProjectIndexBulkSelection } from "@repo/app/projects/components/project-index-bulk-actions";
import { ProjectList } from "@repo/app/projects/components/project-list";
import type { ProjectCellEditors } from "@repo/app/projects/components/projects-table";
import { toProjectSummaryRow } from "@repo/app/projects/lib/project-summary-adapter";
import type { ProjectSummaryRow } from "@repo/app/projects/lib/project-summary-row";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useDeleteConfirmation } from "@repo/app/shared/hooks/use-delete-confirmation";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { type ReactNode, useMemo } from "react";
import {
  ProjectDueDateEditorCell,
  ProjectOwnerEditorCell,
  ProjectPriorityEditorCell,
} from "./project-cell-editors";
import { ProjectRowActions } from "./project-row-actions";
import type { ProjectsEmptyStateCopy } from "./projects-table";

type ProjectsPortableSurfaceProps = {
  bulkSelection?: ProjectIndexBulkSelection;
  emptyStateCopy?: ProjectsEmptyStateCopy;
  onCreateProject: () => void;
  orgSlug?: string;
  getProjectHref?: (projectId: string) => string;
  headingActions?: ReactNode;
  projects: ProjectWithDetails[];
  teamId: string;
  onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
  onUpdatePriority: (projectId: string, priority: Priority | null) => void;
  onUpdateTargetDate: (
    projectId: string,
    date: Date | null
  ) => Promise<unknown> | undefined;
  onDelete: (projectId: string) => Promise<boolean>;
  /**
   * The identity-namespaced key the reader's columns and named views persist
   * under (ISS-9726). `null` while the organization is unresolved, which the
   * surface answers by holding both in memory.
   */
  viewStateKey: string | null;
  onUpdateStatus: (
    projectId: string,
    status: ProjectStatus,
    previousStatus: ProjectStatus
  ) => void;
};

/**
 * The web host for the portable Projects surface (ISS-10476). Everything here
 * is the part that is genuinely this shell's: the org-slug route a row links
 * to, and routing a board drop onto the project mutations the page already
 * owns. The list, board, table, toolbar and filters are `@repo/app`'s.
 */
export function ProjectsPortableSurface({
  bulkSelection,
  emptyStateCopy,
  onCreateProject,
  onDelete,
  onUpdateAssignee,
  onUpdatePriority,
  onUpdateStatus,
  onUpdateTargetDate,
  orgSlug,
  getProjectHref,
  headingActions,
  projects,
  teamId,
  viewStateKey,
}: ProjectsPortableSurfaceProps) {
  const { data: organizationUsers } = useOrganizationUsers();
  const rows = useMemo(
    () => projects.map((project) => toProjectSummaryRow(project)),
    [projects]
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );
  const deleteConfirmation = useDeleteConfirmation({
    getId: (project: ProjectWithDetails) => project.id,
    onDelete,
  });
  const selectableUsers: User[] = useMemo(
    () =>
      (organizationUsers ?? []).map((user) => ({
        avatarUrl: user.avatarUrl ?? undefined,
        email: user.email,
        id: user.id,
        initials: getUserInitials(user.firstName, user.lastName),
        name: getUserDisplayName(user),
      })),
    [organizationUsers]
  );
  // The three writes the replaced table offered from a cell rather than the row
  // menu. Supplied unconditionally: this host owns all three mutations, so a
  // column left read-only here would be a capability the flag takes away.
  const cellEditors: ProjectCellEditors = useMemo(
    () => ({
      dueDate: (row) => (
        <ProjectDueDateEditorCell
          onUpdateTargetDate={onUpdateTargetDate}
          row={row}
        />
      ),
      owner: (row) => (
        <ProjectOwnerEditorCell
          onUpdateAssignee={onUpdateAssignee}
          row={row}
          users={selectableUsers}
        />
      ),
      priority: (row) => (
        <ProjectPriorityEditorCell
          onUpdatePriority={onUpdatePriority}
          row={row}
        />
      ),
    }),
    [onUpdateAssignee, onUpdatePriority, onUpdateTargetDate, selectableUsers]
  );

  // The portable row model carries no `status`, and should not: archiving is a
  // host mutation, not a column this surface renders. The host still holds the
  // records the rows were adapted from, so the menu reads status from there.
  const renderRowActions = (row: ProjectSummaryRow) => {
    const project = projectsById.get(row.id);
    if (!project) {
      return null;
    }
    return (
      <ProjectRowActions
        onDelete={() => deleteConfirmation.requestDelete(project)}
        onUpdateStatus={(nextStatus, previousStatus) =>
          onUpdateStatus(project.id, nextStatus, previousStatus)
        }
        projectId={project.id}
        status={project.status}
      />
    );
  };

  return (
    <>
      <div className="flex min-w-fit items-center border-border border-b px-4 pt-4 pb-2">
        <h1 className="font-semibold text-xl">Projects</h1>
        <div className="ml-auto">{headingActions}</div>
      </div>
      <ProjectList
        bulkSelection={bulkSelection}
        cellEditors={cellEditors}
        emptyStateAction={
          <Button onClick={onCreateProject} size="sm">
            Create Project
          </Button>
        }
        emptyStateCopy={emptyStateCopy}
        getRowHref={(row) =>
          getProjectHref?.(row.id) ??
          `/${orgSlug}/teams/${teamId}/projects/${row.id}`
        }
        onProjectGroupChange={(nextRow, previousRow) =>
          persistProjectGroupChange(nextRow, previousRow, {
            onUpdateAssignee,
            onUpdatePriority,
          })
        }
        rowActions={renderRowActions}
        rows={rows}
        viewStateKey={viewStateKey}
      />
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

function persistProjectGroupChange(
  nextRow: ProjectSummaryRow,
  previousRow: ProjectSummaryRow,
  handlers: {
    onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
    onUpdatePriority: (projectId: string, priority: Priority | null) => void;
  }
) {
  if (nextRow.priority !== previousRow.priority) {
    handlers.onUpdatePriority(nextRow.id, nextRow.priority);
  }
  const nextOwnerId = nextRow.owner?.id ?? null;
  if (nextOwnerId !== (previousRow.owner?.id ?? null)) {
    handlers.onUpdateAssignee(nextRow.id, nextOwnerId);
  }
}
