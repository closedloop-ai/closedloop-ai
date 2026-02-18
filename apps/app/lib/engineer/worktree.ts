import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    execSync("git fetch origin", { cwd: repoPath, stdio: "pipe" });
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
    execSync("git worktree prune", { cwd: repoPath, stdio: "pipe" });
  } catch {
    // Best effort
  }

  execSync(`git worktree add "${worktreeDir}" "${ref}"`, {
    cwd: repoPath,
    stdio: "pipe",
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
      });
    } catch {
      try {
        execSync(`git checkout -B "${branchName}" "origin/${branchName}"`, {
          cwd: worktreeDir,
          stdio: "pipe",
        });
      } catch {
        // Both named-branch checkouts failed (branch may be checked out in
        // another worktree). Fall back to detached HEAD at the right commit.
        try {
          execSync(`git checkout --detach "origin/${branchName}"`, {
            cwd: worktreeDir,
            stdio: "pipe",
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
      });
    } catch {
      // ff-only failed (diverged) — try rebase if working tree is clean
      try {
        execSync("git diff --quiet", { cwd: worktreeDir, stdio: "pipe" });
        execSync("git diff --cached --quiet", {
          cwd: worktreeDir,
          stdio: "pipe",
        });
        // Working tree is clean — safe to rebase
        execSync(`git rebase "origin/${branchName}"`, {
          cwd: worktreeDir,
          stdio: "pipe",
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
