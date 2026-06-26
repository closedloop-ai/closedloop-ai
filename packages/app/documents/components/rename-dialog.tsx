"use client";

import { RenameDialogShell } from "@repo/app/shared/components/rename-dialog-shell";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { useState } from "react";

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

type RenameDialogBodyProps = {
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  currentTitle: string;
  currentFileName: string;
  open: boolean;
  onRename: (newTitle: string, newFileName: string) => Promise<boolean>;
  isPending: boolean;
};

function RenameDialogBody({
  onOpenChange,
  title,
  description,
  currentTitle,
  currentFileName,
  open,
  onRename,
  isPending,
}: Readonly<RenameDialogBodyProps>) {
  const [newTitle, setNewTitle] = useState(currentTitle);
  const [newFileName, setNewFileName] = useState(currentFileName);

  const handleSubmit = async () => {
    const success = await onRename(newTitle, newFileName);
    if (success) {
      onOpenChange(false);
    }
  };

  return (
    <RenameDialogShell
      description={description}
      isPending={isPending}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      open={open}
      title={title}
    >
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
    </RenameDialogShell>
  );
}

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
  // Key-remount the body so its local edit state is initialized fresh each time
  // the dialog opens with new source values, instead of an effect that would
  // clobber in-progress edits if the source props refetch while open.
  return (
    <RenameDialogBody
      currentFileName={currentFileName}
      currentTitle={currentTitle}
      description={description}
      isPending={isPending}
      key={`${open}-${currentTitle}-${currentFileName}`}
      onOpenChange={onOpenChange}
      onRename={onRename}
      open={open}
      title={title}
    />
  );
}
