"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { CheckIcon, Loader2Icon, UsersIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

type CreateTeamStepProps = {
  onNext: (teamName: string) => void;
  // Set once the team has been created, so returning via Back shows the created
  // team instead of a blank form (mirrors the production success state).
  createdTeamName?: string | null;
};

const SUBMIT_DELAY_MS = 700;

// Presentational replica of the production CreateTeamStep. Production wires
// this to useCreateTeam(); the prototype simulates the pending round-trip and
// carries the entered name forward.
export const CreateTeamStep = ({
  onNext,
  createdTeamName,
}: CreateTeamStepProps) => {
  const [name, setName] = useState("");
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
    submitTimer.current = globalThis.setTimeout(
      () => onNext(trimmed),
      SUBMIT_DELAY_MS
    );
  };

  // Already created (returning via Back): show the created team, not a blank
  // form, and let the user continue on.
  if (createdTeamName) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-success/10">
          <CheckIcon className="size-6 text-success" />
        </div>
        <div className="space-y-1">
          <p className="font-semibold">Team created</p>
          <p className="text-muted-foreground text-sm">{createdTeamName}</p>
        </div>
        <Button onClick={() => onNext(createdTeamName)}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
          <UsersIcon className="size-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold text-lg">Create your team</h2>
          <p className="text-muted-foreground text-sm">
            Teams help you organize projects and collaborate with others.
          </p>
        </div>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            autoFocus
            id="team-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Engineering, Design, Product"
            value={name}
          />
        </div>

        <Button
          className="w-full"
          disabled={!name.trim() || pending}
          type="submit"
        >
          {pending && <Loader2Icon className="size-4 animate-spin" />}
          Create Team
        </Button>
      </form>
    </div>
  );
};
