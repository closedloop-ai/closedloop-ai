"use client";

import type { JsonObject } from "@repo/api/src/types/common";
import type { DefaultRepository } from "@repo/api/src/types/project";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitHubRepositoryOptionLabel } from "@/components/github-repository-option-label";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { useUpdateProject } from "@/hooks/queries/use-projects";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";

type DefaultRepositoryPickerProps = {
  projectId: string;
  currentSettings: JsonObject;
  defaultRepository: DefaultRepository | undefined;
};

export function DefaultRepositoryPicker({
  projectId,
  currentSettings,
  defaultRepository,
}: DefaultRepositoryPickerProps) {
  const [selectedRepoId, setSelectedRepoId] = useState(
    defaultRepository?.repoId ?? ""
  );
  const [selectedBranch, setSelectedBranch] = useState(
    defaultRepository?.branch ?? ""
  );

  const updateProject = useUpdateProject();

  const { data: githubStatus, isLoading: isLoadingGitHubStatus } =
    useGitHubIntegrationStatus();
  const { data: repositories, isLoading: isLoadingRepos } =
    useGitHubRepositories({
      enabled: githubStatus?.connected === true,
    });
  const { data: branchesData, isLoading: isLoadingBranches } =
    useGitHubBranches(selectedRepoId, {
      enabled: !!selectedRepoId,
    });

  const sortedRepositories = useMemo(
    () => (repositories ? sortRepositoriesByActivity(repositories) : []),
    [repositories]
  );
  const selectedRepository = repositories?.find(
    (repo) => repo.id === selectedRepoId
  );
  const selectedRepositoryLabel =
    selectedRepository?.fullName ||
    (selectedRepoId === defaultRepository?.repoId
      ? defaultRepository?.repoFullName
      : undefined);

  const renderRepositoryTriggerValue = () => {
    if (selectedRepository) {
      return (
        <GitHubRepositoryOptionLabel
          repository={selectedRepository}
          showLastActive={false}
        />
      );
    }

    if (selectedRepositoryLabel) {
      return <span>{selectedRepositoryLabel}</span>;
    }

    return null;
  };

  // Sync local state when prop changes (e.g., after save or external update)
  useEffect(() => {
    setSelectedRepoId(defaultRepository?.repoId ?? "");
    setSelectedBranch(defaultRepository?.branch ?? "");
  }, [defaultRepository?.repoId, defaultRepository?.branch]);

  const saveDefault = useCallback(
    (repoId: string, repoFullName: string, branch: string) => {
      setSelectedBranch(branch);
      updateProject.mutate({
        id: projectId,
        settings: {
          ...currentSettings,
          defaultRepository: { repoId, repoFullName, branch },
        },
      });
    },
    [projectId, currentSettings, updateProject]
  );

  // Auto-select default branch when branches load for a new repo selection
  useEffect(() => {
    if (
      branchesData?.branches &&
      selectedRepoId &&
      selectedRepoId !== defaultRepository?.repoId
    ) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        const repo = repositories?.find((r) => r.id === selectedRepoId);
        if (repo) {
          saveDefault(selectedRepoId, repo.fullName, defaultBranch.name);
        }
      }
    }
  }, [
    branchesData,
    selectedRepoId,
    defaultRepository?.repoId,
    repositories,
    saveDefault,
  ]);

  const handleRepoSelect = (repoId: string) => {
    const repo = repositories?.find((r) => r.id === repoId);
    if (repo) {
      setSelectedRepoId(repoId);
      setSelectedBranch("");
    }
  };

  const handleBranchSelect = (branch: string) => {
    const repo = repositories?.find((r) => r.id === selectedRepoId);
    if (repo) {
      saveDefault(selectedRepoId, repo.fullName, branch);
    }
  };

  if (githubStatus?.connected === false) {
    return (
      <div className="rounded-md border border-muted bg-muted/20 p-2 text-muted-foreground text-xs">
        Connect GitHub to set a default repository
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        disabled={isLoadingGitHubStatus || isLoadingRepos}
        onValueChange={handleRepoSelect}
        value={selectedRepoId}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue
            placeholder={
              isLoadingGitHubStatus || isLoadingRepos
                ? "Loading..."
                : "Select repository"
            }
          >
            {renderRepositoryTriggerValue()}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sortedRepositories.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              <GitHubRepositoryOptionLabel repository={repo} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedRepoId ? (
        <Select
          disabled={!selectedRepoId || isLoadingBranches}
          onValueChange={handleBranchSelect}
          value={selectedBranch}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue
              placeholder={
                isLoadingBranches ? "Loading branches..." : "Select branch"
              }
            />
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
      ) : null}
    </div>
  );
}
