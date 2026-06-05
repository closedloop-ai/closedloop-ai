"use client";

import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";
import { MetadataSection } from "./metadata-panel";

type TargetRepositoryFieldsProps = {
  /**
   * When false, omits the top border/padding used to separate this block from content above.
   * Use false when this section is first inside a collapsible (trigger already has a bottom border).
   */
  separator?: boolean;
  /**
   * Section title (e.g., "Plan Generation" or "Repository Settings")
   */
  title: string;
  /**
   * Current target repository value
   */
  targetRepo: string;
  /**
   * Current target branch value
   */
  targetBranch: string;
  /**
   * Handler called when target repository input value changes
   */
  onTargetRepoChange: (targetRepo: string) => void;
  /**
   * Handler called when target repository input loses focus.
   * Accepts optional override value to avoid stale closure issues.
   */
  onTargetRepoBlur: (overrideValue?: string) => void;
  /**
   * Handler called when target branch input value changes
   */
  onTargetBranchChange: (targetBranch: string) => void;
  /**
   * Handler called when target branch input loses focus.
   * Accepts optional override value to avoid stale closure issues.
   */
  onTargetBranchBlur: (overrideValue?: string) => void;
};

/**
 * Shared component for target repository and branch input fields.
 * Used by PRD and Feature metadata panels.
 */
export function TargetRepositoryFields({
  separator = true,
  title,
  targetRepo,
  targetBranch,
  onTargetRepoChange,
  onTargetRepoBlur,
  onTargetBranchChange,
  onTargetBranchBlur,
}: Readonly<TargetRepositoryFieldsProps>) {
  // GitHub integration queries
  const { data: githubStatus, isLoading: isLoadingGitHubStatus } =
    useGitHubIntegrationStatus();
  const { data: repositories, isLoading: isLoadingRepos } =
    useGitHubRepositories({
      enabled: githubStatus?.connected === true,
    });

  const sortedRepositories = useMemo(
    () => (repositories ? sortRepositoriesByActivity(repositories) : []),
    [repositories]
  );

  // Derive selectedRepoId from targetRepo value (match fullName to find repo ID)
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");

  // Sync selectedRepoId with targetRepo value (match fullName to find repo ID)
  useEffect(() => {
    if (repositories && targetRepo) {
      const matchingRepo = repositories.find(
        (repo) => repo.fullName === targetRepo
      );
      if (matchingRepo && matchingRepo.id !== selectedRepoId) {
        setSelectedRepoId(matchingRepo.id);
      }
    } else if (!targetRepo) {
      setSelectedRepoId("");
    }
  }, [repositories, targetRepo, selectedRepoId]);

  const { data: branchesData, isLoading: isLoadingBranches } =
    useGitHubBranches(selectedRepoId, {
      enabled: !!selectedRepoId,
    });

  // Auto-select default branch when branches are loaded (only if branch is empty)
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        onTargetBranchChange(defaultBranch.name);
        onTargetBranchBlur(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch, onTargetBranchChange, onTargetBranchBlur]);

  // Compute branch placeholder based on state
  const getBranchPlaceholder = () => {
    if (!selectedRepoId) {
      return "Select a repository first";
    }
    if (isLoadingBranches) {
      return "Loading branches...";
    }
    return "Select a branch";
  };

  const handleRepositoryChange = (repoId: string) => {
    const selectedRepo = repositories?.find((r) => r.id === repoId);
    if (selectedRepo) {
      setSelectedRepoId(repoId);
      onTargetRepoChange(selectedRepo.fullName);
      onTargetRepoBlur(selectedRepo.fullName);
      // Clear branch when repository changes - will be auto-set by useEffect
      onTargetBranchChange("");
      onTargetBranchBlur("");
    }
  };

  const handleBranchChange = (branch: string) => {
    onTargetBranchChange(branch);
    onTargetBranchBlur(branch);
  };

  return (
    <MetadataSection separator={separator}>
      <h4 className="font-medium text-sm">{title}</h4>

      <div className="space-y-2">
        <Label>
          Target Repository{" "}
          <span className="text-muted-foreground text-xs">(owner/repo)</span>
        </Label>
        {githubStatus?.connected === false ? (
          <div className="space-y-1">
            {targetRepo ? (
              <p className="text-muted-foreground text-sm">{targetRepo}</p>
            ) : null}
            <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
              Connect GitHub to select a repository
            </div>
          </div>
        ) : (
          <Select
            disabled={isLoadingGitHubStatus || isLoadingRepos}
            onValueChange={handleRepositoryChange}
            value={selectedRepoId}
          >
            <SelectTrigger className="bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent">
              <SelectValue
                placeholder={
                  isLoadingGitHubStatus || isLoadingRepos
                    ? "Loading repositories..."
                    : "Select a repository"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {sortedRepositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  <div className="flex flex-col">
                    <span>{repo.fullName}</span>
                    {repo.lastPushedAt && (
                      <span className="text-muted-foreground text-xs">
                        Last active{" "}
                        {formatDistanceToNow(new Date(repo.lastPushedAt), {
                          addSuffix: true,
                        })}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-2">
        <Label>Target Branch</Label>
        {githubStatus?.connected === false ? (
          <p className="text-muted-foreground text-sm">{targetBranch || "—"}</p>
        ) : (
          <Select
            disabled={!selectedRepoId || isLoadingBranches}
            onValueChange={handleBranchChange}
            value={targetBranch}
          >
            <SelectTrigger className="bg-transparent hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent">
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
        )}
      </div>
    </MetadataSection>
  );
}
