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
import { LoaderIcon, PlayIcon } from "lucide-react";

type ExecutePlanModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<boolean>;
  isLoading: boolean;
};

export function ExecutePlanModal({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
}: ExecutePlanModalProps) {
  const handleConfirm = async () => {
    const success = await onConfirm();
    if (success) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <PlayIcon className="h-5 w-5" />
              Execute Implementation Plan
            </div>
          </DialogTitle>
          <DialogDescription>
            This will generate code based on the implementation plan and create
            a pull request for review.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <p className="text-muted-foreground text-sm">
            A new branch will be created with the generated code changes. You
            can review and merge the PR once it&apos;s ready.
          </p>
        </div>

        <DialogFooter>
          <Button
            disabled={isLoading}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isLoading} onClick={handleConfirm}>
            {isLoading ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Starting Execution...
              </>
            ) : (
              <>
                <PlayIcon className="mr-2 h-4 w-4" />
                Execute Plan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
