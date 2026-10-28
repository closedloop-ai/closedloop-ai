"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { CreateProjectInput } from "@repo/api/src/types/project";
import { ProjectStatus } from "@repo/api/src/types/project";
import { PROJECTS_FILTER_SORT_MODEL_FLAG_KEY } from "@repo/api/src/types/projects-filter-sort-model-flag";
import { useProjectIndexBulkActions } from "@repo/app/projects/components/project-index-bulk-actions";
import {
  useCreateProject,
  useDeleteProject,
  useProjectsByTeam,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectStatus,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useTeam } from "@repo/app/teams/hooks/use-teams";
import { toast } from "@repo/design-system/components/ui/sonner";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectsFilteredSurface } from "./components/projects-filtered-surface";
import { ProjectsListHeader } from "./components/projects-list-header";
import { ProjectsPortableSurface } from "./components/projects-portable-surface";
import { ProjectsTable } from "./components/projects-table";

const COLUMN_VISIBILITY_BASE_KEY = "table:columns:team-projects";
/**
 * The portable surface's own view-state key. Deliberately NOT the one above:
 * that payload is keyed by `DocumentColumn` ids and this one by the portable
 * grid's, so sharing a key would hand each surface the other's column list.
 */
const PORTABLE_VIEW_STATE_BASE_KEY = "table:view:team-projects-portable";

