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
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";
import { useState } from "react";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { useDeleteArtifact } from "@/hooks/queries/use-artifacts";
import { copyToClipboard } from "@/lib/clipboard-utils";
import { downloadAsMarkdown } from "@/lib/download-utils";

type PlanRowActionsProps = {
  plan: ArtifactWithWorkstream;
};

export function PlanRowActions({ plan }: PlanRowActionsProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const deleteArtifact = useDeleteArtifact();

  const handleExport = () => {
    downloadAsMarkdown(
      plan.content ?? "",
      plan.fileName ?? `${plan.title.toLowerCase().replaceAll(/\s+/g, "-")}.md`
    );
  };

  const handleCopyMarkdown = async () => {
    const success = await copyToClipboard(plan.content ?? "");
    if (success) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Failed to copy to clipboard");
    }
  };

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
          <DropdownMenuItem onClick={handleCopyMarkdown}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy MD
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleExport}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export .md
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
