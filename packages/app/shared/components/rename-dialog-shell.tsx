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
import type { FormEvent, ReactNode } from "react";

type RenameDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  onSubmit: () => Promise<void> | void;
  isPending?: boolean;
  canSave?: boolean;
};

export function RenameDialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  isPending = false,
  canSave = true,
}: Readonly<RenameDialogShellProps>) {
  const submitDisabled = isPending || !canSave;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) {
      return;
    }

    try {
      await onSubmit();
    } catch {
      // Failure surfaced by the mutation's onError handler; swallow here to
      // prevent an unhandled rejection from a future consumer.
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">{children}</div>
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={submitDisabled} type="submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
