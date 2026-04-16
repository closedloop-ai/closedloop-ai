"use client";

import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { GitHubRepositoryOptionLabel } from "@/components/github-repository-option-label";
import {
  useGitHubBranches,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";

type RepoBranchSelectorProps = {
  selectedRepoId: string;
  selectedBranch: string;
  onRepoChange: (repoId: string, fullName: string) => void;
  onBranchChange: (branch: string) => void;
  repoLabel: ReactNode;
  branchLabel: ReactNode;
  repoInputId?: string;
  branchInputId?: string;
  // Default: true. Set to false to skip fetching repositories (e.g. when GitHub is not connected).
  reposEnabled?: boolean;
  // OR'd with the internal repositories-loading state to drive the disabled/placeholder on the repo Select.
  extraReposLoading?: boolean;
  // When set, filters this repo fullName out of the dropdown options (case-insensitive).
  excludeRepo?: string;
  // Rendered inside the repo Select trigger when no selected repo is resolved yet.
  repoTriggerFallback?: ReactNode;
  // When selectedRepoId is empty but a fullName is known (seeded state), this fires once to resolve it.
  // Does not touch the branch.
  seedFullName?: string;
  onSeedRepoResolved?: (repoId: string) => void;
  // When provided, replaces the repo Select widget (the Label still renders above).
  // Used for states like "GitHub not connected" where no dropdown is shown.
  repoFieldReplacement?: ReactNode;
};

export function RepoBranchSelector({
  selectedRepoId,
  selectedBranch,
  onRepoChange,
  onBranchChange,
  repoLabel,
  branchLabel,
  repoInputId,
  branchInputId,
  reposEnabled = true,
  extraReposLoading = false,
  excludeRepo,
  repoTriggerFallback,
  seedFullName,
  onSeedRepoResolved,
  repoFieldReplacement,
}: RepoBranchSelectorProps) {
  const { data: repositories, isLoading: isLoadingRepos } =
    useGitHubRepositories({ enabled: reposEnabled });
  const { data: branchesData, isLoading: isLoadingBranches } =
    useGitHubBranches(selectedRepoId, { enabled: !!selectedRepoId });

  const sortedRepositories = useMemo(
    () => (repositories ? sortRepositoriesByActivity(repositories) : []),
    [repositories]
  );

  const availableRepositories = useMemo(() => {
    if (!excludeRepo) {
      return sortedRepositories;
    }
    const exclude = excludeRepo.toLowerCase();
    return sortedRepositories.filter(
      (r) => r.fullName.toLowerCase() !== exclude
    );
  }, [sortedRepositories, excludeRepo]);

  // Resolve repoId from a seeded fullName once repositories load. Uses a
  // dedicated callback so the pre-existing branch selection is preserved.
  useEffect(() => {
    if (seedFullName && !selectedRepoId && repositories && onSeedRepoResolved) {
      const match = repositories.find((r) => r.fullName === seedFullName);
      if (match) {
        onSeedRepoResolved(match.id);
      }
    }
  }, [repositories, seedFullName, selectedRepoId, onSeedRepoResolved]);

  // Auto-select the default branch when branches load and none is set yet.
  useEffect(() => {
    if (branchesData?.branches && !selectedBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        onBranchChange(defaultBranch.name);
      }
    }
  }, [branchesData, selectedBranch, onBranchChange]);

  const handleRepoSelect = (repoId: string) => {
    const repo = repositories?.find((r) => r.id === repoId);
    if (repo) {
      onRepoChange(repoId, repo.fullName);
    }
  };

  const getBranchPlaceholder = () => {
    if (!selectedRepoId) {
      return "Select a repository first";
    }
    if (isLoadingBranches) {
      return "Loading branches...";
    }
    return "Select a branch";
  };

  const selectedRepository = repositories?.find((r) => r.id === selectedRepoId);

  const isReposBusy = extraReposLoading || isLoadingRepos;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={repoInputId}>{repoLabel}</Label>
        {repoFieldReplacement ?? (
          <Select
            disabled={isReposBusy}
            onValueChange={handleRepoSelect}
            value={selectedRepoId}
          >
            <SelectTrigger id={repoInputId}>
              <SelectValue
                placeholder={
                  isReposBusy
                    ? "Loading repositories..."
                    : "Select a repository"
                }
              >
                {selectedRepository ? (
                  <GitHubRepositoryOptionLabel
                    repository={selectedRepository}
                    showLastActive={false}
                  />
                ) : (
                  repoTriggerFallback
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
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={branchInputId}>{branchLabel}</Label>
        <Select
          disabled={!selectedRepoId || isLoadingBranches}
          onValueChange={onBranchChange}
          value={selectedBranch}
        >
          <SelectTrigger id={branchInputId}>
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
    </>
  );
}
