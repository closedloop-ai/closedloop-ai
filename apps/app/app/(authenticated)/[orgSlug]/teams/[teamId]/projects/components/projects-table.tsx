"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  ProjectStatus,
  ProjectWithDetails,
} from "@repo/api/src/types/project";
import { PROJECTS_FILTER_SORT_MODEL_FLAG_KEY } from "@repo/api/src/types/projects-filter-sort-model-flag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  DocumentRow,
  getDocumentTableColumnCount,
} from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { DocumentTableHeader } from "@repo/app/documents/components/table/table-header";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { withPriorityDisplayFallback } from "@repo/app/documents/lib/priority-display-fallback";
import type { ProjectIndexBulkSelection } from "@repo/app/projects/components/project-index-bulk-actions";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { ArtifactBulkActionBar } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { PROJECT_DEFAULT_COLUMNS } from "@repo/app/shared/hooks/use-column-visibility";
import { useDeleteConfirmation } from "@repo/app/shared/hooks/use-delete-confirmation";
import { useSortParams } from "@repo/app/shared/hooks/use-sort-params";
import type { SortDirection } from "@repo/app/shared/lib/table-utils";
import { sortTableData } from "@repo/app/shared/lib/table-utils";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { TableSelectionAnnouncer } from "@repo/design-system/components/ui/table-bulk-action-bar";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { ariaTableProps } from "@repo/design-system/lib/grid-table-aria";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  PROJECT_SORT_COLUMNS,
  PROJECT_SORT_CONFIGS,
  PROJECT_SORT_CONFIGS_DETERMINISTIC,
  type ProjectSortColumn,
} from "./project-filter-sort-model";
import { ProjectRowActions } from "./project-row-actions";

type ProjectsTableProps = {
  bulkSelection?: ProjectIndexBulkSelection;
  projects: ProjectWithDetails[];
  teamId: string;
  visibleColumns?: DocumentColumn[];
  onUpdateAssignee?: (projectId: string, assigneeId: string | null) => void;
  onUpdateTargetDate?: (
    projectId: string,
    date: Date | null,
    recoverableErrorOwner?: () => boolean
  ) => Promise<unknown> | undefined;
  onUpdatePriority?: (projectId: string, priority: Priority | null) => void;
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

export function ProjectsTable({
  bulkSelection,
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

  // ISS-9441: the grid's one read site for the unset-priority flag. Flag off,
  // the ROW MODEL is folded before sorting (see `withPriorityDisplayFallback`),
  // so the sort and the cell cannot describe one project two ways.
  const unsetPriorityEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_UNSET_FLAG_KEY
  );
  // ISS-9346: this table's ONE read of the filter/sort key. It picks between
  // two WHOLE sort tables — the shipped one, and the one whose every column
  // breaks a tie deterministically — rather than steering a comparator from a
  // distance. The boolean is not passed on.
  const deterministicSortEnabled = useFeatureFlagEnabledOptional(
    PROJECTS_FILTER_SORT_MODEL_FLAG_KEY
  );
  const sortedProjects = useMemo(() => {
    const rows = unsetPriorityEnabled
      ? projects
      : withPriorityDisplayFallback(projects);
    const configs = deterministicSortEnabled
      ? PROJECT_SORT_CONFIGS_DETERMINISTIC
      : PROJECT_SORT_CONFIGS;
    return sortTableData(rows, sortBy, configs, sortDir);
  }, [
    deterministicSortEnabled,
    projects,
    sortBy,
    sortDir,
    unsetPriorityEnabled,
  ]);

  // ISS-4761: opts into the same shared `GridTable` ARIA semantics as the
  // Documents tree, because this table renders the same header and row
  // components — opting in separately would let one carry table roles while the
  // other did not. ISS-5280 retired the flag that staged both, so this is now
  // unconditional and needs no flag provider to mount (Storybook and the
  // mini-table tests host none — ISS-4792 pins that case).
  const insideAriaTable = true;
  const ariaColumnCount = getDocumentTableColumnCount(visibleColumns.length);

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
      onUpdatePriority,
      onUpdateDueDate: onUpdateTargetDate
        ? (id, date, recoverableErrorOwner) =>
            onUpdateTargetDate(id, date, recoverableErrorOwner)
        : undefined,
    }),
    [orgUsers, onUpdateAssignee, onUpdatePriority, onUpdateTargetDate]
  );
  const selectedProjects = sortedProjects.filter((project) =>
    bulkSelection?.selectedIds.has(project.id)
  );
  const allSelected =
    sortedProjects.length > 0 &&
    selectedProjects.length === sortedProjects.length;

  useEffect(() => {
    if (!bulkSelection?.enabled) {
      return;
    }
    const visibleIds = new Set(sortedProjects.map((project) => project.id));
    const reconciled = new Set(
      [...bulkSelection.selectedIds].filter((id) => visibleIds.has(id))
    );
    if (reconciled.size !== bulkSelection.selectedIds.size) {
      bulkSelection.onChange(reconciled);
    }
  }, [bulkSelection, sortedProjects]);

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
      {bulkSelection?.enabled ? (
        <>
          <TableSelectionAnnouncer
            count={selectedProjects.length}
            noun={PROJECT_NOUN}
          />
          <ArtifactBulkActionBar
            actions={bulkSelection.actions}
            minimumSelectedRows={2}
            noun={PROJECT_NOUN}
            onClear={() => bulkSelection.onChange(new Set())}
            onRetainSelection={(ids) => bulkSelection.onChange(new Set(ids))}
            rowIds={selectedProjects.map((project) => project.id)}
          />
        </>
      ) : null}
      {/* ISS-4761: this table shares the Documents tree's header + row
          renderers, so it opts into the same ARIA table semantics under the same
          flag — otherwise flipping the tree on would leave a second table
          rendering `role="row"`-less rows against an opted-in header. */}
      <div
        {...ariaTableProps(insideAriaTable, ariaColumnCount)}
        className="min-w-fit"
      >
        <DocumentTableHeader
          allSelected={allSelected}
          insideAriaTable={insideAriaTable}
          onSelectAll={(checked) =>
            bulkSelection?.onChange(
              checked
                ? new Set(sortedProjects.map((project) => project.id))
                : new Set()
            )
          }
          onSort={(column, dir: SortDirection) =>
            setSort(column as ProjectSortColumn, dir)
          }
          showSelectAll={bulkSelection?.enabled}
          someSelected={selectedProjects.length > 0 && !allSelected}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
        {sortedProjects.map((project) => {
          const item: DocumentRowItem = { kind: "project", data: project };
          return (
            <DocumentRow
              editHandlers={editHandlers}
              insideAriaTable={insideAriaTable}
              isSelected={bulkSelection?.selectedIds.has(project.id)}
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
              onSelectionChange={(id, checked) => {
                if (!bulkSelection) {
                  return;
                }
                const next = new Set(bulkSelection.selectedIds);
                if (checked) {
                  next.add(id);
                } else {
                  next.delete(id);
                }
                bulkSelection.onChange(next);
              }}
              showCheckbox={bulkSelection?.enabled}
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

const PROJECT_NOUN = { one: "project", other: "projects" } as const;
