import { spawnSync } from "node:child_process";
import {
  expandHome,
  getConfiguredReposList,
  getWorktreeParentDir,
} from "@/lib/engineer/repos";
import {
  findExistingWorktreeForBranch,
  resolveWorktreeForPR,
} from "@/lib/engineer/worktree";

const LOCAL_GIT_TIMEOUT = 5000;
const GITHUB_REMOTE_REGEX = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/;
const GIT_SUFFIX_REGEX = /\.git$/;

export type BranchWorktreeMatch = {
  path: string;
  repoPath: string;
};

export function parseGitHubRemoteFullName(remoteUrl: string): string | null {
  const match = GITHUB_REMOTE_REGEX.exec(remoteUrl.trim());
  if (!match?.[1]) {
    return null;
  }
  return match[1].replace(GIT_SUFFIX_REGEX, "");
}

function getRepoFullName(repoPath: string): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: LOCAL_GIT_TIMEOUT,
  });
  if (result.status !== 0) {
    return null;
  }
  return parseGitHubRemoteFullName(result.stdout);
}

export function resolveBranchWorktree(
  repoFullName: string,
  headBranch: string,
  prNumber: number
): BranchWorktreeMatch | null {
  for (const repo of getConfiguredReposList()) {
    const repoPath = expandHome(repo.path);
    if (getRepoFullName(repoPath) !== repoFullName) {
      continue;
    }

    const existingCheckout = findExistingWorktreeForBranch(
      repoPath,
      headBranch
    );
    if (existingCheckout) {
      return {
        path: existingCheckout,
        repoPath,
      };
    }

    return {
      path: resolveWorktreeForPR(
        repoPath,
        headBranch,
        prNumber,
        getWorktreeParentDir()
      ),
      repoPath,
    };
  }

  return null;
}
