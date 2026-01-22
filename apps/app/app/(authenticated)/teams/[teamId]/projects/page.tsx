"use client";

import type {
  ProjectOwner,
  ProjectWithDetails,
} from "@repo/api/src/types/organization";
import type { TeamWithCounts } from "@repo/api/src/types/teams";
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
import { useEffect, useState } from "react";
import {
  createProject,
  deleteProject,
  getProjectsByTeam,
  updateProjectOwner,
  updateProjectTargetDate,
} from "@/app/actions/projects";
import { getTeamById } from "@/app/actions/teams";
import { CreateProjectModal } from "./components/create-project-modal";
import { ProjectsTable } from "./components/projects-table";

export default function TeamProjectsPage() {
  const params = useParams();
  const teamId = params.teamId as string;

  const [projects, setProjects] = useState<ProjectWithDetails[]>([]);
  const [team, setTeam] = useState<TeamWithCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load initial data
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);

      const [teamResult, projectsResult] = await Promise.all([
        getTeamById(teamId),
        getProjectsByTeam(teamId),
      ]);

      if (teamResult.success) {
        setTeam(teamResult.data);
      } else {
        setError(teamResult.error);
      }

      if (projectsResult.success) {
        setProjects(projectsResult.data);
      } else {
        setError(projectsResult.error);
      }

      setLoading(false);
    }
    fetchData();
  }, [teamId]);

  const handleUpdateOwner = async (
    projectId: string,
    owner: ProjectOwner | null
  ) => {
    const result = await updateProjectOwner(projectId, owner?.id || null);
    if (result.success) {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? result.data : p))
      );
    } else {
      console.error("Failed to update owner:", result.error);
    }
  };

  const handleUpdateTargetDate = async (
    projectId: string,
    date: Date | null
  ) => {
    const result = await updateProjectTargetDate(projectId, date);
    if (result.success) {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? result.data : p))
      );
    } else {
      console.error("Failed to update target date:", result.error);
    }
  };

  const handleCreateProject = async (projectData: {
    name: string;
    description?: string;
    priority?: string;
    ownerId?: string;
    targetDate?: string;
    teamIds: string[];
  }) => {
    const result = await createProject({
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

    if (result.success) {
      setProjects((prev) => [result.data, ...prev]);
    } else {
      console.error("Failed to create project:", result.error);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const result = await deleteProject(projectId);
    if (result.success) {
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } else {
      console.error("Failed to delete project:", result.error);
    }
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
