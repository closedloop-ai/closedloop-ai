import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { formatDistanceToNow } from "date-fns";
import { useEffect, useMemo } from "react";
import {
  useGitHubBranches,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";

type RepositoryBranchFieldsProps = {
  targetBranch: string;
  selectedRepoId: string;
  onRepositoryChange: (repoId: string, fullName: string) => void;
  onBranchChange: (branch: string) => void;
};

export function RepositoryBranchFields({
  targetBranch,
  selectedRepoId,
  onRepositoryChange,
  onBranchChange,
}: RepositoryBranchFieldsProps) {
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

  // Auto-select default branch when branches load and no branch selected
  useEffect(() => {
    if (branchesData?.branches && !targetBranch) {
      const defaultBranch = branchesData.branches.find((b) => b.isDefault);
      if (defaultBranch) {
        onBranchChange(defaultBranch.name);
      }
    }
  }, [branchesData, targetBranch, onBranchChange]);

  const handleRepoSelect = (repoId: string) => {
    const repo = repositories?.find((r) => r.id === repoId);
    if (repo) {
      onRepositoryChange(repoId, repo.fullName);
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

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="target-repo">
          Target Repository{" "}
          <span className="text-muted-foreground text-xs">(owner/repo)</span>
        </Label>
        {githubStatus?.connected === false ? (
          <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
            Connect GitHub to select a repository
          </div>
        ) : (
          <Select
            disabled={isLoadingGitHubStatus || isLoadingRepos}
            onValueChange={handleRepoSelect}
            value={selectedRepoId}
          >
            <SelectTrigger
              className="[&_.text-muted-foreground]:hidden"
              id="target-repo"
            >
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
                    {repo.lastPushedAt ? (
                      <span className="text-muted-foreground text-xs">
                        Last active{" "}
                        {formatDistanceToNow(new Date(repo.lastPushedAt), {
                          addSuffix: true,
                        })}
                      </span>
                    ) : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="target-branch">Target Branch</Label>
        <Select
          disabled={!selectedRepoId || isLoadingBranches}
          onValueChange={onBranchChange}
          value={targetBranch}
        >
          <SelectTrigger id="target-branch">
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
