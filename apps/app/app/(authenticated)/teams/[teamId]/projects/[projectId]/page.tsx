"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ProjectPriority } from "@repo/api/src/types/organization";
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
  AlertCircleIcon,
  ChevronDownIcon,
  FileTextIcon,
  ListTodoIcon,
  Loader2Icon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { EditableProjectTitle } from "@/components/editable-project-title";
import {
  useArtifactsByProject,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import {
  useProject,
  useProjectActivity,
  useUpdateProjectOwner,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@/hooks/queries/use-projects";
import { useTeam } from "@/hooks/queries/use-teams";
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

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedArtifactType, setSelectedArtifactType] =
    useState<ArtifactType>(ArtifactType.Prd);

  // Queries
  const {
    data: teamData,
    isLoading: loadingTeam,
    error: teamError,
  } = useTeam(teamId);
  const {
    data: project,
    isLoading: loadingProject,
    error: projectError,
  } = useProject(projectId);
  const { data: activityData, isLoading: loadingActivity } =
    useProjectActivity(projectId);
  const { data: artifactsData = [], isLoading: loadingArtifacts } =
    useArtifactsByProject(projectId);

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;
  const activities = activityData?.activities ?? [];

  // Map API artifacts to ProjectArtifact format
  const artifacts: ProjectArtifact[] = useMemo(
    () =>
      artifactsData.map((artifact) => ({
        id: artifact.id,
        documentSlug: artifact.documentSlug,
        name: artifact.title,
        type: artifact.type as ProjectArtifactType,
        status: mapArtifactStatusToDisplay(artifact.status),
        link: artifact.externalUrl || undefined,
      })),
    [artifactsData]
  );

  const loading =
    loadingTeam || loadingProject || loadingActivity || loadingArtifacts;
  const error = teamError?.message || projectError?.message || null;

  // Mutations
  const updatePriorityMutation = useUpdateProjectPriority();
  const updateOwnerMutation = useUpdateProjectOwner();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updateArtifactMutation = useUpdateArtifact();
  const deleteArtifactMutation = useDeleteArtifact();

  const handleUpdatePriority = (priority: ProjectPriority) => {
    if (!project) {
      return;
    }

    updatePriorityMutation.mutate({ projectId: project.id, priority });
  };

  const handleUpdateOwner = (ownerId: string | null) => {
    if (!project) {
      return;
    }

    updateOwnerMutation.mutate({ projectId: project.id, ownerId });
  };

  const handleUpdateTargetDate = (date: Date | null) => {
    if (!project) {
      return;
    }

    updateTargetDateMutation.mutate({
      projectId: project.id,
      targetDate: date,
    });
  };

  const handleArtifactStatusChange = (
    artifactId: string,
    status: ArtifactDisplayStatus
  ) => {
    const apiStatus = mapDisplayStatusToArtifact(status);
    updateArtifactMutation.mutate({
      id: artifactId,
      status: apiStatus as "DRAFT" | "REVIEW" | "APPROVED" | "ARCHIVED",
    });
  };

  const handleCreateArtifact = (type: ArtifactType) => {
    setSelectedArtifactType(type);
    setCreateModalOpen(true);
  };

  const handleDeleteArtifact = async (artifactId: string): Promise<boolean> => {
    const result = await deleteArtifactMutation.mutateAsync(artifactId);
    return result.deleted ?? false;
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
              <DropdownMenuItem
                onClick={() => handleCreateArtifact(ArtifactType.Prd)}
              >
                <FileTextIcon className="mr-2 h-4 w-4" />
                PRD
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  handleCreateArtifact(ArtifactType.ImplementationPlan)
                }
              >
                <ListTodoIcon className="mr-2 h-4 w-4" />
                Implementation Plan
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCreateArtifact(ArtifactType.Issue)}
              >
                <AlertCircleIcon className="mr-2 h-4 w-4" />
                Issue
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
              <EditableProjectTitle
                initialTitle={project.name}
                projectId={project.id}
              />
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
        open={createModalOpen}
        projectId={projectId}
      />
    </>
  );
}
