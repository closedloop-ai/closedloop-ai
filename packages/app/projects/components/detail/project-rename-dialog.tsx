"use client";

import { useUpdateProject } from "@repo/app/projects/hooks/use-projects";
import { RenameDialogShell } from "@repo/app/shared/components/rename-dialog-shell";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { useState } from "react";

type ProjectRenameDialogProps = {
  projectId: string;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ProjectRenameDialogBody({
  projectId,
  currentName,
  open,
  onOpenChange,
}: Readonly<ProjectRenameDialogProps>) {
  const updateProject = useUpdateProject();
  const [name, setName] = useState(currentName);
  const trimmedName = name.trim();
  const currentTrimmedName = currentName.trim();
  const canSave = trimmedName.length > 0 && trimmedName !== currentTrimmedName;

  const handleSubmit = () => {
    if (!canSave) {
      return;
    }

    updateProject.mutate(
      { id: projectId, name: trimmedName },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <RenameDialogShell
      canSave={canSave}
      description="Update the name shown for this project."
      isPending={updateProject.isPending}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      open={open}
      title="Rename Project"
    >
      <div className="space-y-2">
        <Label htmlFor="project-name">Project name</Label>
        <Input
          autoFocus
          id="project-name"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>
    </RenameDialogShell>
  );
}

export function ProjectRenameDialog({
  projectId,
  currentName,
  open,
  onOpenChange,
}: Readonly<ProjectRenameDialogProps>) {
  // Key-remount the body so its local `name` state is initialized fresh each
  // time the dialog opens with a new source name, instead of an effect that
  // would clobber in-progress edits if `currentName` refetches while open.
  return (
    <ProjectRenameDialogBody
      currentName={currentName}
      key={`${open}-${currentName}`}
      onOpenChange={onOpenChange}
      open={open}
      projectId={projectId}
    />
  );
}
