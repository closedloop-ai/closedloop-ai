"use client";

import type { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import { ProjectIndexPage } from "@repo/app/projects/components/project-index-page";
import {
  useDeleteProject,
  useProjectStatusHandler,
  useProjectsByTeam,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import { ARCHIVED_PROJECTS_EMPTY_COPY } from "@repo/app/projects/lib/project-archived-copy";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useTeam } from "@repo/app/teams/hooks/use-teams";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { ProjectsTable } from "../components/projects-table";

const COLUMN_VISIBILITY_BASE_KEY = "table:columns:team-projects-archived";

export default function TeamArchivedProjectsPage() {
  // ISS-13007: the route's one read of the key; it picks between two whole
  // pages and hands neither a boolean.
  const portableSurface = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  return portableSurface ? (
    <GridArchivedProjectsPage />
  ) : (
    <LegacyArchivedProjectsPage />
  );
}

function GridArchivedProjectsPage() {
  const params = useRouteParams();
  const orgSlug = useOrgSlug();
  const teamId = getStringRouteParam(params, "teamId");
  const { data: team } = useTeam(teamId);
  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Home", href: `/${orgSlug}` },
          {
            label: team?.name ?? "",
            href: `/${orgSlug}/teams/${teamId}/projects`,
          },
          { label: "Archived Projects" },
        ]}
        suppressPageHeading
      />
      <ProjectIndexPage archived teamId={teamId} />
    </>
  );
}

function LegacyArchivedProjectsPage() {
  const params = useRouteParams();
  const orgSlug = useOrgSlug();
  const teamId = getStringRouteParam(params, "teamId");

  const columnVisibilityKey = useViewStateKey(COLUMN_VISIBILITY_BASE_KEY);
  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: columnVisibilityKey,
  });
  const visibleColumns = useMemo(
    () => PROJECT_DEFAULT_COLUMNS.filter((c) => userVisibility[c] !== false),
    [userVisibility]
  );

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
    status: [ProjectStatus.Archived],
  });

  const loading = loadingTeam || loadingProjects;
  const error = teamError?.message || projectsError?.message || null;

  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updatePriorityMutation = useUpdateProjectPriority();
  const { handleUpdateStatus } = useProjectStatusHandler({
    showUndoOnUnarchive: true,
  });
  const deleteProjectMutation = useDeleteProject();

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

  const handleDeleteProject = async (projectId: string) => {
    const result = await deleteProjectMutation.mutateAsync(projectId);
    return result.deleted ?? false;
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

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Home", href: `/${orgSlug}` },
          { label: team.name, href: `/${orgSlug}/teams/${teamId}/projects` },
          { label: "Archived Projects" },
        ]}
        suppressPageHeading
      />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Archived Projects</h1>
          <TableViewMenu
            columns={PROJECT_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        <div className="flex-1 overflow-auto">
          <ProjectsTable
            emptyStateDescription={ARCHIVED_PROJECTS_EMPTY_COPY.description}
            emptyStateTitle={ARCHIVED_PROJECTS_EMPTY_COPY.title}
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
      </div>
    </>
  );
}
