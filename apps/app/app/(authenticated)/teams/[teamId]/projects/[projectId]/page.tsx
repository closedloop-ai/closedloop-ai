"use client";

import {
  type ArtifactStatus,
  ArtifactType,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { FeatureStatus } from "@repo/api/src/types/feature";
import type { WorkstreamState } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
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
  SearchIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import type { RowEditHandlers } from "@/components/artifact-table/artifact-row";
import { ColumnVisibilityPanel } from "@/components/artifact-table/column-visibility-panel";
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
  useDeleteFeature,
  useFeatures,
  useUpdateFeature,
} from "@/hooks/queries/use-features";
import { useLoopsByProject } from "@/hooks/queries/use-loops";
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
import {
  ArtifactColumn,
  type ColumnVisibility,
  useColumnVisibility,
} from "@/hooks/use-column-visibility";
import { useTabParam } from "@/hooks/use-tab-param";
import { useTeamMembers } from "@/hooks/use-team-members";
import { ACTIVE_LOOP_STATUSES } from "@/lib/loop-constants";
import { ActiveLoopsStatus } from "./components/active-loops-status";
import { ArtifactsView } from "./components/artifacts-view";
import { CreateArtifactModal } from "./components/create-artifact-modal";
import { CreateFeatureModal } from "./components/create-feature-modal";
import { OverviewActivity } from "./components/overview-activity";
import { OverviewProperties } from "./components/overview-properties";
import { useMergeNotification } from "./hooks/use-merge-notification";

