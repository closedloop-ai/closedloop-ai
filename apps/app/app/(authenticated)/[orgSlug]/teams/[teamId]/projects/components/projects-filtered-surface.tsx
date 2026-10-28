"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { ProjectIndexBulkSelection } from "@repo/app/projects/components/project-index-bulk-actions";
import type {
  ColumnVisibility,
  DocumentColumn,
} from "@repo/app/shared/hooks/use-column-visibility";
import { ActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { useMemo } from "react";
import { filterProjects } from "./project-filter-sort-model";
import { ProjectsListHeader } from "./projects-list-header";
import { ProjectsTable } from "./projects-table";
import { useProjectListFilters } from "./use-project-list-filters";

/**
 * The flag-on shape of the team Projects list (ISS-9346, PRD-706 R10-06): the
 * champion filter menu and its active-chip strip above the existing table.
 *
 * It is a WHOLE alternative surface rather than a prop on the table, which is
 * what lets `page.tsx` swap shapes at one flag read instead of threading a
 * boolean into the table's internals. The table keeps every behaviour it has —
 * this narrows the rows it is handed and nothing else.
 */

/**
 * The filtered-empty state's words.
 *
 * Exported so the suite locates them through the value this component renders
 * rather than re-typing them: ISS-10967 owns approving the final wording for
 * this state, and a literal held only by a test would turn that ruling into a
 * mystery failure instead of a copy change.
 *
 * They exist at all because the INHERITED empty state says, in effect, "there
 * are no projects" — which is FALSE on a filtered result, where there may be
 * fifty and the filter excludes them. A surface must not assert something
 * untrue about its own data, so these are the minimum true statement until
 * ISS-10967 rules on the final wording.
 */
export const PROJECTS_FILTERED_EMPTY_TITLE = "No matching projects";

/** @see PROJECTS_FILTERED_EMPTY_TITLE — same owner, same reason. */
export const PROJECTS_FILTERED_EMPTY_DESCRIPTION =
  "No projects match the current filters. Try clearing or widening a filter.";

type ProjectsFilteredSurfaceProps = {
  bulkSelection?: ProjectIndexBulkSelection;
  projects: ProjectWithDetails[];
  teamId: string;
  visibleColumns: DocumentColumn[];
  visibility: ColumnVisibility;
  onToggleColumn: (column: DocumentColumn) => void;
  onCreateProject: () => void;
  onDelete: (projectId: string) => Promise<boolean>;
  onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
  onUpdatePriority: React.ComponentProps<
    typeof ProjectsTable
  >["onUpdatePriority"];
  onUpdateStatus: React.ComponentProps<typeof ProjectsTable>["onUpdateStatus"];
  onUpdateTargetDate: React.ComponentProps<
    typeof ProjectsTable
  >["onUpdateTargetDate"];
};

export function ProjectsFilteredSurface({
  bulkSelection,
  projects,
  teamId,
  visibleColumns,
  visibility,
  onToggleColumn,
  onCreateProject,
  onDelete,
  onUpdateAssignee,
  onUpdatePriority,
  onUpdateStatus,
  onUpdateTargetDate,
}: ProjectsFilteredSurfaceProps) {
  const { clearAll, controller, currentUserId, filters, viewModel } =
    useProjectListFilters(projects);

  /**
   * `Date.now()` is read inside the memo rather than pinned in state, so every
   * recompute measures the relative window from the current instant rather than
   * from mount.
   *
   * What that does NOT buy is a clock: nothing re-renders on time passing, so an
   * IDLE tab keeps the cutoff of its last recompute until the filters, the
   * projects or the signed-in user change. That is deliberate — a ticking
   * interval would re-sort and re-render a list nobody is looking at — and it
   * is stated here so the next reader does not mistake this for a live window
   * (ISS-9346 review).
   */
  const visibleProjects = useMemo(
    () =>
      filterProjects(projects, filters, {
        currentUserId,
        now: Date.now(),
      }),
    [currentUserId, filters, projects]
  );

  const filtersActive = controller.activeChips.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectsListHeader
        filterSlot={
          <FilterPopover
            controller={controller}
            onClear={clearAll}
            viewModel={viewModel}
          />
        }
        onToggleColumn={onToggleColumn}
        visibility={visibility}
      />
      {/* The chip strip is its OWN row, as the champion composes it: the bar
          ships its own `px-4 pb-2`, so nesting it in a padded row would double
          the inset and leave a second "Clear all" beside the trigger's. */}
      {filtersActive ? (
        <ActiveFiltersBar controller={controller} viewModel={viewModel} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <ProjectsTable
          bulkSelection={bulkSelection}
          emptyStateDescription={
            filtersActive ? PROJECTS_FILTERED_EMPTY_DESCRIPTION : undefined
          }
          emptyStateTitle={
            filtersActive ? PROJECTS_FILTERED_EMPTY_TITLE : undefined
          }
          onCreateProject={onCreateProject}
          onDelete={onDelete}
          onUpdateAssignee={onUpdateAssignee}
          onUpdatePriority={onUpdatePriority}
          onUpdateStatus={onUpdateStatus}
          onUpdateTargetDate={onUpdateTargetDate}
          projects={visibleProjects}
          teamId={teamId}
          visibleColumns={visibleColumns}
        />
      </div>
    </div>
  );
}
