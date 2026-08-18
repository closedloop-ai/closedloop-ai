"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

type CreateProjectStepProps = {
  onNext: (projectName: string, description: string) => void;
};

const SUBMIT_DELAY_MS = 700;

// Presentational replica of the production CreateProjectStep. Production wires
// this to useCreateProject(); the prototype simulates the pending round-trip.
export const CreateProjectStep = ({ onNext }: CreateProjectStepProps) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const submitTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null
  );

  useEffect(
    () => () => {
      if (submitTimer.current !== null) {
        globalThis.clearTimeout(submitTimer.current);
      }
    },
    []
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) {
      return;
    }
    setPending(true);
    const trimmedDescription = description.trim();
    submitTimer.current = globalThis.setTimeout(
      () => onNext(trimmed, trimmedDescription),
      SUBMIT_DELAY_MS
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
          <FolderOpenIcon className="size-5 text-primary" />
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
            onChange={(event) => setName(event.target.value)}
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
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Brief description of the project"
            rows={3}
            value={description}
          />
        </div>

        <Button
          className="w-full"
          disabled={!name.trim() || pending}
          type="submit"
        >
          {pending && <Loader2Icon className="size-4 animate-spin" />}
          Create Project
        </Button>
      </form>
    </div>
  );
};
