"use client";

import { DocumentType } from "@repo/api/src/types/document";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Loader2Icon, MoreHorizontalIcon, StarIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { buildProjectActiveSessionsHref } from "../../agents/lib/project-active-sessions";
import { CreateIssueModal } from "../../issues/components/create-issue-modal";
import { DeleteConfirmationDialog } from "../../shared/components/delete-confirmation-dialog";
import {
  HEADER_ICON_ACTION_PROPS,
  HeaderPrimaryAction,
} from "../../shared/components/header-primary-action";
import { useFeatureFlagGate } from "../../shared/feature-flags/use-feature-flag-enabled";
import { useTabParam } from "../../shared/hooks/use-tab-param";
import { useTeam } from "../../teams/hooks/use-teams";
import {
  projectTeamIdsOf,
  useProjectPermalinkCanonicalization,
} from "../hooks/use-project-permalink-canonicalization";
import {
  useProjectTreeRootPages,
  useProjectTreeWithDetails,
} from "../hooks/use-project-tree";
import {
  useDeleteProject,
  useIsFavorite,
  useProject,
  useProjectStatusHandler,
  useToggleFavorite,
  useUpdateProjectAssignee,
  useUpdateProjectPriority,
  useUpdateProjectTargetDate,
} from "../hooks/use-projects";
import { toProjectTreeCategory } from "../lib/project-artifacts-pagination";
import { CreateDocumentModal } from "./detail/create-document-modal";
import { OverviewProperties } from "./detail/overview-properties";
import { ProjectActiveSessionsStatus } from "./detail/project-active-sessions-status";
import { ProjectRenameDialog } from "./detail/project-rename-dialog";
import { EditableProjectDescription } from "./editable-project-description";
import { EditableProjectTitle } from "./editable-project-title";
import { ProjectArtifactList } from "./project-artifact-list";
import { ProjectTabsToggle, projectTabLabel } from "./project-tabs-toggle";

const PROJECT_TABS = [
  "all",
  "overview",
  "documents",
  "issues",
  "plans",
  "branches",
] as const;
const PROJECT_TREE_FILTER_CATEGORY = {
  all: "all",
  overview: "all",
  documents: "documents",
  issues: "features",
  plans: "plans",
  branches: "branches",
} as const;
export type ProjectDetailHeaderInput = {
  project: ProjectWithDetails;
  teamName: string;
  projectsHref: string;
  actions: ReactNode;
};

