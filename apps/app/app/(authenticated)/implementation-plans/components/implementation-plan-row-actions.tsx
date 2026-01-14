"use client";

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
  MoreHorizontalIcon,
  RefreshCwIcon,
  TrashIcon,
} from "lucide-react";
import { useState, useTransition } from "react";
import {
  deleteImplementationPlan,
  regenerateImplementationPlan,
} from "@/app/actions/implementation-plans";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import type { ImplementationPlanWithPRD } from "@/lib/types";
import { copyToClipboard, downloadAsMarkdown } from "@/lib/utils";

type ImplementationPlanRowActionsProps = {
  plan: ImplementationPlanWithPRD;
};

export function ImplementationPlanRowActions({
  plan,
}: ImplementationPlanRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleRegenerate = () => {
    startTransition(async () => {
      await regenerateImplementationPlan(plan.id);
    });
  };

  const handleExport = () => {
    downloadAsMarkdown(
      plan.content,
      `${plan.title.toLowerCase().replace(/\s+/g, "-")}.md`
    );
  };

  const handleCopyMarkdown = async () => {
    const success = await copyToClipboard(plan.content);
    if (success) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleDelete = () => {
    startTransition(async () => {
      await deleteImplementationPlan(plan.id);
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
          <DropdownMenuItem disabled={isPending} onClick={handleRegenerate}>
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Regenerate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCopyMarkdown}>
            <CopyIcon className="mr-2 h-4 w-4" />
            Copy MD
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

      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={plan.title}
        onConfirm={handleDelete}
        onOpenChange={setShowDeleteDialog}
        open={showDeleteDialog}
        title="Implementation Plan"
      />
    </>
  );
}
