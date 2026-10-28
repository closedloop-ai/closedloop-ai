"use client";

import { DocumentType } from "@repo/api/src/types/document";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import { HEADER_ICON_ACTION_PROPS } from "@repo/app/shared/components/header-primary-action";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ArchiveIcon,
  BoxIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FileIcon,
  MoreHorizontalIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { Header } from "@/app/(authenticated)/components/header";

/** Render the legacy detail header with its existing project actions and labels. */
export function ProjectDetailHeader({
  favoritesDisabled,
  isFavorite,
  onCreateArtifact,
  onCreateFeature,
  onDelete,
  onRename,
  onToggleFavorite,
  onUpdateStatus,
  orgSlug,
  project,
  statusPending,
  teamId,
  teamName,
}: {
  favoritesDisabled: boolean;
  isFavorite: boolean;
  onCreateArtifact: (type: DocumentType) => void;
  onCreateFeature: () => void;
  onDelete: () => void;
  onRename: () => void;
  onToggleFavorite: () => void;
  onUpdateStatus: (status: ProjectStatus) => void;
  orgSlug: string;
  project: ProjectWithDetails;
  statusPending: boolean;
  teamId: string;
  teamName: string;
}) {
  const archiveAction = project.status === ProjectStatus.Archived;
  return (
    <Header
      afterBreadcrumbs={
        <Button
          {...HEADER_ICON_ACTION_PROPS}
          disabled={favoritesDisabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleFavorite();
          }}
        >
          <StarIcon
            className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`}
          />
          <span className="sr-only">
            {getFavoriteButtonLabel(project.status, isFavorite)}
          </span>
        </Button>
      }
      breadcrumbs={[
        { label: teamName, href: `/${orgSlug}/teams/${teamId}/projects` },
        { label: project.name },
      ]}
      moreMenu={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button {...HEADER_ICON_ACTION_PROPS}>
              <MoreHorizontalIcon className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={favoritesDisabled}
              onClick={onToggleFavorite}
            >
              <StarIcon
                className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
              />
              {getFavoriteMenuLabel(project.status, isFavorite)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRename}>
              <PencilIcon className="h-4 w-4" />
              Rename Project
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={statusPending}
              onClick={() =>
                onUpdateStatus(
                  archiveAction
                    ? ProjectStatus.NotStarted
                    : ProjectStatus.Archived
                )
              }
            >
              <ArchiveIcon className="h-4 w-4" />
              {archiveAction ? "Unarchive Project" : "Archive Project"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} variant="destructive">
              <TrashIcon className="h-4 w-4 text-destructive" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onCreateArtifact(DocumentType.Prd)}>
            <FileIcon className="h-4 w-4" />
            Create PRD
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCreateFeature}>
            <BoxIcon className="h-4 w-4" />
            Create Issue
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onCreateArtifact(DocumentType.ImplementationPlan)}
          >
            <FileCode2Icon className="h-4 w-4" />
            Create Implementation Plan
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Header>
  );
}

function getFavoriteButtonLabel(status: ProjectStatus, isFavorite: boolean) {
  if (status === ProjectStatus.Archived) {
    return "Archived projects cannot be favorited";
  }
  if (isFavorite) {
    return "Remove from favorites";
  }
  return "Add to favorites";
}

function getFavoriteMenuLabel(status: ProjectStatus, isFavorite: boolean) {
  if (status === ProjectStatus.Archived) {
    return "Favorites unavailable while archived";
  }
  if (isFavorite) {
    return "Remove from Favorites";
  }
  return "Add to Favorites";
}
