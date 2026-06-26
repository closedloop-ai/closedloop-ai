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

type DeleteConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  itemName: string;
  onConfirm: () => Promise<boolean>;
  isPending?: boolean;
  /**
   * Overrides the default "Are you sure…? This action cannot be undone."
   * body. Use when the default copy would mislead — e.g. branch/PR deletes,
   * which only remove the Closedloop record, not the upstream GitHub PR.
   */
  description?: string;
};

export function DeleteConfirmationDialog({
  open,
  onOpenChange,
  title,
  itemName,
  onConfirm,
  isPending = false,
  description,
}: Readonly<DeleteConfirmationDialogProps>) {
  const handleDelete = async () => {
    try {
      const success = await onConfirm();
      // Only close on success: a falsy/failed result keeps the dialog open for
      // retry, matching the sibling ConfirmationDialog convention.
      if (success) {
        onOpenChange(false);
      }
    } catch {
      // The failure is already surfaced by the global mutation onError handler;
      // swallow it here so the unawaited onClick promise never rejects.
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {title}</DialogTitle>
          <DialogDescription>
            {description ??
              `Are you sure you want to delete "${itemName}"? This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isPending}
            onClick={handleDelete}
            variant="destructive"
          >
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