export default function TeamProjectsPage() {
  const params = useRouteParams();
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  const teamId = getStringRouteParam(params, "teamId");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  // ISS-10476: the route's one read of this key. It picks between two whole
  // surfaces — neither knows a flag exists — so nothing below is threaded it.
  const portableSurfaceEnabled = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );

  // ISS-9346: this page's ONE read of the filter/sort key. It picks between two
  // whole surfaces — the plain table, and the filtered surface that wraps it —
  // and never hands the boolean to either.
  const filterSortModelEnabled = useFeatureFlagEnabledOptional(
    PROJECTS_FILTER_SORT_MODEL_FLAG_KEY
  );

  const columnVisibilityKey = useViewStateKey(COLUMN_VISIBILITY_BASE_KEY);
  const portableViewStateKey = useViewStateKey(PORTABLE_VIEW_STATE_BASE_KEY);
  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: columnVisibilityKey,
  });
  const visibleColumns = useMemo(
    () => PROJECT_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

  // Queries
  const {
    data: team,
    isLoading: loadingTeam,
    error: teamError,
  } = useTeam(teamId);
  const {
    data: projects = [],
    isLoading: loadingProjects,
    error: projectsError,
  } = useProjectsByTeam(teamId, undefined, {
    excludeStatus: [ProjectStatus.Archived],
  });

  const loading = loadingTeam || loadingProjects;
  const error = teamError?.message || projectsError?.message || null;

  // Mutations
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updatePriorityMutation = useUpdateProjectPriority();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();
  const updateStatusMutation = useUpdateProjectStatus();
  const projectBulkActions = useProjectIndexBulkActions({
    projects,
    selectedIds: selectedProjectIds,
  });
  const bulkSelection = {
    ...projectBulkActions,
    onChange: setSelectedProjectIds,
    selectedIds: selectedProjectIds,
  };

  const handleUpdateAssignee = (
    projectId: string,
    assigneeId: string | null
  ) => {
    updateAssigneeMutation.mutate({ projectId, assigneeId });
  };

  const handleUpdateTargetDate = (
    projectId: string,
    date: Date | null,
    recoverableErrorOwner?: () => boolean
  ) => {
    return updateTargetDateMutation.mutateAsync({
      projectId,
      targetDate: date,
      ...(recoverableErrorOwner ? { recoverableErrorOwner } : {}),
    });
  };

  const handleUpdatePriority = (
    projectId: string,
    priority: Priority | null
  ) => {
    updatePriorityMutation.mutate({ projectId, priority });
  };

  const handleCreateProject = async (projectData: CreateProjectInput) => {
    // mutateAsync (not the preferred mutate) is intentional here: the modal
    // awaits this promise to only close + reset on success — a rejection keeps
    // it open with input intact — and we need the resolved project id to
    // navigate. The global QueryClient onError handler still owns the failure
    // toast, so we do not add a local catch.
    const newProject = await createProjectMutation.mutateAsync(projectData);
    navigation.navigate(
      `/${orgSlug}/teams/${teamId}/projects/${newProject.id}`
    );
  };

  const handleDeleteProject = async (projectId: string) => {
    const result = await deleteProjectMutation.mutateAsync(projectId);
    return result.deleted ?? false;
  };

  const handleUpdateStatus = (
    projectId: string,
    status: ProjectStatus,
    previousStatus: ProjectStatus
  ) => {
    updateStatusMutation.mutate(
      { projectId, status },
      {
        onSuccess: () => {
          if (status === ProjectStatus.Archived) {
            toast.success("Project archived", {
              action: {
                label: "Undo",
                onClick: () => {
                  updateStatusMutation.mutate({
                    projectId,
                    status: previousStatus,
                  });
                },
              },
            });
            return;
          }
          toast.success("Project unarchived");
        },
      }
    );
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !team) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{error || "Team not found"}</p>
      </div>
    );
  }

  // ISS-10476 + ISS-9346: two independent flags, one precedence, decided once
  // here so neither surface below is handed a boolean. The promoted portable
  // surface supersedes both of the older shapes when it is on.
  let projectsSurface: ReactNode;
  if (portableSurfaceEnabled) {
    projectsSurface = (
      <ProjectsPortableSurface
        bulkSelection={bulkSelection}
        onCreateProject={() => setCreateProjectOpen(true)}
        onDelete={handleDeleteProject}
        onUpdateAssignee={handleUpdateAssignee}
        onUpdatePriority={handleUpdatePriority}
        onUpdateStatus={handleUpdateStatus}
        onUpdateTargetDate={handleUpdateTargetDate}
        orgSlug={orgSlug}
        projects={projects}
        teamId={teamId}
        viewStateKey={portableViewStateKey}
      />
    );
  } else if (filterSortModelEnabled) {
    projectsSurface = (
      <ProjectsFilteredSurface
        bulkSelection={bulkSelection}
        onCreateProject={() => setCreateProjectOpen(true)}
        onDelete={handleDeleteProject}
        onToggleColumn={toggleColumn}
        onUpdateAssignee={handleUpdateAssignee}
        onUpdatePriority={handleUpdatePriority}
        onUpdateStatus={handleUpdateStatus}
        onUpdateTargetDate={handleUpdateTargetDate}
        projects={projects}
        teamId={teamId}
        visibility={visibility}
        visibleColumns={visibleColumns}
      />
    );
  } else {
    projectsSurface = (
      <>
        <ProjectsListHeader
          onToggleColumn={toggleColumn}
          visibility={visibility}
        />
        <div className="flex-1 overflow-auto">
          <ProjectsTable
            bulkSelection={bulkSelection}
            onCreateProject={() => setCreateProjectOpen(true)}
            onDelete={handleDeleteProject}
            onUpdateAssignee={handleUpdateAssignee}
            onUpdatePriority={handleUpdatePriority}
            onUpdateStatus={handleUpdateStatus}
            onUpdateTargetDate={handleUpdateTargetDate}
            projects={projects}
            teamId={teamId}
            visibleColumns={visibleColumns}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Home", href: `/${orgSlug}` },
          { label: team.name, href: `/${orgSlug}/teams/${teamId}/projects` },
          { label: "Projects" },
        ]}
        suppressPageHeading
      >
        <CreateProjectModal
          onCreateProject={handleCreateProject}
          onOpenChange={setCreateProjectOpen}
          open={createProjectOpen}
          teamId={teamId}
          teamName={team.name}
        />
      </Header>
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {projectsSurface}
      </div>
    </>
  );
}
