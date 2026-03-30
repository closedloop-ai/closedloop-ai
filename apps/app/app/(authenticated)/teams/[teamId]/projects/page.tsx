"use client";

import type { Priority } from "@repo/api/src/types/common";
import type { CreateProjectInput } from "@repo/api/src/types/project";
import { Loader2Icon } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { ColumnVisibilityPanel } from "@/components/artifact-table/column-visibility-panel";
import {
  useCreateProject,
  useDeleteProject,
  useProjectsByTeam,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@/hooks/queries/use-projects";
import { useTeam } from "@/hooks/queries/use-teams";
import {
  PROJECT_DEFAULT_COLUMNS,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectsTable } from "./components/projects-table";

export default function TeamProjectsPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  const { visibility, userVisibility, toggleColumn } = useColumnVisibility();
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
  } = useProjectsByTeam(teamId);

  const loading = loadingTeam || loadingProjects;
  const error = teamError?.message || projectsError?.message || null;

  // Mutations
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updatePriorityMutation = useUpdateProjectPriority();
  const createProjectMutation = useCreateProject();
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

  const handleCreateProject = (projectData: CreateProjectInput) => {
    createProjectMutation.mutate(projectData, {
      onSuccess: (newProject) => {
        router.push(`/teams/${teamId}/projects/${newProject.id}`);
      },
    });
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
          { label: "Home", href: "/" },
          { label: team.name, href: `/teams/${teamId}/projects` },
          { label: "Projects" },
        ]}
      >
        <CreateProjectModal
          onCreateProject={handleCreateProject}
          onOpenChange={setCreateProjectOpen}
          open={createProjectOpen}
          teamId={teamId}
          teamName={team.name}
        />
      </Header>
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Title bar */}
        <div className="flex min-w-fit items-center justify-between border-b px-4 pt-4 pb-2">
          <h1 className="font-semibold text-xl">Projects</h1>
          <ColumnVisibilityPanel
            columns={PROJECT_DEFAULT_COLUMNS}
            onToggle={toggleColumn}
            visibility={visibility}
          />
        </div>
        {/* Table scroll area */}
        <div className="flex-1 overflow-auto">
          <ProjectsTable
            onCreateProject={() => setCreateProjectOpen(true)}
            onDelete={handleDeleteProject}
            onUpdateAssignee={handleUpdateAssignee}
            onUpdatePriority={handleUpdatePriority}
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
