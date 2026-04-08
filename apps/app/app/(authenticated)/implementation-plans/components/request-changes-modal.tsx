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
  onSubmit: (changes: string) => Promise<boolean>;
  isSubmitting: boolean;
  description?: string;
  placeholder?: string;
};

export function RequestChangesModal({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  description,
  placeholder,
}: RequestChangesModalProps) {
  const [changes, setChanges] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
    if (!newOpen) {
      setChanges("");
      setError(null);
    }
  };

  const handleSubmit = async () => {
    if (!changes.trim()) {
      setError("Please describe the changes you want to make");
      return;
    }

    setError(null);

    const result = await onSubmit(changes.trim());
    if (result) {
      handleOpenChange(false);
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
            {description ??
              "Describe the changes you want to make to this implementation plan. The plan will be regenerated with your modifications."}
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
            placeholder={
              placeholder ??
              "Describe the changes you want to make to this plan..."
            }
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
                <LoaderIcon className="h-4 w-4 animate-spin" />
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
