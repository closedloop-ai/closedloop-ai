"use client";

import type { BackendMismatchBody } from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";

type BackendMismatchModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mismatchData: BackendMismatchBody | null;
  onConfirmOriginal: () => void;
  onConfirmPreferred: () => void;
};

/**
 * Modal shown when a state-dependent loop command targets a different backend
 * than the one used by the artifact's last completed loop.
 *
 * Three options:
 * - Execute on original backend: re-calls run-loop with originalComputeTargetId + backendOverride: true
 * - Execute on preferred backend (reset state): re-calls with preferred computeTargetId + backendOverride: true
 * - Cancel: dismisses without executing
 */
export function BackendMismatchModal({
  open,
  onOpenChange,
  mismatchData,
  onConfirmOriginal,
  onConfirmPreferred,
}: Readonly<BackendMismatchModalProps>) {
  const originalName =
    mismatchData?.originalComputeTargetName ?? "original backend";
  const preferredName = mismatchData?.preferredComputeTargetId
    ? "preferred backend"
    : "Cloud";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Backend mismatch detected</DialogTitle>
          <DialogDescription>
            This artifact was last executed on a different backend (
            {originalName}). Continuing on a different backend may cause
            unexpected behavior due to state differences.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <Button
            className="w-full justify-start"
            onClick={() => {
              onConfirmOriginal();
              onOpenChange(false);
            }}
            variant="outline"
          >
            <span className="flex flex-col items-start text-left">
              <span className="font-medium">Continue on {originalName}</span>
              <span className="font-normal text-muted-foreground text-xs">
                Execute on the same backend as last time
              </span>
            </span>
          </Button>

          <Button
            className="w-full justify-start"
            onClick={() => {
              onConfirmPreferred();
              onOpenChange(false);
            }}
            variant="outline"
          >
            <span className="flex flex-col items-start text-left">
              <span className="font-medium">Switch to {preferredName}</span>
              <span className="font-normal text-muted-foreground text-xs">
                Execute on your preferred backend — prior state will not carry
                over
              </span>
            </span>
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
