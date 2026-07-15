"use client";

import type { GitHubBranch } from "@repo/api/src/types/github";
import { useDefaultBranches } from "@repo/app/github/hooks/use-default-branches";
import {
  RepoSource,
  type ResolvedRepo,
  type UseResolvedJobReposResult,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import type { TeamRepoWithTeamId } from "@repo/app/teams/hooks/use-team-repositories-union";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LoaderIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  computeSeedKey,
  computeSeedState,
} from "./job-repositories/seed-state";
import {
  buildSelection,
  computeIncomplete,
  type JobRepoSelection,
} from "./job-repositories/selection";

export type JobRepositoriesSectionProps = {
  resolved: UseResolvedJobReposResult;
  // Required when launching an execution-bound command (PLAN, EXECUTE,
  // GENERATE_PRD). PRD save without execute can pass `requirePrimary={false}`
  // so the user is allowed to omit a primary at submit time.
  requirePrimary?: boolean;
  onChange: (selection: JobRepoSelection | null) => void;
  onIncompleteChange?: (incomplete: boolean) => void;
  // Initial collapsed state when only the primary is selected. Set to false
  // for dialogs that should always start expanded.
  collapseWhenSingleRepo?: boolean;
  // Disabled by parent (e.g. while another query loads).
  disabled?: boolean;
  // When true, the user cannot change which repo is primary (radio + the
  // primary row's checkbox are disabled). Used by execute flows where the
  // backend uses the plan artifact's `targetRepo` and any UI primary change
  // would be silently dropped.
  lockPrimary?: boolean;
};

const SOURCE_LABELS: Record<RepoSource, string> = {
  [RepoSource.PriorLoop]: "from previous job",
  [RepoSource.ProjectOverride]: "project override",
  [RepoSource.TeamDefault]: "from team defaults",
  [RepoSource.UserAdded]: "added manually",
};

export function JobRepositoriesSection(
  props: Readonly<JobRepositoriesSectionProps>
) {
  const { resolved } = props;

  if (resolved.isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Loading repositories…
      </div>
    );
  }

  const { primary: seedPrimary, additional: seedAdditional, pool } = resolved;

  if (pool.length === 0) {
    return (
      <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
        No repositories curated on this project's team. Add repositories on the
        team configuration page first.
      </div>
    );
  }

  // Inner is keyed by seed identity. The resolver typically settles once per
  // modal session, so the inner mounts and owns state for its lifetime. If the
  // resolver does emit a new seed mid-session, `seedKey` changes and React
  // remounts with the fresh seed.
  const seedKey = computeSeedKey(seedPrimary, seedAdditional);

  return (
    <JobRepositoriesSectionInner
      {...props}
      key={seedKey}
      pool={pool}
      seedAdditional={seedAdditional}
      seedPrimary={seedPrimary}
    />
  );
}

type InnerProps = Readonly<JobRepositoriesSectionProps> & {
  pool: TeamRepoWithTeamId[];
  seedPrimary: ResolvedRepo | null;
  seedAdditional: ResolvedRepo[];
};