/** Project-owned behavior is shared; each shell supplies only its header chrome. */
export function ProjectDetailPage({
  teamId,
  projectId,
  renderHeader,
}: {
  teamId: string;
  projectId: string;
  renderHeader?: (input: ProjectDetailHeaderInput) => ReactNode;
}) {
  const projectRead = useProject(projectId);
  const teamRead = useTeam(teamId);
  const { enabled: hierarchyEnabled, isReady: hierarchyReady } =
    useFeatureFlagGate(MANUAL_ARTIFACT_ORDERING_FLAG_KEY);
  const project = projectRead.data;
  const orgPath = useOrgPath();
  const navigation = useNavigation();
  const projectsHref = orgPath(`/teams/${teamId}/projects`);
  const search = useSearchParamsValue().toString();
  const permalinkRedirect = useProjectPermalinkCanonicalization({
    orgSlug: null,
    requestedTeamId: teamId,
    projectId,
    projectTeamIds: projectTeamIdsOf(project),
    search,
    projectHref: (nextTeamId, id) =>
      orgPath(`/teams/${nextTeamId}/projects/${id}`),
  });
  const { activeTab, setActiveTab } = useTabParam({
    validTabs: PROJECT_TABS,
    defaultTab: "all",
    tabAliases: { features: "issues" },
  });
  const treeCategory = toProjectTreeCategory(
    PROJECT_TREE_FILTER_CATEGORY[activeTab]
  );
  const useHierarchyTree = hierarchyEnabled && treeCategory === null;
  const tree = useProjectTreeWithDetails(projectId, {
    enabled: hierarchyReady && !useHierarchyTree,
    filters: { includeHierarchyRevision: true },
  });
  const hierarchyTree = useProjectTreeRootPages(projectId, {
    enabled: hierarchyReady && useHierarchyTree,
  });
  const artifactTreeData = useHierarchyTree ? hierarchyTree.data : tree.data;
  const artifactTreeFailed = selectProjectTreeValue(
    useHierarchyTree,
    hierarchyTree.isError,
    tree.isError
  );
  const artifactTreeLoading =
    !hierarchyReady ||
    (useHierarchyTree ? hierarchyTree.isLoading : tree.isLoading);
  const refreshArtifactTree = async () =>
    useHierarchyTree
      ? hierarchyTree.refetchMerged()
      : (await tree.refetch()).data;
  const retryArtifactTree = () => {
    if (useHierarchyTree) {
      hierarchyTree.refetch();
    } else {
      tree.refetch();
    }
  };
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [documentType, setDocumentType] = useState<DocumentType>(
    DocumentType.Prd
  );
  const [createDocumentOpen, setCreateDocumentOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const favorite = useIsFavorite(projectId);
  const toggleFavorite = useToggleFavorite();
  const status = useProjectStatusHandler({
    onArchived: () => navigation.navigate(projectsHref),
  });
  const remove = useDeleteProject();
  const owner = useUpdateProjectAssignee();
  const priority = useUpdateProjectPriority();
  const dueDate = useUpdateProjectTargetDate();
  if (permalinkRedirect || projectRead.isLoading || teamRead.isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status">
        <Loader2Icon aria-hidden className="size-6 animate-spin" />
        <span className="sr-only">Loading project</span>
      </div>
    );
  }
  if (projectRead.error || !project || !teamRead.data) {
    return (
      <div className="p-4" role="alert">
        {projectRead.error?.message ??
          teamRead.error?.message ??
          "Project not found"}
      </div>
    );
  }
  const actions = (
    <>
      <Button
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        disabled={
          toggleFavorite.isPending || project.status === ProjectStatus.Archived
        }
        onClick={() =>
          toggleFavorite.mutate({ projectId, isFavorite: favorite })
        }
        {...HEADER_ICON_ACTION_PROPS}
      >
        <StarIcon className={favorite ? "fill-current" : ""} />
      </Button>
      <HeaderPrimaryAction
        label="Add issue"
        onClick={() => setCreateIssueOpen(true)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="Actions" {...HEADER_ICON_ACTION_PROPS}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            onValueChange={setActiveTab}
            value={activeTab}
          >
            {PROJECT_TABS.map((tab) => (
              <DropdownMenuRadioItem key={tab} value={tab}>
                {projectTabLabel(tab)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setRenameOpen(true)}>
            Rename Project
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDocumentType(DocumentType.Prd);
              setCreateDocumentOpen(true);
            }}
          >
            Create PRD
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setDocumentType(DocumentType.ImplementationPlan);
              setCreateDocumentOpen(true);
            }}
          >
            Create Implementation Plan
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={status.isPending}
            onClick={() =>
              status.handleUpdateStatus(
                projectId,
                project.status === ProjectStatus.Archived
                  ? ProjectStatus.NotStarted
                  : ProjectStatus.Archived,
                project.status
              )
            }
          >
            {project.status === ProjectStatus.Archived
              ? "Unarchive Project"
              : "Archive Project"}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={orgPath(`/teams/${teamId}/projects/archived`)}>
              Archived Projects
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setDeleteOpen(true)}
            variant="destructive"
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {renderHeader ? (
        renderHeader({
          project,
          teamName: teamRead.data.name,
          projectsHref,
          actions,
        })
      ) : (
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Link href={projectsHref}>{teamRead.data.name}</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="truncate font-medium text-sm">{project.name}</h1>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className="border-b px-4 py-3">
        <ProjectTabsToggle activeTab={activeTab} onTabChange={setActiveTab} />
      </div>
      <ProjectActiveSessionsStatus
        orgSlug=""
        projectId={projectId}
        sessionsHref={orgPath(
          buildProjectActiveSessionsHref("", projectId).slice(1)
        )}
      />
      {activeTab === "overview" ? (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
            <div className="flex flex-col gap-2">
              <EditableProjectTitle
                initialTitle={project.name}
                projectId={projectId}
              />
              <EditableProjectDescription
                initialDescription={project.description ?? ""}
                projectId={projectId}
              />
            </div>
            <OverviewProperties
              onUpdateAssignee={(assigneeId) =>
                owner.mutate({ projectId, assigneeId })
              }
              onUpdatePriority={(value) =>
                priority.mutate({ projectId, priority: value })
              }
              onUpdateTargetDate={(targetDate) =>
                dueDate.mutate({ projectId, targetDate })
              }
              project={project}
            />
          </div>
        </div>
      ) : (
        <ProjectArtifactList
          category={activeTab}
          failed={artifactTreeFailed}
          hasMoreRootPages={
            useHierarchyTree && hierarchyTree.hasNextPage === true
          }
          isLoadingMoreRootPages={
            useHierarchyTree && hierarchyTree.isFetchingNextPage
          }
          loading={artifactTreeLoading}
          loadMoreRootPages={hierarchyTree.loadMore}
          onRefresh={refreshArtifactTree}
          onRequestCreate={() => setCreateIssueOpen(true)}
          onRetry={retryArtifactTree}
          project={project}
          teamId={teamId}
          tree={artifactTreeData}
        />
      )}
      <CreateIssueModal
        onOpenChange={setCreateIssueOpen}
        open={createIssueOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <CreateDocumentModal
        documentType={documentType}
        onOpenChange={setCreateDocumentOpen}
        open={createDocumentOpen}
        projectId={projectId}
        teamId={teamId}
      />
      <ProjectRenameDialog
        currentName={project.name}
        onOpenChange={setRenameOpen}
        open={renameOpen}
        projectId={projectId}
      />
      <DeleteConfirmationDialog
        isPending={remove.isPending}
        itemName={project.name}
        onConfirm={async () => {
          await remove.mutateAsync(projectId);
          navigation.navigate(projectsHref);
          return true;
        }}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title="Project"
      />
    </div>
  );
}

function selectProjectTreeValue<T>(
  useHierarchyTree: boolean,
  hierarchyValue: T,
  flatValue: T
): T {
  return useHierarchyTree ? hierarchyValue : flatValue;
}
