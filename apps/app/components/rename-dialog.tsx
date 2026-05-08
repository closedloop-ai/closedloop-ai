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
import { useEffect, useState } from "react";

type RenameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  currentTitle: string;
  currentFileName: string;
  onRename: (newTitle: string, newFileName: string) => Promise<boolean>;
  isPending?: boolean;
};

export function RenameDialog({
  open,
  onOpenChange,
  title,
  description,
  currentTitle,
  currentFileName,
  onRename,
  isPending = false,
}: Readonly<RenameDialogProps>) {
  const [newTitle, setNewTitle] = useState(currentTitle);
  const [newFileName, setNewFileName] = useState(currentFileName);

  // Reset form when dialog opens with new values
  useEffect(() => {
    if (open) {
      setNewTitle(currentTitle);
      setNewFileName(currentFileName);
    }
  }, [open, currentTitle, currentFileName]);

  const handleSubmit = async () => {
    const success = await onRename(newTitle, newFileName);
    if (success) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="rename-title">Title</Label>
            <Input
              id="rename-title"
              onChange={(e) => setNewTitle(e.target.value)}
              value={newTitle}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rename-filename">File name</Label>
            <Input
              id="rename-filename"
              onChange={(e) => setNewFileName(e.target.value)}
              value={newFileName}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={isPending} onClick={handleSubmit}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