function JobRepositoriesSectionInner({
  requirePrimary = true,
  onChange,
  onIncompleteChange,
  collapseWhenSingleRepo = true,
  disabled = false,
  lockPrimary = false,
  pool,
  seedPrimary,
  seedAdditional,
}: InnerProps) {
  // When the seed primary isn't one of the pool repos, surface a banner asking
  // the user to pick a new primary.
  const droppedSeedPrimary = seedPrimary !== null && !seedPrimary.inPool;

  // Computed once at mount; the outer's `key` reset re-runs this initializer
  // when the seed identity changes.
  const [seed] = useState(() =>
    computeSeedState({ seedPrimary, seedAdditional })
  );

  const [primaryId, setPrimaryId] = useState<string | null>(seed.primaryId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(seed.ids);
  const [sourceById, setSourceById] = useState<Record<string, RepoSource>>(
    seed.sources
  );
  // Pre-resolved branches from prior-loop peers. The user can still override
  // these via the per-row Select; the seed only wins over the GitHub default
  // when no user override is set.
  const seedBranchById = seed.branches;
  // Per-row branch overrides chosen by the user inside this section. Wins
  // over both the seed and the GitHub default in `effectiveBranchByRepoId`.
  const [userBranchById, setUserBranchById] = useState<Record<string, string>>(
    {}
  );
  const [isOpen, setIsOpen] = useState(
    collapseWhenSingleRepo ? seed.ids.size > 1 : true
  );

  // Selected ids in the pool drive the per-repo branch lookups. Repos outside
  // the pool can't be submitted (AC-002).
  const selectedPoolIds = useMemo(() => {
    const poolIdSet = new Set(pool.map((r) => r.installationRepositoryId));
    return Array.from(selectedIds).filter((id) => poolIdSet.has(id));
  }, [pool, selectedIds]);

  // Fetch branches for every selected pool repo (not just those missing a
  // seed) so the per-row override Select has options to render even for
  // prior-loop / legacy seeded rows. Per-row loading is signalled by
  // `branchesByRepoId[id]` being undefined; submit gating uses the per-id
  // branch presence check inside `computeIncomplete` (no global flag), so
  // an all-seeded selection unblocks immediately on first render.
  const { branchByRepoId, branchesByRepoId } = useDefaultBranches({
    repoIds: selectedPoolIds,
  });

  const effectiveBranchByRepoId = useMemo<Record<string, string>>(
    () => ({ ...branchByRepoId, ...seedBranchById, ...userBranchById }),
    [branchByRepoId, seedBranchById, userBranchById]
  );

  const emitToParent = useEffectEvent(
    (incomplete: boolean, selection: JobRepoSelection | null) => {
      onIncompleteChange?.(incomplete);
      onChange(selection);
    }
  );

  // Project the internal state into the parent payload + incomplete signal.
  useEffect(() => {
    const incomplete = computeIncomplete({
      requirePrimary,
      primaryId,
      selectedIds,
      pool,
      branchByRepoId: effectiveBranchByRepoId,
    });
    const selection = incomplete
      ? null
      : buildSelection({
          pool,
          primaryId,
          selectedIds,
          branchByRepoId: effectiveBranchByRepoId,
        });
    emitToParent(incomplete, selection);
  }, [primaryId, selectedIds, pool, effectiveBranchByRepoId, requirePrimary]);

  const handleTogglePrimary = (repoId: string) => {
    if (!sourceById[repoId]) {
      setSourceById((prev) => ({
        ...prev,
        [repoId]: RepoSource.UserAdded,
      }));
    }
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

  const handleToggleSelected = (repoId: string, checked: boolean) => {
    if (checked) {
      if (!sourceById[repoId]) {
        setSourceById((prev) => ({
          ...prev,
          [repoId]: RepoSource.UserAdded,
        }));
      }
      setSelectedIds((prev) => {
        if (prev.has(repoId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(repoId);
        return next;
      });
      return;
    }
    if (!selectedIds.has(repoId)) {
      return;
    }
    // Block deselecting the last remaining repo (AC-005). The click is a
    // no-op so the user keeps a viable selection.
    if (selectedIds.size <= 1) {
      return;
    }
    const next = new Set(selectedIds);
    next.delete(repoId);
    setSelectedIds(next);
    // Removing the primary auto-promotes the first remaining row (AC-003).
    if (repoId === primaryId) {
      const promoted = next.values().next().value ?? null;
      setPrimaryId(promoted);
    }
  };

  const handleBranchChange = (repoId: string, branch: string) => {
    setUserBranchById((prev) => ({ ...prev, [repoId]: branch }));
  };

  const incomplete = computeIncomplete({
    requirePrimary,
    primaryId,
    selectedIds,
    pool,
    branchByRepoId: effectiveBranchByRepoId,
  });
  const showLastRepoMessage = selectedIds.size === 1;

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md p-2 font-medium text-sm transition-colors hover:bg-accent">
        <span>Repositories</span>
        {isOpen ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {droppedSeedPrimary && seedPrimary ? (
          <Alert variant="warning">
            <AlertDescription>
              <strong>{seedPrimary.fullName}</strong> isn't in this team's
              repositories. Pick a primary below to launch.
            </AlertDescription>
          </Alert>
        ) : null}
        <RadioGroup onValueChange={handleTogglePrimary} value={primaryId ?? ""}>
          <ul className="space-y-2">
            {pool.map((repo) => (
              <RepoRow
                branch={
                  effectiveBranchByRepoId[repo.installationRepositoryId] ?? ""
                }
                branches={branchesByRepoId[repo.installationRepositoryId]}
                disabled={disabled}
                isLockedPrimary={
                  lockPrimary && repo.installationRepositoryId === primaryId
                }
                key={repo.installationRepositoryId}
                lockPrimary={lockPrimary}
                onBranchChange={handleBranchChange}
                onToggle={handleToggleSelected}
                primaryId={primaryId}
                repo={repo}
                selected={selectedIds.has(repo.installationRepositoryId)}
                source={sourceById[repo.installationRepositoryId]}
              />
            ))}
          </ul>
        </RadioGroup>
        {showLastRepoMessage ? (
          <p className="text-muted-foreground text-xs">
            At least one repository must remain selected.
          </p>
        ) : null}
        {incomplete && requirePrimary && !primaryId ? (
          <p className="text-destructive text-xs">
            Pick a primary repository before launching this job.
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

type RepoRowProps = Readonly<{
  repo: TeamRepoWithTeamId;
  selected: boolean;
  primaryId: string | null;
  source: RepoSource | undefined;
  disabled: boolean;
  // When true, the user cannot promote this row to primary (radio disabled).
  lockPrimary: boolean;
  // When true (only relevant on the current primary), the user also cannot
  // deselect this row — deselecting would auto-promote another, effectively
  // changing the primary.
  isLockedPrimary: boolean;
  // Currently effective branch for this repo. Empty string until the seed /
  // GitHub default lookup resolves.
  branch: string;
  // Full branch list from the GitHub fetch. Undefined while the per-repo
  // query is still in flight or hasn't been triggered (row not selected).
  branches: GitHubBranch[] | undefined;
  onToggle: (repoId: string, checked: boolean) => void;
  onBranchChange: (repoId: string, branch: string) => void;
}>;

function RepoRow({
  repo,
  selected,
  primaryId,
  source,
  disabled,
  lockPrimary,
  isLockedPrimary,
  branch,
  branches,
  onToggle,
  onBranchChange,
}: RepoRowProps) {
  const isPrimary = primaryId === repo.installationRepositoryId;
  const checkboxId = `job-repo-select-${repo.installationRepositoryId}`;
  const radioId = `job-repo-primary-${repo.installationRepositoryId}`;
  const branchId = `job-repo-branch-${repo.installationRepositoryId}`;
  return (
    <li
      className={`flex flex-col gap-2 rounded-md border p-2 ${
        isPrimary ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-1.5">
          <Checkbox
            aria-label={`Include ${repo.repository.fullName}`}
            checked={selected}
            disabled={disabled || isLockedPrimary}
            id={checkboxId}
            onCheckedChange={(checked) =>
              onToggle(repo.installationRepositoryId, checked === true)
            }
          />
          <Label className="text-muted-foreground text-xs" htmlFor={checkboxId}>
            Include
          </Label>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RadioGroupItem
            aria-label={`Set ${repo.repository.fullName} as primary`}
            disabled={disabled || lockPrimary}
            id={radioId}
            value={repo.installationRepositoryId}
          />
          <Label className="text-muted-foreground text-xs" htmlFor={radioId}>
            Primary
          </Label>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {isPrimary ? (
            <StarIcon className="h-3.5 w-3.5 shrink-0 fill-primary text-primary" />
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              isPrimary ? "font-semibold" : ""
            }`}
            title={repo.repository.fullName}
          >
            {repo.repository.fullName}
          </span>
          {selected && source ? (
            <span className="shrink-0 text-muted-foreground text-xs">
              · {SOURCE_LABELS[source]}
            </span>
          ) : null}
        </div>
      </div>
      {selected ? (
        <RepoBranchSelect
          branch={branch}
          branches={branches}
          disabled={disabled}
          id={branchId}
          onBranchChange={(value) =>
            onBranchChange(repo.installationRepositoryId, value)
          }
          repoFullName={repo.repository.fullName}
        />
      ) : null}
    </li>
  );
}

type RepoBranchSelectProps = Readonly<{
  id: string;
  repoFullName: string;
  branch: string;
  branches: GitHubBranch[] | undefined;
  disabled: boolean;
  onBranchChange: (branch: string) => void;
}>;

function RepoBranchSelect({
  id,
  repoFullName,
  branch,
  branches,
  disabled,
  onBranchChange,
}: RepoBranchSelectProps) {
  const options = useMemo(
    () => buildBranchOptions(branches, branch),
    [branches, branch]
  );
  // `branches === undefined` means the per-repo GitHub query is still in
  // flight (or hasn't been triggered yet). Use that row-local signal
  // directly instead of a global "any branch loading" flag — submit gating
  // already lives in `computeIncomplete` via the per-id branch check.
  const isFetching = !branches;
  // Branch picker drops to its own row beneath the repo metadata. Left
  // padding aligns it roughly under the repo name (past the Include +
  // Primary controls) so it visually belongs to its row.
  return (
    <div className="flex items-center gap-2 pl-6">
      <Label className="shrink-0 text-muted-foreground text-xs" htmlFor={id}>
        Branch
      </Label>
      <Select
        disabled={disabled || isFetching || options.length === 0}
        onValueChange={onBranchChange}
        value={branch}
      >
        <SelectTrigger
          aria-label={`Branch for ${repoFullName}`}
          className="h-8 w-full max-w-[280px] text-xs"
          id={id}
        >
          <SelectValue
            placeholder={isFetching ? "Loading…" : "Select a branch"}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.name} value={opt.name}>
              {opt.name}
              {opt.isDefault ? " (default)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Build the branch options list. Always includes the currently effective
// branch even when the GitHub branches lookup is missing it (e.g. a
// prior-loop peer whose branch has since been deleted) so the user can still
// see what's selected.
function buildBranchOptions(
  branches: GitHubBranch[] | undefined,
  current: string
): Array<{ name: string; isDefault: boolean }> {
  const list = branches ?? [];
  const hasCurrent = list.some((b) => b.name === current);
  if (current && !hasCurrent) {
    return [{ name: current, isDefault: false }, ...list];
  }
  return list;
}
