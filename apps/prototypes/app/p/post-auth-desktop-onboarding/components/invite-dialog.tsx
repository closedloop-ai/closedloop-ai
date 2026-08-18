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
import { Input } from "@repo/design-system/components/ui/input";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

// The "Invite Team" component reused from the Pre-Auth Desktop Onboarding
// prototype (its web-app InviteDialog). Card #5's pop-up CTA opens this exact
// dialog.
type InviteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
};

export const InviteDialog = ({
  open,
  onOpenChange,
  workspaceName,
}: InviteDialogProps) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEmail("");
      setSent(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            Add someone to {workspaceName} so you can compare outcomes together.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckIcon className="size-4 text-success" />
            Invitation sent for {email}.
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSent(true);
            }}
          >
            <Input
              aria-label="Teammate email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@company.com"
              required
              type="email"
              value={email}
            />
            <DialogFooter className="mt-4">
              <Button type="submit">Send invite</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
