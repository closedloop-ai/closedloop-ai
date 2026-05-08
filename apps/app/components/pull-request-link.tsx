import type { PullRequestInfo } from "@repo/api/src/types/document";
import { GitPullRequestIcon } from "lucide-react";

export function PullRequestLink({
  pullRequest,
}: {
  pullRequest: PullRequestInfo | null | undefined;
}) {
  if (!pullRequest) {
    return null;
  }

  return (
    <a
      aria-label={`Pull request #${pullRequest.number}`}
      className="text-muted-foreground transition-colors hover:text-primary"
      href={pullRequest.htmlUrl}
      onClick={(e) => e.stopPropagation()}
      rel="noopener noreferrer"
      target="_blank"
    >
      <GitPullRequestIcon className="h-4 w-4" />
    </a>
  );
}
