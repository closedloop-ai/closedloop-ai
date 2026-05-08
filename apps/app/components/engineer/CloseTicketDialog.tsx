"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

type CloseTicketDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  changedFiles: {
    modified: string[];
    created: string[];
    deleted: string[];
    staged: string[];
  };
  onConfirmClose: (removeWorktree: boolean) => void;
};

/**
 * Confirmation dialog shown when closing a ticket that has uncommitted changes.
 * Gives the user the option to keep or remove the worktree.
 */
export function CloseTicketDialog({
  open,
  onOpenChange,
  ticketId,
  changedFiles,
  onConfirmClose,
}: Readonly<CloseTicketDialogProps>) {
  const totalChanges =
    changedFiles.modified.length +
    changedFiles.created.length +
    changedFiles.deleted.length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" />
            Uncommitted Changes
          </DialogTitle>
          <DialogDescription>
            The worktree for <strong>{ticketId}</strong> has uncommitted
            changes. What would you like to do?
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg bg-muted/50 p-3 text-sm">
          <div className="mb-2 font-medium">
            Changed files ({totalChanges}):
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto overflow-x-hidden text-muted-foreground">
            {changedFiles.modified.map((file) => (
              <li
                className="flex min-w-0 items-center gap-2"
                key={file}
                title={file}
              >
                <span className="shrink-0 font-mono text-amber-500 text-xs">
                  M
                </span>
                <span className="truncate">{file}</span>
              </li>
            ))}
            {changedFiles.created.map((file) => (
              <li
                className="flex min-w-0 items-center gap-2"
                key={file}
                title={file}
              >
                <span className="shrink-0 font-mono text-green-500 text-xs">
                  A
                </span>
                <span className="truncate">{file}</span>
              </li>
            ))}
            {changedFiles.deleted.map((file) => (
              <li
                className="flex min-w-0 items-center gap-2"
                key={file}
                title={file}
              >
                <span className="shrink-0 font-mono text-red-500 text-xs">
                  D
                </span>
                <span className="truncate">{file}</span>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            onClick={() => {
              onConfirmClose(false);
              onOpenChange(false);
            }}
            variant="outline"
          >
            Keep Worktree
          </Button>
          <Button
            onClick={() => {
              onConfirmClose(true);
              onOpenChange(false);
            }}
            variant="destructive"
          >
            Remove Worktree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
