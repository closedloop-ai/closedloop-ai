"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { GitHubRepositoryOptionLabel } from "@/components/github-repository-option-label";
import {
  useGitHubBranches,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";

// Internal type — repoId is needed for Select value binding but is not part of AdditionalRepoRef
type AdditionalRepoRow = {
  id: string;
  repoId: string;
  fullName: string;
  branch: string;
};

type RepoRowFieldsProps = {
  row: AdditionalRepoRow;
  index: number;
  targetRepo: string;
  error?: string;
  onRepoChange: (id: string, repoId: string, fullName: string) => void;
  onBranchChange: (id: string, branch: string) => void;
  onRemove: (id: string) => void;
};

// Each row is its own component so each can call useGitHubBranches (Rules of Hooks)
function RepoRowFields({
  row,
  index,
  targetRepo,
  error,
  onRepoChange,
  onBranchChange,
  onRemove,
}: RepoRowFieldsProps) {
  const { data: repositories, isLoading: isLoadingRepos } =
    useGitHubRepositories();
  const { data: branchesData, isLoading: isLoadingBranches } =
    useGitHubBranches(row.repoId, { enabled: !!row.repoId });

  const sortedRepositories = useMemo(
    () => (repositories ? sortRepositoriesByActivity(repositories) : []),
    [repositories]
  );

  // Auto-select default branch when branches load and none is set
  useEffect(() => {
    if (branchesData?.branches && !row.branch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        onBranchChange(row.id, defaultBranch.name);
      }
    }
  }, [branchesData, row.branch, row.id, onBranchChange]);

  const handleRepoSelect = (repoId: string) => {
    const repo = repositories?.find((r) => r.id === repoId);
    if (repo) {
      onRepoChange(row.id, repoId, repo.fullName);
    }
  };

  const getBranchPlaceholder = () => {
    if (!row.repoId) {
      return "Select a repository first";
    }
    if (isLoadingBranches) {
      return "Loading branches...";
    }
    return "Select a branch";
  };

  // Exclude the primary target repo from options (case-insensitive)
  const availableRepositories = useMemo(
    () =>
      sortedRepositories.filter(
        (r) => r.fullName.toLowerCase() !== targetRepo?.toLowerCase()
      ),
    [sortedRepositories, targetRepo]
  );

  const selectedRepository = repositories?.find((r) => r.id === row.repoId);

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Repository {index + 1}</span>
        <Button
          onClick={() => onRemove(row.id)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Repository</Label>
        <Select
          disabled={isLoadingRepos}
          onValueChange={handleRepoSelect}
          value={row.repoId}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={
                isLoadingRepos
                  ? "Loading repositories..."
                  : "Select a repository"
              }
            >
              {selectedRepository && (
                <GitHubRepositoryOptionLabel
                  repository={selectedRepository}
                  showLastActive={false}
                />
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {availableRepositories.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                <GitHubRepositoryOptionLabel repository={repo} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Branch</Label>
        <Select
          disabled={!row.repoId || isLoadingBranches}
          onValueChange={(branch) => onBranchChange(row.id, branch)}
          value={row.branch}
        >
          <SelectTrigger>
            <SelectValue placeholder={getBranchPlaceholder()} />
          </SelectTrigger>
          <SelectContent>
            {branchesData?.branches.map((branch) => (
              <SelectItem key={branch.name} value={branch.name}>
                {branch.name}
                {branch.isDefault ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

type AdditionalReposPickerProps = {
  value: AdditionalRepoRef[];
  onChange: (repos: AdditionalRepoRef[]) => void;
  onValidChange?: (isValid: boolean) => void;
  targetRepo: string;
};

export function AdditionalReposPicker({
  value,
  onChange,
  onValidChange,
  targetRepo,
}: AdditionalReposPickerProps) {
  // Internal rows include repoId for Select binding; projected to AdditionalRepoRef[] for parent
  const [rows, setRows] = useState<AdditionalRepoRow[]>(() =>
    value.map((ref) => ({
      id: crypto.randomUUID(),
      repoId: "",
      fullName: ref.fullName,
      branch: ref.branch,
    }))
  );

  // Compute per-row validation errors (keyed by row.id)
  const rowErrors = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    const seenFullNames: string[] = [];

    for (const row of rows) {
      if (!row.fullName) {
        seenFullNames.push("");
        continue;
      }

      const lowerName = row.fullName.toLowerCase();

      if (lowerName === targetRepo?.toLowerCase()) {
        errors[row.id] =
          "Cannot use the primary repository as an additional repository";
      } else if (seenFullNames.includes(lowerName)) {
        errors[row.id] = "Duplicate repository";
      }

      seenFullNames.push(lowerName);
    }

    return errors;
  }, [rows, targetRepo]);

  // Notify parent when validity changes — all rows must have fullName and branch, and no errors
  useEffect(() => {
    if (!onValidChange) {
      return;
    }
    const hasErrors = Object.keys(rowErrors).length > 0;
    const allComplete = rows.every((r) => r.fullName && r.branch);
    onValidChange(rows.length === 0 || (allComplete && !hasErrors));
  }, [rows, rowErrors, onValidChange]);

  const handleRepoChange = (id: string, repoId: string, fullName: string) => {
    setRows((prev) => {
      const next = prev.map((r) =>
        r.id === id ? { ...r, repoId, fullName, branch: "" } : r
      );
      projectToParent(next, onChange);
      return next;
    });
  };

  const handleBranchChange = (id: string, branch: string) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, branch } : r));
      projectToParent(next, onChange);
      return next;
    });
  };

  const handleRemove = (id: string) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      projectToParent(next, onChange);
      return next;
    });
  };

  const handleAdd = () => {
    if (rows.length >= MAX_ADDITIONAL_REPOS) {
      return;
    }
    setRows((prev) => {
      const next = [
        ...prev,
        { id: crypto.randomUUID(), repoId: "", fullName: "", branch: "" },
      ];
      projectToParent(next, onChange);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <RepoRowFields
          error={rowErrors[row.id]}
          index={index}
          key={row.id}
          onBranchChange={handleBranchChange}
          onRemove={handleRemove}
          onRepoChange={handleRepoChange}
          row={row}
          targetRepo={targetRepo}
        />
      ))}

      {rows.length < MAX_ADDITIONAL_REPOS && (
        <Button
          className="w-full"
          onClick={handleAdd}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon className="h-4 w-4" />
          Add Repository
        </Button>
      )}

      {rows.length >= MAX_ADDITIONAL_REPOS && (
        <p className="text-muted-foreground text-xs">
          Maximum of {MAX_ADDITIONAL_REPOS} additional repositories reached.
        </p>
      )}
    </div>
  );
}

// Project AdditionalRepoRow[] → AdditionalRepoRef[] (omit id and repoId)
function projectToParent(
  rows: AdditionalRepoRow[],
  onChange: (repos: AdditionalRepoRef[]) => void
) {
  onChange(rows.map(({ fullName, branch }) => ({ fullName, branch })));
}
