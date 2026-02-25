"use client";

import {
  type ArtifactStatus,
  ArtifactType,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
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
import { Input } from "@repo/design-system/components/ui/input";
import { Separator } from "@repo/design-system/components/ui/separator";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  ChevronDownIcon,
  CircleDotIcon,
  ClipboardListIcon,
  FileTextIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EditableProjectDescription } from "@/components/editable-project-description";
import { EditableProjectTitle } from "@/components/editable-project-title";
import {
  useArtifactsByProject,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { useCreateIssue } from "@/hooks/queries/use-issues";
import {
  useDeleteProject,
  useIsFavorite,
  useProject,
  useProjectActivity,
  useToggleFavorite,
  useUpdateProjectOwner,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@/hooks/queries/use-projects";
import { useTeam } from "@/hooks/queries/use-teams";
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

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const projectId = params.projectId as string;

  const [activeTab, setActiveTab] = useState("documents");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedArtifactType, setSelectedArtifactType] =
    useState<ArtifactType>(ArtifactType.Prd);
  const [viewMode, setViewMode] = useState<"type" | "threaded">("type");
  const [filterText, setFilterText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const isFavorite = useIsFavorite(projectId);
  const toggleFavorite = useToggleFavorite();
  const deleteProjectMutation = useDeleteProject();

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
  const { data: artifacts = [], isLoading: loadingArtifacts } =
    useArtifactsByProject(projectId, {
      staleTime: 4000,
      refetchInterval: (query) => {
        const data = query.state.data ?? [];
        const hasActiveWorkstream = data.some(
          (a) =>
            a.workstream?.state &&
            ACTIVE_WORKSTREAM_STATES.has(a.workstream.state)
        );
        const hasActiveGeneration = data.some(
          (a) =>
            a.generationStatus &&
            isActiveGenerationStatus(a.generationStatus.status)
        );
        return hasActiveWorkstream || hasActiveGeneration ? 5000 : false;
      },
    });

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;
  const activities = activityData?.activities ?? [];

  const loading =
    loadingTeam || loadingProject || loadingActivity || loadingArtifacts;
  const error = teamError?.message || projectError?.message || null;

  // Mutations
  const updatePriorityMutation = useUpdateProjectPriority();
  const updateOwnerMutation = useUpdateProjectOwner();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updateArtifactMutation = useUpdateArtifact();
  const deleteArtifactMutation = useDeleteArtifact();
  const createIssueMutation = useCreateIssue();

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
    status: ArtifactStatus
  ) => {
    updateArtifactMutation.mutate({ id: artifactId, status });
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
        <Button
          className="ml-1 h-6 w-6"
          disabled={toggleFavorite.isPending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite.mutate({
              projectId: project.id,
              isFavorite,
            });
          }}
          size="icon"
          variant="ghost"
        >
          <StarIcon
            className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
          />
          <span className="sr-only">
            {isFavorite ? "Remove from favorites" : "Add to favorites"}
          </span>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost">
                <MoreHorizontalIcon className="h-4 w-4" />
                <span className="sr-only">Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={toggleFavorite.isPending}
                onClick={() =>
                  toggleFavorite.mutate({
                    projectId: project.id,
                    isFavorite,
                  })
                }
              >
                <StarIcon
                  className={`mr-2 h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
                />
                {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <TrashIcon className="mr-2 h-4 w-4 text-destructive" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                <ClipboardListIcon className="mr-2 h-4 w-4" />
                Implementation Plan
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={createIssueMutation.isPending}
                onClick={() => {
                  // TODO: Add feature creation modal
                  createIssueMutation.mutate(
                    { title: "Untitled Feature", projectId },
                    {
                      onSuccess: (issue) => {
                        router.push(`/issues/${issue.slug}`);
                      },
                    }
                  );
                }}
              >
                <CircleDotIcon className="mr-2 h-4 w-4" />
                Feature
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        <div className="flex h-full">
          {/* Main Content Area */}
          <Tabs
            className="flex-1"
            onValueChange={setActiveTab}
            value={activeTab}
          >
            <TabsList className="h-auto w-full justify-start gap-0 rounded-none border-border border-b bg-transparent p-0 px-4 pt-2">
              <TabsTrigger
                className="h-auto rounded-none border-0 border-transparent border-b-2 bg-transparent px-4 py-2 text-base text-muted-foreground shadow-none data-[state=active]:border-b-indigo-500 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="documents"
              >
                Documents
              </TabsTrigger>
              <TabsTrigger
                className="h-auto rounded-none border-0 border-transparent border-b-2 bg-transparent px-4 py-2 text-base text-muted-foreground shadow-none data-[state=active]:border-b-indigo-500 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="features"
              >
                Features
              </TabsTrigger>
              <TabsTrigger
                className="h-auto rounded-none border-0 border-transparent border-b-2 bg-transparent px-4 py-2 text-base text-muted-foreground shadow-none data-[state=active]:border-b-indigo-500 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="workflows"
              >
                Workflows
              </TabsTrigger>
              <TabsTrigger
                className="h-auto rounded-none border-0 border-transparent border-b-2 bg-transparent px-4 py-2 text-base text-muted-foreground shadow-none data-[state=active]:border-b-indigo-500 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                value="branches"
              >
                Branches
              </TabsTrigger>
            </TabsList>
            <div className="p-6">
              <TabsContent className="mt-0" value="documents">
                <div className="mb-6">
                  <EditableProjectTitle
                    initialTitle={project.name}
                    projectId={project.id}
                  />
                  <EditableProjectDescription
                    initialDescription={project.description ?? ""}
                    projectId={project.id}
                  />
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
                {artifacts.length > 0 && (
                  <div className="mb-4">
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                        <SearchIcon className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <Input
                        aria-label="Filter artifacts"
                        className="pl-9"
                        onChange={(e) => setFilterText(e.target.value)}
                        placeholder="Filter artifacts..."
                        value={filterText}
                      />
                    </div>
                  </div>
                )}
                {viewMode === "type" ? (
                  <ArtifactsTable
                    artifacts={artifacts}
                    filterText={filterText}
                    onDelete={handleDeleteArtifact}
                    onStatusChange={handleArtifactStatusChange}
                    projectId={projectId}
                  />
                ) : (
                  <ArtifactsThreadedView
                    artifacts={artifacts}
                    filterText={filterText}
                    onDelete={handleDeleteArtifact}
                    onStatusChange={handleArtifactStatusChange}
                    projectId={projectId}
                  />
                )}
              </TabsContent>
              <TabsContent className="mt-0" value="features">
                <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
                  Features coming soon
                </div>
              </TabsContent>
              <TabsContent className="mt-0" value="workflows">
                <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
                  Workflows coming soon
                </div>
              </TabsContent>
              <TabsContent className="mt-0" value="branches">
                <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
                  Branches coming soon
                </div>
              </TabsContent>
            </div>
          </Tabs>

          {/* Right Sidebar */}
          <div className="w-[300px] space-y-4 border-l p-4">
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
      <DeleteConfirmationDialog
        isPending={deleteProjectMutation.isPending}
        itemName={project.name}
        onConfirm={async () => {
          try {
            await deleteProjectMutation.mutateAsync(project.id);
            router.push(`/teams/${teamId}/projects`);
            return true;
          } catch {
            return false;
          }
        }}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title="Project"
      />
    </>
  );
}
