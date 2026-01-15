"use client";

import type { Prd } from "@repo/api/src/types/prd";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  TrashIcon,
} from "lucide-react";
import { useState, useTransition } from "react";
import { deletePRD, duplicatePRD, renamePRD } from "@/app/actions/prds";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { downloadAsMarkdown } from "@/lib/clipboard-and-download-utils";

type PRDRowActionsProps = {
  prd: Prd;
};

export function PRDRowActions({ prd }: PRDRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleRename = (newTitle: string, newFileName: string) => {
    startTransition(async () => {
      await renamePRD(prd.id, newTitle, newFileName);
      setShowRenameDialog(false);
    });
  };

  const handleDuplicate = () => {
    startTransition(async () => {
      await duplicatePRD(prd.id);
    });
  };

  const handleExport = () => {
    downloadAsMarkdown(prd.content, prd.fileName);
  };

  const handleDelete = () => {
    startTransition(async () => {
      await deletePRD(prd.id);
      setShowDeleteDialog(false);
    });
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
          <DropdownMenuItem disabled={isPending} onClick={handleDuplicate}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleExport}>
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export .md
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
        currentFileName={prd.fileName}
        currentTitle={prd.title}
        description="Update the title and file name for this PRD."
        isPending={isPending}
        onOpenChange={setShowRenameDialog}
        onRename={handleRename}
        open={showRenameDialog}
        title="Rename PRD"
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
