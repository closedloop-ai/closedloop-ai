"use client";

import type { Document } from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";

type MoveRelatedConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: Document;
  relatedDocuments: Document[];
  onConfirm: (moveAll: boolean) => void;
};

export function MoveRelatedConfirmationDialog({
  open,
  onOpenChange,
  relatedDocuments,
  onConfirm,
}: MoveRelatedConfirmationDialogProps) {
  const relatedCount = relatedDocuments.length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move Related Documents?</DialogTitle>
          <DialogDescription>
            This artifact has {relatedCount} related{" "}
            {relatedCount === 1 ? "artifact" : "documents"}. Would you like to
            move them together?
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-2 font-medium text-sm">Related artifacts:</p>
          <ul className="list-inside list-disc space-y-1">
            {relatedDocuments.map((related) => (
              <li className="text-muted-foreground text-sm" key={related.id}>
                {related.title}
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              onConfirm(false);
              onOpenChange(false);
            }}
            variant="outline"
          >
            Move this artifact only
          </Button>
          <Button
            onClick={() => {
              onConfirm(true);
              onOpenChange(false);
            }}
          >
            Move all related artifacts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
