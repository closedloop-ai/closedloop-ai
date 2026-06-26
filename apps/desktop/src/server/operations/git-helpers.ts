import { execFile, execFileSync } from "node:child_process";
import { getResolvedGitPath } from "./symphony-loop.js";

/**
 * Resolve the git remote full name (org/repo) from a local repo path.
 * Returns null if the remote origin URL cannot be parsed.
 */
export function resolveRepoFullName(repoPath: string): string | null {
  try {
    const remoteUrl = execFileSync(
      getResolvedGitPath(),
      ["remote", "get-url", "origin"],
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    ).trim();

    const sshMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
    if (sshMatch) {
      return sshMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Async variant for UI-sensitive paths. It preserves `resolveRepoFullName`
 * parsing and failure semantics while avoiding a blocking git subprocess on the
 * Electron main thread.
 */
export async function resolveRepoFullNameAsync(
  repoPath: string
): Promise<string | null> {
  try {
    const remoteUrl = (
      await execFileText(
        getResolvedGitPath(),
        ["remote", "get-url", "origin"],
        {
          cwd: repoPath,
          timeout: 10_000,
        }
      )
    ).trim();

    const sshMatch = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
    if (sshMatch) {
      return sshMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Find existing worktree for a branch name. Returns null when not checked out. */
export function findWorktreeForBranch(
  expandedRepoPath: string,
  branchName: string
): string | null {
  try {
    const output = execFileSync(
      getResolvedGitPath(),
      ["worktree", "list", "--porcelain"],
      {
        cwd: expandedRepoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    );

    let currentWorktree: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentWorktree = line.slice("worktree ".length);
      }
      if (line.startsWith("branch ") && line.endsWith(`/${branchName}`)) {
        return currentWorktree;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * List every worktree directory for a repository. Returns an empty array when
 * the repo is not a git repository or the command fails.
 */
export function listAllWorktrees(expandedRepoPath: string): string[] {
  try {
    const output = execFileSync(
      getResolvedGitPath(),
      ["worktree", "list", "--porcelain"],
      {
        cwd: expandedRepoPath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    );

    const worktrees: string[] = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktrees.push(line.slice("worktree ".length));
      }
    }
    return worktrees;
  } catch {
    return [];
  }
}

function execFileText(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}
