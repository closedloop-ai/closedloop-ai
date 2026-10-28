"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { useFavoriteArtifacts } from "@repo/app/documents/hooks/use-artifact-favorites";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { projectArtifactListRow } from "@repo/app/projects/lib/project-artifact-list-adapter";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { FolderInputIcon, XIcon } from "lucide-react";
import { ProjectRegisteredSelectionActions } from "./project-registered-selection-actions";

/** Selection rail shared by pointer, keyboard, menu, and cross-project moves. */
export function ProjectArtifactBoardSelectionActions({
  currentProjectId,
  onClear,
  onMoveToProject,
  pending,
  project,
  projects,
  selectedArtifacts,
  selectedCount,
  onRetain,
  users,
}: Readonly<{
  currentProjectId: string;
  onClear: () => void;
  onMoveToProject: (
    projectId: string,
    rowIds?: readonly string[]
  ) => Promise<void>;
  onRetain: (ids: readonly string[]) => void;
  pending: boolean;
  project: DocumentRowData["project"];
  projects: readonly ProjectWithDetails[];
  selectedArtifacts: readonly DetailedArtifact[];
  selectedCount: number;
  users?: readonly User[];
}>) {
  const enabled = useFeatureFlagEnabledOptional(
    ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY
  );
  if (selectedCount === 0) {
    return null;
  }
  const destinations = projects.filter(
    (project) => project.id !== currentProjectId
  );
  if (enabled && !pending && selectedArtifacts.length === selectedCount) {
    return (
      <RegisteredBoardSelectionActions
        destinations={destinations}
        onClear={onClear}
        onMoveToProject={onMoveToProject}
        onRetain={onRetain}
        project={project}
        selectedArtifacts={selectedArtifacts}
        users={users ?? []}
      />
    );
  }
  return (
    <div
      className="flex items-center gap-2 border-b px-4 py-2"
      data-preserve-artifact-selection=""
    >
      <span className="text-muted-foreground text-sm">
        {selectedCount} {selectedCount === 1 ? "artifact" : "artifacts"}{" "}
        selected
      </span>
      {destinations.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={pending} size="sm" variant="outline">
              <FolderInputIcon />
              Move to project
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {destinations.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() =>
                  onMoveToProject(project.id).catch(() => undefined)
                }
              >
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        aria-label="Clear selection"
        disabled={pending}
        onClick={onClear}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
}

function RegisteredBoardSelectionActions({
  destinations,
  onClear,
  onMoveToProject,
  onRetain,
  project,
  selectedArtifacts,
  users,
}: {
  destinations: readonly ProjectWithDetails[];
  onClear: () => void;
  onMoveToProject: (
    projectId: string,
    rowIds?: readonly string[]
  ) => Promise<void>;
  onRetain: (ids: readonly string[]) => void;
  project: DocumentRowData["project"];
  selectedArtifacts: readonly DetailedArtifact[];
  users: readonly User[];
}) {
  const favorites = useFavoriteArtifacts();
  const favoriteIds = new Set(
    favorites.data?.map((artifact) => artifact.id) ?? []
  );
  const artifactsById = new Map(
    selectedArtifacts.map((artifact) => [artifact.id, artifact])
  );
  const selectedRows = selectedArtifacts.map((artifact) =>
    projectArtifactListRow(artifact, null, project?.name ?? "", Date.now())
  );
  return (
    <ProjectRegisteredSelectionActions
      artifactsById={artifactsById}
      favoriteIds={favoriteIds}
      favoritesLoaded={favorites.data !== undefined}
      moveEnabled={destinations.length > 0}
      onClear={onClear}
      onMove={onMoveToProject}
      onRetain={onRetain}
      project={project}
      projects={destinations}
      selectedRows={selectedRows}
      users={users}
    />
  );
}
