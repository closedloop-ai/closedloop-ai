import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { getWorktreeParentDir } from "@/lib/engineer/repos";

/**
 * Expand ~ to home directory
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

type WorktreeResult = {
  success?: boolean;
  error?: string;
  hasChanges?: boolean;
  message?: string;
  status?: number;
};

function removeNonWorktree(
  expandedPath: string,
  force: boolean
): WorktreeResult {
  if (force) {
    rmSync(expandedPath, { recursive: true, force: true });
    return { success: true, message: "Directory removed (not a git worktree)" };
  }
  return { error: "Path is not a git worktree", status: 400 };
}

function forceRemoveWorktree(expandedPath: string): WorktreeResult {
  spawnSync("git", ["worktree", "prune"], {
    stdio: "pipe",
    cwd: expandedPath,
  });
  rmSync(expandedPath, { recursive: true, force: true });
  return { success: true, message: "Worktree forcefully removed" };
}

function handleWorktreeRemoveError(
  err: unknown,
  force: boolean,
  expandedPath: string
): WorktreeResult {
  const errorMessage = err instanceof Error ? err.message : "Unknown error";

  if (errorMessage.includes("contains modified or untracked files") && !force) {
    return {
      error: "Worktree has uncommitted changes",
      hasChanges: true,
      message: "Use force=true to remove anyway",
      status: 409,
    };
  }

  if (force) {
    return forceRemoveWorktree(expandedPath);
  }

  return { error: `Failed to remove worktree: ${errorMessage}`, status: 500 };
}

function removeWorktree(expandedPath: string, force: boolean): WorktreeResult {
  if (!existsSync(expandedPath)) {
    return { success: true, message: "Worktree does not exist" };
  }

  if (!existsSync(join(expandedPath, ".git"))) {
    return removeNonWorktree(expandedPath, force);
  }

  try {
    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force");
    }
    args.push(expandedPath);
    const result = spawnSync("git", args, {
      stdio: "pipe",
      cwd: expandedPath,
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.toString() ?? "git worktree remove failed"
      );
    }
    return { success: true, message: "Worktree removed successfully" };
  } catch (err) {
    return handleWorktreeRemoveError(err, force, expandedPath);
  }
}

function worktreeResponse(result: WorktreeResult): NextResponse {
  const { status, ...body } = result;
  return NextResponse.json(body, status ? { status } : undefined);
}

/**
 * API route to manage git worktrees
 *
 * DELETE /api/git/worktree
 * Body: { worktreePath: string, force?: boolean }
 *
 * Removes a git worktree. If force is true, removes even if there are changes.
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { worktreePath, force = false } = body as {
      worktreePath: string;
      force?: boolean;
    };

    if (!worktreePath || typeof worktreePath !== "string") {
      return NextResponse.json(
        { error: "worktreePath is required and must be a string" },
        { status: 400 }
      );
    }

    const expandedPath = expandPath(worktreePath);
    const worktreeParentDir = getWorktreeParentDir();
    if (!expandedPath.startsWith(worktreeParentDir + sep)) {
      return NextResponse.json(
        { error: `Path is outside allowed directory: ${expandedPath}` },
        { status: 403 }
      );
    }

    return worktreeResponse(removeWorktree(expandedPath, force));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to process worktree removal: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * Parse `git worktree list --porcelain` output into entries.
 * Each entry has a path and optional branch ref.
 */
