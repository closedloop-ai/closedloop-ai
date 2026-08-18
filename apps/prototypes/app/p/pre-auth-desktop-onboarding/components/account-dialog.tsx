"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";

type AccountDialogProps = {
  onAuth: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export const AccountDialog = ({
  onAuth,
  onOpenChange,
  open,
}: AccountDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="text-xl">Create your account</DialogTitle>
        <DialogDescription className="text-pretty leading-relaxed">
          Sign up to see how your team uses AI and invite collaborators. Your
          agent session logs stay on this Mac.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 pt-2">
        <Button
          onClick={() => {
            onOpenChange(false);
            onAuth();
          }}
        >
          Sign Up
        </Button>
        <Button onClick={() => onOpenChange(false)} variant="ghost">
          Not now
        </Button>
      </div>
      <p className="text-center text-muted-foreground text-sm">
        Already have an account?{" "}
        <Button
          className="h-auto p-0 align-baseline text-foreground"
          onClick={() => {
            onOpenChange(false);
            onAuth();
          }}
          variant="link"
        >
          Sign in
        </Button>
      </p>
    </DialogContent>
  </Dialog>
);
