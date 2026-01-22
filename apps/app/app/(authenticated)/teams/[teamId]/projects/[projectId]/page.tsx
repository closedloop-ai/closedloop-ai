"use client";

import type { ActivityItem } from "@repo/api/src/types/activity";
import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type {
  ProjectPriority,
  ProjectWithDetails,
} from "@repo/api/src/types/organization";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Separator } from "@repo/design-system/components/ui/separator";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import {
  ChevronDownIcon,
  FileTextIcon,
  ListTodoIcon,
  Loader2Icon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteArtifact,
  getArtifactsByProject,
  updateArtifact,
} from "@/app/actions/artifacts";
import {
  getProjectActivity,
  getProjectById,
  updateProjectOwner,
  updateProjectPriority,
  updateProjectTargetDate,
} from "@/app/actions/projects";
import { getTeamById } from "@/app/actions/teams";
import {
  mapArtifactStatusToDisplay,
  mapDisplayStatusToArtifact,
} from "@/lib/project-constants";
import type {
  ArtifactDisplayStatus,
  ProjectArtifact,
  ProjectArtifactType,
} from "@/types/teams";
import { ActivityPanel } from "./components/activity-panel";
import { ArtifactsTable } from "./components/artifacts-table";
import { CreateArtifactModal } from "./components/create-artifact-modal";
import { PropertiesPanel } from "./components/properties-panel";

export default function ProjectDetailPage() {
  const params = useParams();
  const teamId = params.teamId as string;
  const projectId = params.projectId as string;

  const [project, setProject] = useState<ProjectWithDetails | null>(null);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [team, setTeam] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedArtifactType, setSelectedArtifactType] =
    useState<ArtifactType>("PRD");

  // Load initial data
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);

      const [teamResult, projectResult, activityResult, artifactsResult] =
        await Promise.all([
          getTeamById(teamId),
          getProjectById(projectId),
          getProjectActivity(projectId),
          getArtifactsByProject(projectId),
        ]);

      if (teamResult.success) {
        setTeam({ id: teamResult.data.id, name: teamResult.data.name });
      } else {
        setError(teamResult.error);
      }

      if (projectResult.success) {
        setProject(projectResult.data);
      } else {
        setError(projectResult.error);
      }

      if (activityResult.success) {
        setActivities(activityResult.data.activities);
      }

      if (artifactsResult.success) {
        // Map API artifacts to ProjectArtifact format
        const mappedArtifacts: ProjectArtifact[] = artifactsResult.data.map(
          (artifact) => ({
            id: artifact.id,
            name: artifact.title,
            type: artifact.type as ProjectArtifactType,
            status: mapArtifactStatusToDisplay(artifact.status),
            link: artifact.externalUrl || undefined,
          })
        );
        setArtifacts(mappedArtifacts);
      }

      setLoading(false);
    }
    fetchData();
  }, [teamId, projectId]);

  const handleUpdatePriority = async (priority: ProjectPriority) => {
    if (!project) {
      return;
    }

    // Optimistic update
    setProject({ ...project, priority });

    const result = await updateProjectPriority(project.id, priority);
    if (result.success) {
      setProject(result.data);
    } else {
      // Revert on error
      setProject(project);
      console.error("Failed to update priority:", result.error);
    }
  };

  const handleUpdateOwner = async (ownerId: string | null) => {
    if (!project) {
      return;
    }

    const result = await updateProjectOwner(project.id, ownerId);
    if (result.success) {
      setProject(result.data);
    } else {
      console.error("Failed to update owner:", result.error);
    }
  };

  const handleUpdateTargetDate = async (date: Date | null) => {
    if (!project) {
      return;
    }

    const result = await updateProjectTargetDate(project.id, date);
    if (result.success) {
      setProject(result.data);
    } else {
      console.error("Failed to update target date:", result.error);
    }
  };

  const handleArtifactStatusChange = async (
    artifactId: string,
    status: ArtifactDisplayStatus
  ) => {
    // Optimistic update
    setArtifacts((prev) =>
      prev.map((a) => (a.id === artifactId ? { ...a, status } : a))
    );

    // Save to API
    const apiStatus = mapDisplayStatusToArtifact(status);
    const result = await updateArtifact({
      id: artifactId,
      status: apiStatus as "DRAFT" | "REVIEW" | "APPROVED" | "ARCHIVED",
    });

    if (!result.success) {
      // Revert on error - refetch to get correct state
      const artifactsResult = await getArtifactsByProject(projectId);
      if (artifactsResult.success) {
        const mappedArtifacts: ProjectArtifact[] = artifactsResult.data.map(
          (artifact) => ({
            id: artifact.id,
            name: artifact.title,
            type: artifact.type as ProjectArtifactType,
            status: mapArtifactStatusToDisplay(artifact.status),
            link: artifact.externalUrl || undefined,
          })
        );
        setArtifacts(mappedArtifacts);
      }
      console.error("Failed to update artifact status:", result.error);
    }
  };

  const handleCreateArtifact = (type: ArtifactType) => {
    setSelectedArtifactType(type);
    setCreateModalOpen(true);
  };

  const handleArtifactCreated = (artifact: Artifact) => {
    // Add the new artifact to the list
    const newArtifact: ProjectArtifact = {
      id: artifact.id,
      name: artifact.title,
      type: artifact.type as ProjectArtifactType,
      status: mapArtifactStatusToDisplay(artifact.status),
      link: artifact.externalUrl || undefined,
    };
    setArtifacts((prev) => [newArtifact, ...prev]);
  };

  const handleDeleteArtifact = async (artifactId: string) => {
    const result = await deleteArtifact(artifactId);
    if (result.success) {
      setArtifacts((prev) => prev.filter((a) => a.id !== artifactId));
    } else {
      console.error("Failed to delete artifact:", result.error);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !project || !team) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{error || "Project not found"}</p>
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
              <BreadcrumbLink href={`/teams/${teamId}/projects`}>
                {team.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{project.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                Create
                <ChevronDownIcon className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleCreateArtifact("PRD")}>
                <FileTextIcon className="mr-2 h-4 w-4" />
                PRD
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCreateArtifact("IMPLEMENTATION_PLAN")}
              >
                <ListTodoIcon className="mr-2 h-4 w-4" />
                Implementation Plan
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        <div className="flex h-full">
          {/* Main Content Area */}
          <div className="flex-1 p-6">
            <div className="mb-6">
              <h1 className="font-semibold text-2xl">{project.name}</h1>
              {project.description ? (
                <p className="mt-1 text-muted-foreground">
                  {project.description}
                </p>
              ) : null}
            </div>
            <ArtifactsTable
              artifacts={artifacts}
              onDelete={handleDeleteArtifact}
              onStatusChange={handleArtifactStatusChange}
            />
          </div>

          {/* Right Sidebar */}
          <div className="w-[300px] space-y-4 overflow-y-auto border-l p-4">
            <PropertiesPanel
              onUpdateOwner={handleUpdateOwner}
              onUpdatePriority={handleUpdatePriority}
              onUpdateTargetDate={handleUpdateTargetDate}
              project={project}
            />
            <Separator />
            <ActivityPanel activities={activities} />
          </div>
        </div>
      </main>
      <CreateArtifactModal
        artifactType={selectedArtifactType}
        onOpenChange={setCreateModalOpen}
        onSuccess={handleArtifactCreated}
        open={createModalOpen}
        projectId={projectId}
      />
    </>
  );
}
