import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "@/lib/engineer/queries/keys";

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

/* ---------- Query option factories ---------- */

export function gitStatusOptions(repoPath: string) {
  return queryOptions<GitFiles>({
    queryKey: queryKeys.gitStatus(repoPath),
    queryFn: async () => {
      const response = await fetch("/api/gateway/git", {
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
      const response = await fetch("/api/gateway/git", {
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
      const response = await fetch("/api/gateway/git/diff", {
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
