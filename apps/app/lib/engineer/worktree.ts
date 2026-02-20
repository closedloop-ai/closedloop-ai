import { execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Timeout for local-only git commands (rev-parse, checkout, diff, worktree list/prune). */
const LOCAL_GIT_TIMEOUT = 10_000;

/** Timeout for network-touching git commands (fetch, pull, rebase) and worktree add. */
const NETWORK_GIT_TIMEOUT = 30_000;

/**
 * Recursively find all .env and .env.local files in a directory.
 * Skips node_modules and hidden directories.
 */
function findEnvFiles(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        findEnvFiles(fullPath, results);
      } else if (entry.name === ".env" || entry.name === ".env.local") {
        results.push(fullPath);
      }
    }
  } catch {
    // Can't read directory
  }
  return results;
}

/**
 * Copy .env and .env.local files from base repo to worktree.
 * Git worktrees don't include ignored files, so we need to copy them manually.
 */
export function copyEnvLocalFiles(
  repoPath: string,
  worktreePath: string
): void {
  const envFiles = findEnvFiles(repoPath);
  for (const absPath of envFiles) {
    const relativePath = absPath.slice(repoPath.length + 1); // +1 for trailing slash
    const destPath = join(worktreePath, relativePath);
    try {
      copyFileSync(absPath, destPath);
    } catch {
      // Can't copy file (dest dir may not exist in worktree, permission issue, etc.)
    }
  }
}

/**
 * Fetch latest refs from origin. No-op if offline.
 */
export function fetchOrigin(repoPath: string): void {
  try {
    execSync("git fetch origin", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: NETWORK_GIT_TIMEOUT,
    });
  } catch {
    // Offline — continue with local state
  }
}

/**
 * Save .claude/ from a non-git directory to a temp location.
 * Returns the temp path, or null if there was nothing to save.
 */
function saveClaudeState(worktreeDir: string): string | null {
  const claudeDir = join(worktreeDir, ".claude");
  if (!existsSync(claudeDir)) {
    return null;
  }
  const saved = join(tmpdir(), `worktree-claude-${Date.now()}`);
  renameSync(claudeDir, saved);
  return saved;
}

/**
 * Restore previously saved .claude/ state files into worktreeDir.
 * Merges work files if .claude/ already exists (created by git worktree add).
 */
function restoreClaudeState(savedDir: string, worktreeDir: string): void {
  const destClaude = join(worktreeDir, ".claude");
  if (!existsSync(destClaude)) {
    renameSync(savedDir, destClaude);
    return;
  }
  // Merge: copy saved work files into the new worktree's .claude/work
  const savedWork = join(savedDir, "work");
  if (existsSync(savedWork)) {
    const destWork = join(destClaude, "work");
    for (const file of readdirSync(savedWork)) {
      try {
        copyFileSync(join(savedWork, file), join(destWork, file));
      } catch {
        // Best effort
      }
    }
  }
  rmSync(savedDir, { recursive: true, force: true });
}

/**
 * Create a new git worktree at worktreeDir checked out to ref,
 * then copy .env/.env.local files from the base repo.
 */
