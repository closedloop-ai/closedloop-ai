"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { MoreHorizontalIcon, StarIcon, TrashIcon } from "lucide-react";
import { useIsFavorite, useToggleFavorite } from "@/hooks/queries/use-projects";

type ProjectRowActionsProps = {
  projectId: string;
  onDelete: () => void;
};

export function ProjectRowActions({
  projectId,
  onDelete,
}: ProjectRowActionsProps) {
  const isFavorite = useIsFavorite(projectId);
  const toggleFavorite = useToggleFavorite();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-8 w-8" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => toggleFavorite.mutate({ projectId, isFavorite })}
        >
          <StarIcon
            className={`mr-2 h-4 w-4 ${isFavorite ? "fill-yellow-400 text-yellow-400" : ""}`}
          />
          {isFavorite ? "Remove from Favorites" : "Add to Favorites"}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onClick={onDelete}
        >
          <TrashIcon className="mr-2 h-4 w-4 text-destructive" />
          Delete project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
