import { useGitHubIntegrationStatus } from "@/hooks/queries/use-github-integration";
import { RepoBranchSelector } from "./repo-branch-selector";

type RepositoryBranchFieldsProps = {
  targetRepo: string;
  targetBranch: string;
  selectedRepoId: string;
  onRepositoryChange: (repoId: string, fullName: string) => void;
  onBranchChange: (branch: string) => void;
};

export function RepositoryBranchFields({
  targetRepo,
  targetBranch,
  selectedRepoId,
  onRepositoryChange,
  onBranchChange,
}: RepositoryBranchFieldsProps) {
  const { data: githubStatus, isLoading: isLoadingGitHubStatus } =
    useGitHubIntegrationStatus();

  const isDisconnected = githubStatus?.connected === false;
  const repoFieldReplacement = isDisconnected ? (
    <div className="rounded-md border border-muted bg-muted/20 p-3 text-muted-foreground text-sm">
      Connect GitHub to select a repository
    </div>
  ) : undefined;

  return (
    <RepoBranchSelector
      branchInputId="target-branch"
      branchLabel="Target Branch"
      extraReposLoading={isLoadingGitHubStatus}
      onBranchChange={onBranchChange}
      onRepoChange={onRepositoryChange}
      repoFieldReplacement={repoFieldReplacement}
      repoInputId="target-repo"
      repoLabel={
        <>
          Target Repository{" "}
          <span className="text-muted-foreground text-xs">(owner/repo)</span>
        </>
      }
      reposEnabled={githubStatus?.connected === true}
      repoTriggerFallback={targetRepo ? <span>{targetRepo}</span> : null}
      selectedBranch={targetBranch}
      selectedRepoId={selectedRepoId}
    />
  );
}
