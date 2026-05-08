"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { Button } from "./button";
import { LoaderIcon } from "lucide-react";

type FormModalProps = {
  trigger: React.ReactNode;
  title: string;
  children: React.ReactNode;
  submitLabel?: string;
  submitLoadingLabel?: string;
  onSubmit: () => void | Promise<void>;
  isSubmitting?: boolean;
  isSubmitDisabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  error?: string | null;
  maxWidth?: string;
};

export function FormModal({
  trigger,
  title,
  children,
  submitLabel = "Submit",
  submitLoadingLabel = "Submitting...",
  onSubmit,
  isSubmitting = false,
  isSubmitDisabled = false,
  open,
  onOpenChange,
  error,
  maxWidth = "sm:max-w-[500px]",
}: FormModalProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setIsOpen = isControlled ? onOpenChange! : setInternalOpen;

  const handleSubmit = async () => {
    await onSubmit();
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={`${maxWidth} max-h-[90vh] overflow-y-auto`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="py-4">
          {error && (
            <div className="mb-4 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              {error}
            </div>
          )}
          {children}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || isSubmitDisabled}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                {submitLoadingLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
