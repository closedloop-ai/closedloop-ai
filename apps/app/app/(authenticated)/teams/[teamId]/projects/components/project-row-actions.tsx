"use client";

import { ProjectStatus } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ArchiveIcon,
  MoreHorizontalIcon,
  StarIcon,
  TrashIcon,
} from "lucide-react";
import { useIsFavorite, useToggleFavorite } from "@/hooks/queries/use-projects";

type ProjectRowActionsProps = {
  projectId: string;
  status: ProjectStatus;
  onDelete: () => void;
  onUpdateStatus: (
    nextStatus: ProjectStatus,
    previousStatus: ProjectStatus
  ) => void;
};

export function ProjectRowActions({
  projectId,
  status,
  onDelete,
  onUpdateStatus,
}: ProjectRowActionsProps) {
  const isFavorite = useIsFavorite(projectId);
  const toggleFavorite = useToggleFavorite();
  const isArchived = status === ProjectStatus.Archived;
  const nextStatus = isArchived
    ? ProjectStatus.NotStarted
    : ProjectStatus.Archived;
  const archiveLabel = isArchived ? "Unarchive project" : "Archive project";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-8 w-8" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isArchived ? null : (
          <DropdownMenuItem
            disabled={toggleFavorite.isPending}
            onClick={() => toggleFavorite.mutate({ projectId, isFavorite })}
          >
            <StarIcon
              className={`h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
            />
            {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onUpdateStatus(nextStatus, status)}>
          <ArchiveIcon className="h-4 w-4" />
          {archiveLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDelete} variant="destructive">
          <TrashIcon className="h-4 w-4 text-destructive" />
          Delete project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
