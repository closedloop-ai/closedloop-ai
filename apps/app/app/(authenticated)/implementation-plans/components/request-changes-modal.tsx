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
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { LoaderIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

type RequestChangesModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (changes: string) => Promise<void>;
  isSubmitting: boolean;
};

export function RequestChangesModal({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
}: RequestChangesModalProps) {
  const [changes, setChanges] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!changes.trim()) {
      setError("Please describe the changes you want to make");
      return;
    }

    setError(null);
    try {
      await onSubmit(changes.trim());
      setChanges("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to submit change request"
      );
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      setChanges("");
      setError(null);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <MessageSquareIcon className="h-5 w-5" />
              Request Changes
            </div>
          </DialogTitle>
          <DialogDescription>
            Describe the changes you want to make to this implementation plan.
            The plan will be regenerated with your modifications.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div
              className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <Textarea
            className="min-h-[150px]"
            disabled={isSubmitting}
            onChange={(e) => setChanges(e.target.value)}
            placeholder="Describe the changes you want to make to this plan..."
            value={changes}
          />
        </div>

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={isSubmitting || !changes.trim()}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              "Request Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
