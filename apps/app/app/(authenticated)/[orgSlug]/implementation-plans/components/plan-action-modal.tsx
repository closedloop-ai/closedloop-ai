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
import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

type PlanActionModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon: ReactNode;
  description?: ReactNode;
  confirmIcon?: ReactNode;
  isLoading: boolean;
  isDisabled: boolean;
  onConfirm: () => void;
  confirmLabel: string;
  loadingLabel: string;
  children: ReactNode;
};

export function PlanActionModal({
  open,
  onOpenChange,
  title,
  icon,
  description,
  confirmIcon,
  isLoading,
  isDisabled,
  onConfirm,
  confirmLabel,
  loadingLabel,
  children,
}: PlanActionModalProps) {
  const buttonIcon = confirmIcon ?? icon;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              {icon}
              {title}
            </div>
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="py-4">{children}</div>

        <DialogFooter>
          <Button
            disabled={isLoading}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isDisabled} onClick={onConfirm}>
            {isLoading ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                {loadingLabel}
              </>
            ) : (
              <>
                {buttonIcon}
                {confirmLabel}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
