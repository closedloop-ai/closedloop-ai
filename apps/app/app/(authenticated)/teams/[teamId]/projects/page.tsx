"use client";

import type { ProjectOwner } from "@repo/api/src/types/organization";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Separator } from "@repo/design-system/components/ui/separator";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { Loader2Icon } from "lucide-react";
import { useParams } from "next/navigation";
import {
  useCreateProject,
  useDeleteProject,
  useProjectsByTeam,
  useUpdateProjectOwner,
  useUpdateProjectTargetDate,
} from "@/hooks/queries/use-projects";
import { useTeam } from "@/hooks/queries/use-teams";
import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectsTable } from "./components/projects-table";

export default function TeamProjectsPage() {
  const params = useParams();
  const teamId = params.teamId as string;

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
  const updateOwnerMutation = useUpdateProjectOwner();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const handleUpdateOwner = (projectId: string, owner: ProjectOwner | null) => {
    updateOwnerMutation.mutate({ projectId, ownerId: owner?.id || null });
  };

  const handleUpdateTargetDate = (projectId: string, date: Date | null) => {
    updateTargetDateMutation.mutate({ projectId, targetDate: date });
  };

  const handleCreateProject = (projectData: {
    name: string;
    description?: string;
    priority?: string;
    ownerId?: string;
    targetDate?: string;
    teamIds: string[];
  }) => {
    createProjectMutation.mutate({
      name: projectData.name,
      description: projectData.description,
      priority: projectData.priority as
        | "NOT_SET"
        | "LOW"
        | "MEDIUM"
        | "HIGH"
        | undefined,
      ownerId: projectData.ownerId || null,
      targetDate: projectData.targetDate
        ? new Date(projectData.targetDate)
        : null,
      teamIds: projectData.teamIds,
    });
  };

  const handleDeleteProject = async (projectId: string) => {
    deleteProjectMutation.mutate(projectId);
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
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator className="mr-2 h-4" orientation="vertical" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/teams/${teamId}/projects`}>
                {team.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Projects</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto">
          <CreateProjectModal
            onCreateProject={handleCreateProject}
            teamId={teamId}
            teamName={team.name}
          />
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <div className="mb-6">
          <h1 className="font-semibold text-2xl">Projects</h1>
          <p className="mt-1 text-muted-foreground">
            Manage projects for {team.name}
          </p>
        </div>
        <ProjectsTable
          onDelete={handleDeleteProject}
          onUpdateOwner={handleUpdateOwner}
          onUpdateTargetDate={handleUpdateTargetDate}
          projects={projects}
          teamId={teamId}
        />
      </main>
    </>
  );
}
