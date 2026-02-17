"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FolderIcon, MoreHorizontalIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { useDeleteArtifact } from "@/hooks/queries/use-artifacts";

type PlanRowActionsProps = {
  plan: ArtifactWithWorkstream;
};

export function PlanRowActions({ plan }: PlanRowActionsProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const deleteArtifact = useDeleteArtifact();

  const handleDelete = async (): Promise<boolean> => {
    const result = await deleteArtifact.mutateAsync(plan.id, {
      onSuccess: () => setShowDeleteDialog(false),
    });
    return result.deleted ?? false;
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="h-8 w-8 p-0" size="sm" variant="ghost">
            <MoreHorizontalIcon className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem onClick={() => setShowMoveDialog(true)}>
            <FolderIcon className="mr-2 h-4 w-4" />
            Move...
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MoveArtifactDialog
        artifact={plan}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
      />

      <DeleteConfirmationDialog
        isPending={deleteArtifact.isPending}
        itemName={plan.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Implementation Plan"
      />
    </>
  );
}