export function addWorktree(
  repoPath: string,
  worktreeDir: string,
  ref: string
): void {
  // If the directory exists but isn't a git worktree (e.g. state files were
  // written there by a "use base repo" review), remove it so git worktree add
  // can create it cleanly. Preserve .claude/ (review state files).
  let savedClaudeDir: string | null = null;
  if (existsSync(worktreeDir) && !existsSync(join(worktreeDir, ".git"))) {
    savedClaudeDir = saveClaudeState(worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  // Prune stale worktree entries (directory was removed but git still tracks it)
  try {
    execSync("git worktree prune", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: LOCAL_GIT_TIMEOUT,
    });
  } catch {
    // Best effort
  }

  execSync(`git worktree add "${worktreeDir}" "${ref}"`, {
    cwd: repoPath,
    stdio: "pipe",
    timeout: NETWORK_GIT_TIMEOUT,
  });

  if (savedClaudeDir) {
    restoreClaudeState(savedClaudeDir, worktreeDir);
  }

  copyEnvLocalFiles(repoPath, worktreeDir);
}

/**
 * Ensure a worktree exists at worktreeDir on the given branch, fast-forwarded to latest.
 * Creates a new worktree if none exists, or checks out the branch and pulls if it does.
 */
export function ensureWorktree(
  repoPath: string,
  worktreeDir: string,
  branchName?: string
): void {
  fetchOrigin(repoPath);

  const hasGit = existsSync(join(worktreeDir, ".git"));

  if (!hasGit && branchName) {
    addWorktree(repoPath, worktreeDir, `origin/${branchName}`);
  } else if (hasGit && branchName) {
    // Worktree exists — make sure we're on the right branch and up-to-date.
    // A previous Claude review session may have left the worktree on a
    // different branch (e.g. symphony/...), so we need a robust checkout chain.
    try {
      execSync(`git checkout "${branchName}"`, {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: LOCAL_GIT_TIMEOUT,
      });
    } catch {
      try {
        execSync(`git checkout -B "${branchName}" "origin/${branchName}"`, {
          cwd: worktreeDir,
          stdio: "pipe",
          timeout: LOCAL_GIT_TIMEOUT,
        });
      } catch {
        // Both named-branch checkouts failed (branch may be checked out in
        // another worktree). Fall back to detached HEAD at the right commit.
        try {
          execSync(`git checkout --detach "origin/${branchName}"`, {
            cwd: worktreeDir,
            stdio: "pipe",
            timeout: LOCAL_GIT_TIMEOUT,
          });
        } catch {
          // Best effort — continue with whatever is checked out
        }
      }
    }
    try {
      execSync(`git pull --ff-only origin "${branchName}"`, {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: NETWORK_GIT_TIMEOUT,
      });
    } catch {
      // ff-only failed (diverged) — try rebase if working tree is clean
      try {
        execSync("git diff --quiet", {
          cwd: worktreeDir,
          stdio: "pipe",
          timeout: LOCAL_GIT_TIMEOUT,
        });
        execSync("git diff --cached --quiet", {
          cwd: worktreeDir,
          stdio: "pipe",
          timeout: LOCAL_GIT_TIMEOUT,
        });
        // Working tree is clean — safe to rebase
        execSync(`git rebase "origin/${branchName}"`, {
          cwd: worktreeDir,
          stdio: "pipe",
          timeout: NETWORK_GIT_TIMEOUT,
        });
      } catch {
        // Dirty working tree or rebase failed — continue with current state
        console.warn(
          "[worktree] Skipping rebase: working tree is dirty or rebase failed"
        );
      }
    }
  }
}

/**
 * Parse `git worktree list --porcelain` output into path/branch entries.
 */
function parseWorktreeListLocal(
  output: string
): { path: string; branch: string | null }[] {
  const entries: { path: string; branch: string | null }[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
    }
  }

  if (currentPath) {
    entries.push({ path: currentPath, branch: currentBranch });
  }

  return entries;
}

/**
 * Resolve the effective working directory for a PR branch.
 *
 * 1. If the base repo HEAD matches branchName, return repoPath (no worktree needed).
 * 2. If an existing worktree is checked out on branchName, return its path.
 * 3. Otherwise create a new worktree via ensureWorktree and return its path.
 */
export function resolveWorktreeForPR(
  repoPath: string,
  branchName: string,
  prNumber: number,
  worktreeParentDir: string
): string {
  // 1. Check if the base repo is already on the PR branch
  const headResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: LOCAL_GIT_TIMEOUT,
  });
  if (headResult.status === 0 && headResult.stdout.trim() === branchName) {
    return repoPath;
  }

  // 2. Scan existing worktrees for one checked out on this branch
  const listResult = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: LOCAL_GIT_TIMEOUT,
  });
  if (listResult.status === 0) {
    const entries = parseWorktreeListLocal(listResult.stdout);
    const match = entries.find((e) => e.branch === `refs/heads/${branchName}`);
    if (match) {
      return match.path;
    }
  }

  // 3. Create a new worktree
  const repoName = basename(repoPath);
  const worktreeDir = join(worktreeParentDir, `${repoName}-pr-${prNumber}`);
  ensureWorktree(repoPath, worktreeDir, branchName);
  return worktreeDir;
}
