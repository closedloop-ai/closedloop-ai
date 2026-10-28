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
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";

/**
 * Names a new key and asks for it (ISS-8369).
 *
 * The failure toast is a fixed string on purpose: the create response is the one
 * place a plaintext secret exists, so interpolating anything derived from a
 * failed attempt is how a secret would reach a toast, and from there a
 * screenshot or a session replay. The caller owns the success path, because the
 * secret must go straight into the one-time dialog and nowhere else.
 */
export function CreateApiKeyDialog({
  open,
  isPending,
  onOpenChange,
  onCreate,
}: Readonly<{
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}>) {
  const [name, setName] = useState("");
  const trimmedName = name.trim();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmedName === "") {
      return;
    }
    try {
      await onCreate(trimmedName);
      setName("");
    } catch {
      toast.error("Couldn't create that API key");
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Name it for where you will use it, so you can tell which one to
            revoke later. New keys get full read, write, and delete access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-2 py-2">
            <Label htmlFor="new-api-key-name">Name</Label>
            <Input
              autoFocus
              id="new-api-key-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. CI pipeline"
              value={name}
            />
          </div>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={trimmedName === "" || isPending} type="submit">
              {isPending ? (
                <>
                  <Loader2Icon aria-hidden="true" className="animate-spin" />
                  Creating…
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
