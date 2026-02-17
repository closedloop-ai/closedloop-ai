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
import {
  FolderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from "lucide-react";
import { useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import {
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";

type PRDRowActionsProps = {
  prd: ArtifactWithWorkstream;
};

export function PRDRowActions({ prd }: PRDRowActionsProps) {
  const updateArtifact = useUpdateArtifact();
  const deleteArtifact = useDeleteArtifact();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const isPending = updateArtifact.isPending || deleteArtifact.isPending;

  const handleRename = async (
    newTitle: string,
    newFileName: string
  ): Promise<boolean> => {
    const result = await updateArtifact.mutateAsync(
      { id: prd.id, title: newTitle, fileName: newFileName },
      {
        onSuccess: () => {
          setShowRenameDialog(false);
        },
      }
    );
    return !!result;
  };

  const handleDelete = async (): Promise<boolean> => {
    const result = await deleteArtifact.mutateAsync(prd.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
      },
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
          <DropdownMenuItem onClick={() => setShowRenameDialog(true)}>
            <PencilIcon className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
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

      <RenameDialog
        currentFileName={prd.fileName ?? ""}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={handleRename}
        open={showRenameDialog}
        title="Rename PRD"
      />

      <MoveArtifactDialog
        artifact={prd}
        onOpenChange={setShowMoveDialog}
        open={showMoveDialog}
      />

      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={prd.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="PRD"
      />
    </>
  );
}
