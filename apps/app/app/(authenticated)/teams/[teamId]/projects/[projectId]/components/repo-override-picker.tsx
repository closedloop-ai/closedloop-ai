"use client";

import type { JsonObject } from "@repo/api/src/types/common";
import {
  type RepositoryOverrides,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { LoaderIcon, StarIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useUpdateProject } from "@/hooks/queries/use-projects";
import {
  type TeamRepoWithTeamId,
  toResolverTeamRepo,
  useTeamRepositoriesUnion,
} from "@/hooks/use-team-repositories-union";

type ProjectTeamRef = { id: string; name: string };

type RepoOverridePickerProps = {
  projectId: string;
  teams: ProjectTeamRef[];
  currentSettings: JsonObject;
  currentOverride: RepositoryOverrides | undefined;
  // When false the team-repo union fetch is skipped. Callers should pass
  // `false` when GitHub is not connected so the union doesn't fire on mount
  // (P2 review finding on PR #1115; matches the convention sibling
  // `overview-properties.tsx` already uses for `useRepoSummary`).
  enabled?: boolean;
};

export function RepoOverridePicker({
  projectId,
  teams,
  currentSettings,
  currentOverride,
  enabled = true,
}: Readonly<RepoOverridePickerProps>) {
  const teamIds = useMemo(() => teams.map((t) => t.id), [teams]);
  const { repositories, isLoading } = useTeamRepositoriesUnion({
    teamIds,
    enabled,
  });
  const { mutate: mutateProject } = useUpdateProject();

  // Resolve effective defaults — used to seed local state and to render
  // checkmarks against when the project has no override yet.
  const resolved = useMemo(
    () =>
      resolveProjectRepoDefaults({
        projectSettings: { repositoryOverrides: currentOverride },
        teamRepos: repositories.map(toResolverTeamRepo),
        teamCount: teams.length,
      }),
    [currentOverride, repositories, teams.length]
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primaryId, setPrimaryId] = useState<string>("");

  // Sync local state with resolved defaults whenever the inputs change. This
  // handles both first paint after team-repo data loads and external project
  // updates (override changes elsewhere). The poolIds gate prevents a brief
  // empty-pool render from clobbering valid state.
  useEffect(() => {
    if (repositories.length === 0) {
      return;
    }
    if (resolved) {
      setSelectedIds(new Set(resolved.selectedRepoIds));
      setPrimaryId(resolved.primaryRepoId);
    } else {
      setSelectedIds(new Set());
      setPrimaryId("");
    }
  }, [resolved, repositories.length]);

  const poolIds = useMemo(
    () => new Set(repositories.map((r) => r.installationRepositoryId)),
    [repositories]
  );
  const overrideMatchesResolved = doesOverrideMatch(
    currentOverride,
    selectedIds,
    primaryId,
    poolIds
  );
  const canSave =
    selectedIds.size > 0 &&
    primaryId.length > 0 &&
    selectedIds.has(primaryId) &&
    !overrideMatchesResolved;

  const handleToggle = (repoId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(repoId);
      } else {
        next.delete(repoId);
        // Un-checking the primary clears its primary designation; the user
        // must pick another to save.
        if (repoId === primaryId) {
          setPrimaryId("");
        }
      }
      return next;
    });
  };

  const handleSetPrimary = (repoId: string) => {
    // Designating a repo as primary must also include it in the default
    // selection — primary always implies selected.
    setSelectedIds((prev) => {
      if (prev.has(repoId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(repoId);
      return next;
    });
    setPrimaryId(repoId);
  };

  const handleSave = () => {
    if (!canSave) {
      return;
    }
    mutateProject({
      id: projectId,
      settings: {
        ...currentSettings,
        repositoryOverrides: {
          selectedRepoIds: Array.from(selectedIds),
          primaryRepoId: primaryId,
        },
      },
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Loading team repositories...
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="rounded-md border border-muted bg-muted/20 p-2 text-muted-foreground text-xs">
        No repositories curated on this project's team
        {teams.length === 1 ? "" : "s"}. Add repositories on the team
        configuration page first.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {teams.length > 1 && !currentOverride ? (
        <p className="text-muted-foreground text-xs">
          This project belongs to multiple teams. Set default repos to
          streamline job launches.
        </p>
      ) : null}

      <RadioGroup onValueChange={handleSetPrimary} value={primaryId}>
        <ul className="space-y-2">
          {repositories.map((repo) => (
            <RepoRow
              key={repo.installationRepositoryId}
              onToggle={handleToggle}
              primaryId={primaryId}
              repo={repo}
              selected={selectedIds.has(repo.installationRepositoryId)}
            />
          ))}
        </ul>
      </RadioGroup>

      <Button
        className="w-full"
        disabled={!canSave}
        onClick={handleSave}
        size="sm"
        type="button"
        variant="outline"
      >
        Save defaults
      </Button>
    </div>
  );
}

type RepoRowProps = {
  repo: TeamRepoWithTeamId;
  selected: boolean;
  primaryId: string;
  onToggle: (repoId: string, checked: boolean) => void;
};

function RepoRow({ repo, selected, primaryId, onToggle }: RepoRowProps) {
  const isPrimary = primaryId === repo.installationRepositoryId;
  const checkboxId = `repo-default-${repo.installationRepositoryId}`;
  const primaryRadioId = `repo-primary-${repo.installationRepositoryId}`;
  return (
    <li
      className={`flex items-center gap-3 rounded-md border p-2 ${
        isPrimary ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <Checkbox
          aria-label={`Default-select ${repo.repository.fullName}`}
          checked={selected}
          id={checkboxId}
          onCheckedChange={(checked) =>
            onToggle(repo.installationRepositoryId, checked === true)
          }
        />
        <Label className="text-muted-foreground text-xs" htmlFor={checkboxId}>
          Default
        </Label>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <RadioGroupItem
          aria-label={`Set ${repo.repository.fullName} as primary`}
          id={primaryRadioId}
          value={repo.installationRepositoryId}
        />
        <Label
          className="text-muted-foreground text-xs"
          htmlFor={primaryRadioId}
        >
          Primary
        </Label>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {isPrimary ? (
          <StarIcon className="h-3.5 w-3.5 shrink-0 fill-primary text-primary" />
        ) : null}
        <span
          className={`truncate text-sm ${isPrimary ? "font-semibold" : ""}`}
          title={repo.repository.fullName}
        >
          {repo.repository.fullName}
        </span>
      </div>
    </li>
  );
}

function doesOverrideMatch(
  override: RepositoryOverrides | undefined,
  selectedIds: Set<string>,
  primaryId: string,
  poolIds: Set<string>
): boolean {
  if (!override) {
    return false;
  }
  if (override.primaryRepoId !== primaryId) {
    return false;
  }
  // Compare against the pool-filtered override so a stale id removed from the
  // team pool doesn't cause an endless "unsaved changes" state.
  const filtered = override.selectedRepoIds.filter((id) => poolIds.has(id));
  if (filtered.length !== selectedIds.size) {
    return false;
  }
  return filtered.every((id) => selectedIds.has(id));
}
