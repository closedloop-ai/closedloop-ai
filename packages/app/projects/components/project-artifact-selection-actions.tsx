"use client";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  TableBulkActionBar,
  TableBulkActionButton,
} from "@repo/design-system/components/ui/table-bulk-action-bar";
import { FolderInputIcon, StarIcon, XIcon } from "lucide-react";
export function ProjectSelectionActions({
  selectedIds,
  projects,
  onClear,
  onMove,
  onFavorite,
  moveEnabled = true,
}: {
  selectedIds: ReadonlySet<string>;
  projects: ProjectWithDetails[];
  onClear: () => void;
  onMove: (id: string) => Promise<unknown>;
  onFavorite: () => void;
  moveEnabled?: boolean;
}) {
  if (selectedIds.size === 0) {
    return null;
  }
  return (
    <div data-preserve-artifact-selection="">
      <TableBulkActionBar
        actionLabel={`${selectedIds.size} ${selectedIds.size === 1 ? "artifact" : "artifacts"} selected`}
        actions={
          <>
            <TableBulkActionButton label="Favorite" onClick={onFavorite}>
              <StarIcon />
            </TableBulkActionButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Move to project"
                  disabled={!moveEnabled}
                  variant="ghost"
                >
                  <FolderInputIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent data-preserve-artifact-selection="">
                {projects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => onMove(project.id).catch(() => undefined)}
                  >
                    {project.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <TableBulkActionButton label="Clear selection" onClick={onClear}>
              <XIcon />
            </TableBulkActionButton>
          </>
        }
      />
    </div>
  );
}
