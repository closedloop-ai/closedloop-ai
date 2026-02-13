"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
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
  artifact: Artifact;
  relatedArtifacts: Artifact[];
  onConfirm: (moveAll: boolean) => void;
};

export function MoveRelatedConfirmationDialog({
  open,
  onOpenChange,
  relatedArtifacts,
  onConfirm,
}: MoveRelatedConfirmationDialogProps) {
  const relatedCount = relatedArtifacts.length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move Related Artifacts?</DialogTitle>
          <DialogDescription>
            This artifact has {relatedCount} related{" "}
            {relatedCount === 1 ? "artifact" : "artifacts"}. Would you like to
            move them together?
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-2 font-medium text-sm">Related artifacts:</p>
          <ul className="list-inside list-disc space-y-1">
            {relatedArtifacts.map((related) => (
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
