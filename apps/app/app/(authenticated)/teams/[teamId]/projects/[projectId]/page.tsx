"use client";

import { ArtifactSubtype } from "@repo/api/src/types/artifact";
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
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  AlertCircleIcon,
  BugIcon,
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
import { isActiveGenerationStatus } from "@/lib/generation-status-utils";
import {
  mapArtifactStatusToDisplay,
  mapDisplayStatusToArtifact,
} from "@/lib/project-constants";
import type {
  ArtifactDisplayStatus,
  ProjectArtifact,
  ProjectArtifactSubtype,
} from "@/types/teams";
import { ActivityPanel } from "./components/activity-panel";
import { ArtifactsTable } from "./components/artifacts-table";
import { ArtifactsThreadedView } from "./components/artifacts-threaded-view";
import { CreateArtifactModal } from "./components/create-artifact-modal";
import { PropertiesPanel } from "./components/properties-panel";
import { useMergeNotification } from "./hooks/use-merge-notification";

/** Workstream states that indicate an async workflow is actively running. */
const ACTIVE_WORKSTREAM_STATES = new Set([
  "REQUIREMENTS_GENERATING",
  "IMPLEMENTATION_PLANNING",
  "IMPLEMENTATION_IN_PROGRESS",
  "CODE_REVIEW_RUNNING",
  "VISUAL_QA_RUNNING",
  "MERGING",
]);

/**
 * Map backend ArtifactSubtype to frontend ProjectArtifactSubtype.
 * PULL_REQUEST artifacts are displayed under the BRANCH section.
 */
function toProjectArtifactSubtype(subtype: string): ProjectArtifactSubtype {
  if (subtype === "PULL_REQUEST") {
    return "BRANCH";
  }
  return subtype as ProjectArtifactSubtype;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const teamId = params.teamId as string;
  const projectId = params.projectId as string;

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedArtifactSubtype, setSelectedArtifactSubtype] =
    useState<ArtifactSubtype>(ArtifactSubtype.Prd);
  const [viewMode, setViewMode] = useState<"type" | "threaded">("type");

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

  // Show toast notification when PRs are merged
  useMergeNotification(activityData, projectId, teamId);

  // Poll artifacts when any workstream is actively running (e.g., execution in progress).
  // This ensures webhook-created artifacts (like PRs) appear without a manual refresh.
  // Uses TanStack Query's function form of refetchInterval to access query data directly,
  // avoiding a circular dependency between the memo and the query declaration.
  const { data: artifactsData = [], isLoading: loadingArtifacts } =
    useArtifactsByProject(projectId, true, {
      staleTime: 4000,
      refetchInterval: (query) => {
        const artifacts = query.state.data ?? [];
        const hasActiveWorkstream = artifacts.some(
          (a) =>
            a.workstream?.state &&
            ACTIVE_WORKSTREAM_STATES.has(a.workstream.state)
        );
        const hasActiveGeneration = artifacts.some(
          (a) =>
            a.generationStatus &&
            isActiveGenerationStatus(a.generationStatus.status)
        );
        return hasActiveWorkstream || hasActiveGeneration ? 5000 : false;
      },
    });

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;
  const activities = activityData?.activities ?? [];

  // Map API artifacts to ProjectArtifact format
  const artifacts: ProjectArtifact[] = useMemo(
    () =>
      artifactsData.map((artifact) => ({
        id: artifact.id,
        documentSlug: artifact.documentSlug,
        name: artifact.title,
        subtype: toProjectArtifactSubtype(artifact.subtype),
        status: mapArtifactStatusToDisplay(artifact.status),
        parentId: artifact.parentId,
        link: artifact.externalUrl || undefined,
        previewUrl: artifact.previewDeployment?.url ?? undefined,
        pullRequest: artifact.pullRequest ?? null,
        workstreamId: artifact.workstreamId,
        workstreamTitle: artifact.workstream?.title,
        workstreamState: artifact.workstream?.state,
        generationStatus: artifact.generationStatus,
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

  const handleCreateArtifact = (subtype: ArtifactSubtype) => {
    setSelectedArtifactSubtype(subtype);
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
                onClick={() => handleCreateArtifact(ArtifactSubtype.Prd)}
              >
                <FileTextIcon className="mr-2 h-4 w-4" />
                PRD
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  handleCreateArtifact(ArtifactSubtype.ImplementationPlan)
                }
              >
                <ListTodoIcon className="mr-2 h-4 w-4" />
                Implementation Plan
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  handleCreateArtifact(ArtifactSubtype.ImplementationStrategy)
                }
              >
                <ListTodoIcon className="mr-2 h-4 w-4" />
                Implementation Strategy
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCreateArtifact(ArtifactSubtype.Issue)}
              >
                <AlertCircleIcon className="mr-2 h-4 w-4" />
                Issue
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCreateArtifact(ArtifactSubtype.Bug)}
              >
                <BugIcon className="mr-2 h-4 w-4" />
                Bug
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
            <div className="mb-4 flex items-center justify-end">
              <ToggleGroup
                onValueChange={(value) => {
                  if (value) {
                    setViewMode(value as "type" | "threaded");
                  }
                }}
                type="single"
                value={viewMode}
              >
                <ToggleGroupItem value="type">Type</ToggleGroupItem>
                <ToggleGroupItem value="threaded">Threaded</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {viewMode === "type" ? (
              <ArtifactsTable
                artifacts={artifacts}
                onDelete={handleDeleteArtifact}
                onStatusChange={handleArtifactStatusChange}
              />
            ) : (
              <ArtifactsThreadedView
                artifacts={artifacts}
                onDelete={handleDeleteArtifact}
                onStatusChange={handleArtifactStatusChange}
              />
            )}
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
        artifactSubtype={selectedArtifactSubtype}
        onOpenChange={setCreateModalOpen}
        open={createModalOpen}
        projectId={projectId}
      />
    </>
  );
}
