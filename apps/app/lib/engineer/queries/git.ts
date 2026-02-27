import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./keys";

/* ---------- Response types ---------- */

export type GitFiles = {
  modified: string[];
  created: string[];
  deleted: string[];
  staged: string[];
};

export type BranchDiffFiles = {
  baseBranch: string;
  currentBranch: string;
  files: {
    modified: string[];
    created: string[];
    deleted: string[];
  };
  totalChanges: number;
};

export type FileDiff = {
  filePath: string;
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
  isImage?: boolean;
  mimeType?: string;
};

export type PRReviewsResponse = {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  approvalCount: number;
  changesRequestedCount: number;
};

export type PRCommentItem = {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  isReview: boolean;
  url: string;
  inReplyToId?: number;
};

export type PRCommentsResponse = {
  comments: PRCommentItem[];
  prNumber: number;
  prUrl: string;
};

export type PRListItem = {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  createdAt: string;
  headRefName: string;
};

export type WorktreeInfo = {
  /** Full path to the worktree */
  path: string;
  /** Branch name the worktree is on */
  branch: string;
  /** Extracted ticket ID from path (e.g., "AI-247") or null */
  ticketId: string | null;
};

export type BranchInfo = {
  /** Branch name (e.g., "feature/AI-100", "main") */
  name: string;
  /** True if this is a remote-tracking branch */
  isRemote: boolean;
  /** ISO date string of last commit */
  lastCommitDate?: string;
};

export type BranchesResponse = {
  /** The default branch name (e.g., "main") */
  defaultBranch: string;
  /** List of active worktrees */
  worktrees: WorktreeInfo[];
  /** List of all branches (local + remote) */
  branches: BranchInfo[];
  /** True if the repo has no commits (worktrees can't be created) */
  isEmpty?: boolean;
};

/* ---------- Query option factories ---------- */

export function gitStatusOptions(repoPath: string) {
  return queryOptions<GitFiles>({
    queryKey: queryKeys.gitStatus(repoPath),
    queryFn: async () => {
      const response = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", repoPath }),
      });
      if (!response.ok) {
        throw new Error("Failed to fetch git status");
      }
      const data = await response.json();
      return (
        data.files || { modified: [], created: [], deleted: [], staged: [] }
      );
    },
  });
}

export function gitBranchDiffOptions(repoPath: string) {
  return queryOptions<BranchDiffFiles>({
    queryKey: queryKeys.gitBranchDiff(repoPath),
    queryFn: async () => {
      const response = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "branch-diff", repoPath }),
      });
      if (!response.ok) {
        throw new Error("Failed to fetch branch diff");
      }
      return response.json();
    },
  });
}

export function gitDiffOptions(
  repoPath: string,
  filePath: string | null,
  diffMode: string,
  baseBranch: string | undefined
) {
  return queryOptions<FileDiff>({
    queryKey: queryKeys.gitDiff(repoPath, filePath, diffMode, baseBranch),
    queryFn: async () => {
      const response = await fetch("/api/engineer/git/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath,
          repoPath,
          ...(diffMode === "branch" && baseBranch ? { baseBranch } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error("Failed to fetch diff");
      }
      return response.json();
    },
    enabled: !!filePath,
  });
}

export function prReviewsOptions(
  owner: string | undefined,
  repo: string | undefined,
  prNumber: number | undefined
) {
  return queryOptions<PRReviewsResponse>({
    queryKey: queryKeys.prReviews(owner, repo, prNumber),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/git/pr/reviews?owner=${owner!}&repo=${repo!}&number=${prNumber!}`
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          (errorData as { error?: string }).error ??
            "Failed to fetch PR reviews"
        );
      }
      return response.json();
    },
    enabled: !!owner && !!repo && !!prNumber,
  });
}

export function prCommentsOptions(prNumber: number, repoPath: string) {
  return queryOptions<PRCommentsResponse>({
    queryKey: queryKeys.prComments(prNumber, repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/git/pr/comments?repo=${encodeURIComponent(repoPath)}&pr=${prNumber}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch comments");
      }
      return response.json();
    },
  });
}

/**
 * Query options for fetching branches and worktrees for a repository.
 * Includes caching with 30-second stale time since branches don't change often.
 */
export function branchesOptions(repoPath: string) {
  return queryOptions<BranchesResponse>({
    queryKey: queryKeys.gitBranches(repoPath),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/git/branches?repo=${encodeURIComponent(repoPath)}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch branches");
      }
      return response.json();
    },
    staleTime: 30_000, // Branches don't change often
  });
}

export function prListOptions(repoPath: string, state: string) {
  return queryOptions<{ prs: PRListItem[] }>({
    queryKey: queryKeys.prList(repoPath, state),
    queryFn: async () => {
      const response = await fetch(
        `/api/engineer/git/pr/list?repo=${encodeURIComponent(repoPath)}&state=${encodeURIComponent(state)}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch PR list");
      }
      return response.json();
    },
    staleTime: 30_000,
  });
}
