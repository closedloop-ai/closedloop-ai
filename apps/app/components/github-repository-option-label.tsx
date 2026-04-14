import type { GitHubRepository } from "@repo/api/src/types/github";
import { formatDistanceToNow } from "date-fns";

type GitHubRepositoryOptionLabelProps = {
  repository: Pick<GitHubRepository, "fullName" | "lastPushedAt">;
  showLastActive?: boolean;
};

export function GitHubRepositoryOptionLabel({
  repository,
  showLastActive = true,
}: Readonly<GitHubRepositoryOptionLabelProps>) {
  if (!(showLastActive && repository.lastPushedAt)) {
    return <span>{repository.fullName}</span>;
  }

  return (
    <div className="flex flex-col">
      <span>{repository.fullName}</span>
      <span className="text-muted-foreground text-xs">
        Last active{" "}
        {formatDistanceToNow(new Date(repository.lastPushedAt), {
          addSuffix: true,
        })}
      </span>
    </div>
  );
}
