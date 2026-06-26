"use client";

import type { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import {
  useDeleteProject,
  useProjectStatusHandler,
  useProjectsByTeam,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@repo/app/projects/hooks/use-projects";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@repo/app/shared/hooks/use-column-visibility";
import { useTeam } from "@repo/app/teams/hooks/use-teams";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { ProjectsTable } from "../components/projects-table";

const COLUMN_VISIBILITY_KEY = "table:columns:team-projects-archived";

export default function TeamArchivedProjectsPage() {
  const params = useRouteParams();
  const orgSlug = useOrgSlug();
  const teamId = getStringRouteParam(params, "teamId");

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility({
    storageKey: COLUMN_VISIBILITY_KEY,
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

  const handleUpdateTargetDate = (projectId: string, date: Date | null) => {
    updateTargetDateMutation.mutate({ projectId, targetDate: date });
  };

  const handleUpdatePriority = (projectId: string, priority: Priority) => {
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
      />
      <main className="flex flex-1 flex-col overflow-hidden">
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
            emptyStateDescription="Archived projects will appear here."
            emptyStateTitle="No archived projects"
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
      </main>
    </>
  );
}
