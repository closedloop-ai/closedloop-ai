"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  DownloadIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  TrashIcon,
  CopyIcon,
} from "lucide-react";
import { useState, useTransition } from "react";
import { deleteImplementationPlan, regenerateImplementationPlan } from "@/app/actions/implementation-plans";
import type { ImplementationPlan, PRD } from "@repo/database/generated/client";

type ImplementationPlanWithPRD = ImplementationPlan & {
  sourcePrd: Pick<PRD, "id" | "title">;
};

type ImplementationPlanRowActionsProps = {
  plan: ImplementationPlanWithPRD;
};

export function ImplementationPlanRowActions({ plan }: ImplementationPlanRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleRegenerate = () => {
    startTransition(async () => {
      await regenerateImplementationPlan(plan.id);
    });
  };

  const handleExport = () => {
    const blob = new Blob([plan.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${plan.title.toLowerCase().replace(/\s+/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(plan.content);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
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
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
            <MoreHorizontalIcon className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem onClick={handleRegenerate} disabled={isPending}>
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
            onClick={() => setShowDeleteDialog(true)}
            className="text-destructive focus:text-destructive"
          >
            <TrashIcon className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Implementation Plan</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{plan.title}"? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
