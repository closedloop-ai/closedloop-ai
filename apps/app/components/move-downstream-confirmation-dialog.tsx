"use client";

import type { ArtifactLinkWithEndpoints } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";

type MoveDownstreamConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downstreamEntities: ArtifactLinkWithEndpoints[];
  onConfirm: (moveAll: boolean) => void;
};

export function MoveDownstreamConfirmationDialog({
  open,
  onOpenChange,
  downstreamEntities,
  onConfirm,
}: Readonly<MoveDownstreamConfirmationDialogProps>) {
  const count = downstreamEntities.length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move Downstream Entities?</DialogTitle>
          <DialogDescription>
            This entity has {count} downstream{" "}
            {count === 1 ? "entity" : "entities"} linked to it. Would you like
            to move them together?
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-2 font-medium text-sm">Downstream entities:</p>
          <ul className="list-inside list-disc space-y-1">
            {downstreamEntities.map((link) => {
              return (
                <li className="text-muted-foreground text-sm" key={link.id}>
                  {link.target.name}
                </li>
              );
            })}
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
            Move this only
          </Button>
          <Button
            onClick={() => {
              onConfirm(true);
              onOpenChange(false);
            }}
          >
            Move all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