function parseWorktreeList(
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
 * Check if a branch ref still exists on the remote.
 * Returns true if the branch is gone (merged/deleted).
 */
function isRemoteBranchGone(mainRepoPath: string, branchRef: string): boolean {
  // Extract short branch name from refs/heads/...
  const shortName = branchRef.startsWith("refs/heads/")
    ? branchRef.slice("refs/heads/".length)
    : branchRef;

  const result = spawnSync(
    "git",
    ["ls-remote", "--heads", "origin", shortName],
    { stdio: "pipe", cwd: mainRepoPath, timeout: 5000 }
  );

  // If ls-remote returns empty output, the branch doesn't exist on remote
  if (result.status === 0) {
    const output = result.stdout?.toString().trim() ?? "";
    return output.length === 0;
  }

  // If ls-remote fails (e.g., no remote), don't clean up
  return false;
}

/**
 * Check if a worktree has review state files (indicating a review was run).
 * These worktrees should be preserved by automatic cleanup; only manual
 * deletion should remove them.
 */
function hasReviewState(worktreeDir: string): boolean {
  const workDir = join(worktreeDir, ".claude", "work");
  if (!existsSync(workDir)) {
    return false;
  }
  try {
    return readdirSync(workDir).some((f) => f.startsWith("codex-review-"));
  } catch {
    return false;
  }
}

/**
 * POST /api/engineer/git/worktree
 *
 * Scans for stale PR worktrees (matching /-pr-\d+$/) and removes those
 * whose branch has been deleted from the remote.
 *
 * Returns: { removed: string[], kept: string[], errors: string[] }
 */
export function POST() {
  try {
    const worktreeParentDir = getWorktreeParentDir();

    if (!existsSync(worktreeParentDir)) {
      return NextResponse.json({ removed: [], kept: [], errors: [] });
    }

    // Find PR worktree directories that are valid git repos
    const dirEntries = readdirSync(worktreeParentDir, { withFileTypes: true });
    const prPattern = /-pr-\d+$/;
    const prDirs = dirEntries
      .filter(
        (e) =>
          e.isDirectory() &&
          prPattern.test(e.name) &&
          existsSync(join(worktreeParentDir, e.name, ".git"))
      )
      .map((e) => join(worktreeParentDir, e.name));

    if (prDirs.length === 0) {
      return NextResponse.json({ removed: [], kept: [], errors: [] });
    }

    // Cap the number of worktrees to scan — each requires a blocking ls-remote call
    const MAX_WORKTREES = 10;
    const cappedPrDirs = prDirs.slice(0, MAX_WORKTREES);

    // Find the main repo by parsing `git worktree list --porcelain` from the first PR worktree
    // The first entry in `git worktree list` is always the main worktree
    const listResult = spawnSync("git", ["worktree", "list", "--porcelain"], {
      stdio: "pipe",
      cwd: cappedPrDirs[0],
      timeout: 10_000,
    });

    if (listResult.status !== 0) {
      return NextResponse.json(
        { error: "Failed to list worktrees" },
        { status: 500 }
      );
    }

    const worktreeEntries = parseWorktreeList(
      listResult.stdout?.toString() ?? ""
    );
    const mainRepoPath = worktreeEntries[0]?.path;

    if (!mainRepoPath) {
      return NextResponse.json(
        { error: "Could not determine main repo path" },
        { status: 500 }
      );
    }

    // Build a map of worktree path -> branch from the porcelain output
    const branchByPath = new Map<string, string | null>();
    for (const entry of worktreeEntries) {
      branchByPath.set(entry.path, entry.branch);
    }

    const removed: string[] = [];
    const kept: string[] = [];
    const errors: string[] = [];

    for (const prDir of cappedPrDirs) {
      try {
        // Security: ensure path is inside worktreeParentDir
        if (!prDir.startsWith(worktreeParentDir + sep)) {
          continue;
        }

        // Skip worktrees that have review state — a review was run here
        if (hasReviewState(prDir)) {
          kept.push(prDir);
          continue;
        }

        const branch = branchByPath.get(prDir);
        if (!branch) {
          // Not tracked as a worktree — skip
          kept.push(prDir);
          continue;
        }

        if (isRemoteBranchGone(mainRepoPath, branch)) {
          // Branch is gone from remote — remove the worktree (non-force to protect dirty worktrees)
          const result = removeWorktree(prDir, false);
          if (result.success) {
            removed.push(prDir);
          } else if (result.hasChanges) {
            kept.push(prDir);
          } else {
            errors.push(`${prDir}: ${result.error || "removal failed"}`);
          }
        } else {
          kept.push(prDir);
        }
      } catch (err) {
        errors.push(
          `${prDir}: ${err instanceof Error ? err.message : "unknown error"}`
        );
      }
    }

    return NextResponse.json({ removed, kept, errors });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Worktree cleanup failed: ${errorMessage}` },
      { status: 500 }
    );
  }
}
