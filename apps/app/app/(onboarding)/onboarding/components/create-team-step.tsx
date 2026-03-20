"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Check, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { useCreateTeam } from "@/hooks/queries/use-teams";

type CreateTeamStepProps = {
  readonly onNext: (teamId: string, teamName: string) => void;
  readonly createdTeamId: string | null;
  readonly createdTeamName: string | null;
};

export function CreateTeamStep({
  onNext,
  createdTeamId,
  createdTeamName,
}: CreateTeamStepProps) {
  const [name, setName] = useState("");
  const createTeam = useCreateTeam();

  // Already completed — show success state
  if (createdTeamId && createdTeamName) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
          <Check className="h-6 w-6 text-green-500" />
        </div>
        <div className="space-y-1">
          <p className="font-semibold">Team created</p>
          <p className="text-muted-foreground text-sm">{createdTeamName}</p>
        </div>
        <Button onClick={() => onNext(createdTeamId, createdTeamName)}>
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

    const team = await createTeam.mutateAsync({ name: trimmed });
    onNext(team.id, team.name);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <Users className="h-5 w-5 text-primary" />
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
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Engineering, Design, Product"
            value={name}
          />
        </div>

        <Button
          className="w-full"
          disabled={!name.trim() || createTeam.isPending}
          type="submit"
        >
          {createTeam.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Create Team
        </Button>
      </form>
    </div>
  );
}
