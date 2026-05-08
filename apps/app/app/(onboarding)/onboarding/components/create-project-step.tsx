"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { Check, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";
import { useCreateProject } from "@/hooks/queries/use-projects";

type CreateProjectStepProps = {
  readonly teamId: string;
  readonly onNext: (projectId: string, projectName: string) => void;
  readonly createdProjectId: string | null;
  readonly createdProjectName: string | null;
};

export function CreateProjectStep({
  teamId,
  onNext,
  createdProjectId,
  createdProjectName,
}: CreateProjectStepProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createProject = useCreateProject();

  // Already completed — show success state
  if (createdProjectId && createdProjectName) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
          <Check className="h-6 w-6 text-green-500" />
        </div>
        <div className="space-y-1">
          <p className="font-semibold">Project created</p>
          <p className="text-muted-foreground text-sm">{createdProjectName}</p>
        </div>
        <Button onClick={() => onNext(createdProjectId, createdProjectName)}>
          Continue
        </Button>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const project = await createProject.mutateAsync({
      name: trimmed,
      description: description.trim() || undefined,
      teamIds: [teamId],
    });
    onNext(project.id, project.name);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <FolderOpen className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold text-lg">Create your first project</h2>
          <p className="text-muted-foreground text-sm">
            Projects contain your PRDs, features, and implementation plans.
          </p>
        </div>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            autoFocus
            id="project-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. User Authentication, Mobile App"
            value={name}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="project-description">
            Description{" "}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="project-description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of the project"
            rows={3}
            value={description}
          />
        </div>

        <Button
          className="w-full"
          disabled={!name.trim() || createProject.isPending}
          type="submit"
        >
          {createProject.isPending && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          Create Project
        </Button>
      </form>
    </div>
  );
}