export type FilterCategory =
  | "all"
  | "documents"
  | "features"
  | "plans"
  | "branches";

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
    validTabs: ["overview", "artifacts", "workflows"] as const,
    defaultTab: "artifacts",
  });
  const [createArtifactOpen, setCreateArtifactOpen] = useState(false);
  const [createFeatureOpen, setCreateFeatureOpen] = useState(false);
  const [selectedArtifactType, setSelectedArtifactType] =
    useState<ArtifactType>(ArtifactType.Prd);
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const [filterText, setFilterText] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Column visibility — override based on active filter category
  const columnOverrides = useMemo((): Partial<ColumnVisibility> => {
    switch (filterCategory) {
      case "documents":
      case "features":
      case "plans":
      case "branches":
        return { [ArtifactColumn.Type]: false };
      default:
        return {};
    }
  }, [filterCategory]);
  const { userVisibility, visibleColumns, toggleColumn } =
    useColumnVisibility(columnOverrides);
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

  const { data: features = [], isLoading: loadingFeatures } = useFeatures({
    projectId,
  });

  const { data: loops = [] } = useLoopsByProject(projectId, {
    refetchInterval: 10_000,
  });
  const activeLoops = useMemo(
    () => loops.filter((l) => ACTIVE_LOOP_STATUSES.has(l.status)),
    [loops]
  );

  const team = teamData ? { id: teamData.id, name: teamData.name } : null;
  const activities = activityData?.activities ?? [];

  const hasArtifactItems = artifacts.length > 0 || features.length > 0;

  const loading =
    loadingTeam ||
    loadingProject ||
    loadingActivity ||
    loadingArtifacts ||
    loadingFeatures;
  const error = teamError?.message || projectError?.message || null;

  // Team members for inline editing
  const { members: teamMembers } = useTeamMembers({
    teamIds: teamData ? [teamData.id] : [],
  });

  // Mutations
  const updatePriorityMutation = useUpdateProjectPriority();
  const updateAssigneeMutation = useUpdateProjectAssignee();
  const updateTargetDateMutation = useUpdateProjectTargetDate();
  const updateArtifactMutation = useUpdateArtifact();
  const updateFeatureMutation = useUpdateFeature();
  const deleteArtifactMutation = useDeleteArtifact();
  const deleteFeatureMutation = useDeleteFeature();

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

  const handleDeleteArtifact = async (
    item: import("@/components/artifact-table/artifact-row").ArtifactRowItem
  ): Promise<boolean> => {
    if (item.kind === "feature") {
      const result = await deleteFeatureMutation.mutateAsync(item.data.id);
      return result.deleted ?? false;
    }
    const result = await deleteArtifactMutation.mutateAsync(item.data.id);
    return result.deleted ?? false;
  };

  // Inline cell edit handlers for artifact rows
  const artifactEditHandlers = useMemo(
    (): RowEditHandlers => ({
      teamMembers,
      activeLoops,
      onUpdateAssignee: (itemId, assigneeId) => {
        // Determine if it's an artifact or issue by checking both lists
        const isArtifact = artifacts.some((a) => a.id === itemId);
        if (isArtifact) {
          updateArtifactMutation.mutate({ id: itemId, assigneeId });
        } else {
          updateFeatureMutation.mutate({ id: itemId, assigneeId });
        }
      },
      onUpdatePriority: (itemId, priority) => {
        updateFeatureMutation.mutate({ id: itemId, priority });
      },
      onUpdateDueDate: (_itemId, _date) => {
        // Due date update not yet supported on artifacts/issues — placeholder
      },
      onUpdateStatus: (itemId, status) => {
        const isArtifact = artifacts.some((a) => a.id === itemId);
        if (isArtifact) {
          updateArtifactMutation.mutate({
            id: itemId,
            status: status as ArtifactStatus,
          });
        } else {
          updateFeatureMutation.mutate({
            id: itemId,
            status: status as FeatureStatus,
          });
        }
      },
    }),
    [
      teamMembers,
      activeLoops,
      artifacts,
      updateArtifactMutation,
      updateFeatureMutation,
    ]
  );

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
              <ChevronDownIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => handleCreateArtifact(ArtifactType.Prd)}
            >
              <FileIcon className="h-4 w-4" />
              Create PRD
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFeatureOpen(true)}>
              <BoxIcon className="h-4 w-4" />
              Create Feature
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                handleCreateArtifact(ArtifactType.ImplementationPlan)
              }
            >
              <FileCode2Icon className="h-4 w-4" />
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
                className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
              />
              {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setDeleteDialogOpen(true)}
              variant="destructive"
            >
              <TrashIcon className="h-4 w-4 text-destructive" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Header>
      <Tabs
        className="flex flex-1 flex-col gap-0 overflow-hidden"
        onValueChange={setActiveTab}
        value={activeTab}
      >
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="overview">Overview</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="artifacts">
            Artifacts
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="workflows">
            Workflows
          </UnderlineTabsTrigger>
        </UnderlineTabsList>
        {activeTab === "artifacts" && hasArtifactItems && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <ToggleGroup
              onValueChange={(value) => {
                if (value) {
                  setFilterCategory(value as FilterCategory);
                }
              }}
              type="single"
              value={filterCategory}
              variant="outline"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="documents">PRDs</ToggleGroupItem>
              <ToggleGroupItem value="features">Features</ToggleGroupItem>
              <ToggleGroupItem value="plans">Plans</ToggleGroupItem>
              <ToggleGroupItem value="branches">Branches</ToggleGroupItem>
            </ToggleGroup>
            <div className="flex items-center gap-2">
              <div className="relative min-w-[200px] max-w-[350px]">
                <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                  <SearchIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <Input
                  aria-label="Filter items"
                  className="pl-9 shadow-none"
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter items..."
                  value={filterText}
                />
              </div>
              <ColumnVisibilityPanel
                onToggle={toggleColumn}
                visibility={userVisibility}
              />
            </div>
          </div>
        )}
        <main className="flex-1 overflow-auto">
          <ActiveLoopsStatus projectId={projectId} />
          <TabsContent
            className="mx-auto mt-0 flex max-w-[950px] flex-col gap-10 p-6"
            value="overview"
          >
            <div className="flex flex-col gap-2">
              <EditableProjectTitle
                initialTitle={project.name}
                projectId={project.id}
              />
              <EditableProjectDescription
                initialDescription={project.description ?? ""}
                projectId={project.id}
              />
            </div>
            <OverviewProperties
              onUpdateAssignee={handleUpdateAssignee}
              onUpdatePriority={handleUpdatePriority}
              onUpdateTargetDate={handleUpdateTargetDate}
              project={project}
            />
            <OverviewActivity activities={activities} />
          </TabsContent>
          <TabsContent className="mt-0 p-6" value="workflows">
            <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
              Workflows coming soon
            </div>
          </TabsContent>
          <TabsContent className="mt-0 min-w-fit" value="artifacts">
            <ArtifactsView
              artifacts={artifacts}
              editHandlers={artifactEditHandlers}
              features={features}
              filterCategory={filterCategory}
              filterText={filterText}
              onDelete={handleDeleteArtifact}
              onStatusChange={handleArtifactStatusChange}
              projectId={projectId}
              visibleColumns={visibleColumns}
            />
          </TabsContent>
        </main>
      </Tabs>
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
