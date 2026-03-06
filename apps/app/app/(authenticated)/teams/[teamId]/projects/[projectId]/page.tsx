"use client";

import {
  type ArtifactStatus,
  ArtifactType,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  BoxIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FileIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelRightIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { EditableProjectDescription } from "@/components/editable-project-description";
import { EditableProjectTitle } from "@/components/editable-project-title";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/underline-tabs";
import {
  useArtifactsByProject,
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import {
  useDeleteProject,
  useIsFavorite,
  useProject,
  useProjectActivity,
  useToggleFavorite,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "@/hooks/queries/use-projects";
import { useTeam } from "@/hooks/queries/use-teams";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { useTabParam } from "@/hooks/use-tab-param";
import { ActivityPanel } from "./components/activity-panel";
import { ArtifactsTable } from "./components/artifacts-table";
import { ArtifactsThreadedView } from "./components/artifacts-threaded-view";
import { CreateArtifactModal } from "./components/create-artifact-modal";
import { CreateFeatureModal } from "./components/create-feature-modal";
import { FeaturesList } from "./components/features-list";
import { PropertiesPanel } from "./components/properties-panel";
import { useMergeNotification } from "./hooks/use-merge-notification";

/** Workstream states that indicate an async workflow is actively running. */
const ACTIVE_WORKSTREAM_STATES: Set<WorkstreamState> = new Set([
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

  const { activeTab, setActiveTab } = useTabParam({
    validTabs: ["documents", "features", "workflows", "branches"] as const,
    defaultTab: "documents",
  });
  const [createArtifactOpen, setCreateArtifactOpen] = useState(false);
  const [createFeatureOpen, setCreateFeatureOpen] = useState(false);
  const [selectedArtifactType, setSelectedArtifactType] =
    useState<ArtifactType>(ArtifactType.Prd);
  const [viewMode, setViewMode] = useState<"type" | "threaded">("type");
  const [filterText, setFilterText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [showPropertiesPanel, setShowPropertiesPanel] = useLocalStorageState(
    "panel:project-properties",
    true
  );

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
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updateArtifactMutation = useUpdateArtifact();
  const deleteArtifactMutation = useDeleteArtifact();

  const handleUpdatePriority = (priority: Priority) => {
    if (!project) {
      return;
    }
    updatePriorityMutation.mutate({
      projectId: project.id,
      priority,
    });
  };

  const handleUpdateAssignee = (assigneeId: string | null) => {
    if (!project) {
      return;
    }
    updateAssigneeMutation.mutate({ projectId: project.id, assigneeId });
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
    setCreateArtifactOpen(true);
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
      <Header
        afterBreadcrumbs={
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
        }
        breadcrumbs={[
          { label: team.name, href: `/teams/${teamId}/projects` },
          { label: project.name },
        ]}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              Actions
              <ChevronDownIcon className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleCreateArtifact(ArtifactType.Prd)}
            >
              <FileIcon className="mr-2 h-4 w-4" />
              Create PRD
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFeatureOpen(true)}>
              <BoxIcon className="mr-2 h-4 w-4" />
              Create Feature
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                handleCreateArtifact(ArtifactType.ImplementationPlan)
              }
            >
              <FileCode2Icon className="mr-2 h-4 w-4" />
              Create Implementation Plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        <Button
          onClick={() => setShowPropertiesPanel((prev) => !prev)}
          size="icon"
          variant={showPropertiesPanel ? "secondary" : "ghost"}
        >
          <PanelRightIcon className="h-4 w-4" />
        </Button>
      </Header>
      <main className="flex-1 overflow-auto">
        <div className="flex h-full">
          {/* Main Content Area */}
          <Tabs
            className="flex-1"
            onValueChange={setActiveTab}
            value={activeTab}
          >
            <UnderlineTabsList>
              <UnderlineTabsTrigger value="documents">
                Documents
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="features">
                Features
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="workflows">
                Workflows
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="branches">
                Branches
              </UnderlineTabsTrigger>
            </UnderlineTabsList>
            <div className="p-6">
              <TabsContent className="mt-0" value="documents">
                <div className="mb-6 flex flex-col gap-2">
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
                    variant="outline"
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
                <FeaturesList projectId={projectId} />
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
          {showPropertiesPanel ? (
            <div className="w-[300px] space-y-4 border-l p-4">
              {/* TODO: Add the several missing event handlers for the properties panel */}
              <PropertiesPanel
                onUpdateAssignee={handleUpdateAssignee}
                onUpdatePriority={handleUpdatePriority}
                onUpdateTargetDate={handleUpdateTargetDate}
                project={project}
              />
              <Separator />
              <ActivityPanel activities={activities} />
            </div>
          ) : null}
        </div>
      </main>
      <CreateArtifactModal
        artifactType={selectedArtifactType}
        onOpenChange={setCreateArtifactOpen}
        open={createArtifactOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <CreateFeatureModal
        onOpenChange={setCreateFeatureOpen}
        open={createFeatureOpen}
        projectId={projectId}
        teamId={teamId}
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
