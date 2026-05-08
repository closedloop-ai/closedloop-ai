"use client";

import type { DefaultRepository } from "@repo/api/src/types/project";
import { AlertTriangleIcon } from "lucide-react";
import { useTeamRepositories } from "@/hooks/queries/use-teams";
import { useMultiRepoConfigEnabled } from "@/hooks/use-multi-repo-config-enabled";

type DefaultRepositoryWarningProps = {
  teamId: string;
  defaultRepository: DefaultRepository | undefined;
};

/**
 * Warns the project owner when the project's saved defaultRepository points
 * at a repo that is no longer part of the team's curated repository list.
 *
 * Only active when the multi-repo-config feature flag is enabled. Quiet when:
 *  - the flag is off (legacy single-repo behavior)
 *  - the team has no curated repositories (the constraint isn't in effect)
 *  - the project has no defaultRepository set
 *  - the project's defaultRepository is in the team's curated list
 */
export function DefaultRepositoryWarning({
  teamId,
  defaultRepository,
}: DefaultRepositoryWarningProps) {
  const enabled = useMultiRepoConfigEnabled();
  const { data: teamRepositories = [], isLoading } = useTeamRepositories(
    teamId,
    { enabled: enabled && !!teamId && !!defaultRepository?.repoId }
  );

  if (!(enabled && defaultRepository?.repoId) || isLoading) {
    return null;
  }

  if (teamRepositories.length === 0) {
    return null;
  }

  const isInTeamList = teamRepositories.some(
    (tr) => tr.installationRepositoryId === defaultRepository.repoId
  );
  if (isInTeamList) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-amber-700 text-xs dark:text-amber-300">
      <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong className="font-medium">
          {defaultRepository.repoFullName ?? "This repository"}
        </strong>{" "}
        is no longer in this team's configured repository list. Pick a new
        default to avoid issues launching agent jobs.
      </span>
    </div>
  );
}
