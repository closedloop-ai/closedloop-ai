import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, isRepoAllowed } from "@/lib/engineer/repos";

/**
 * Worktree information returned by the API
 */
type WorktreeInfo = {
  /** Full path to the worktree */
  path: string;
  /** Branch name the worktree is on */
  branch: string;
  /** Extracted ticket ID from path (e.g., "AI-247") or null */
  ticketId: string | null;
};

/**
 * Branch information returned by the API
 */
type BranchInfo = {
  /** Branch name (e.g., "feature/AI-100", "main") */
  name: string;
  /** True if this is a remote-tracking branch */
  isRemote: boolean;
  /** ISO date string of last commit */
  lastCommitDate?: string;
};

/**
 * Response shape for GET /api/git/branches
 */
type BranchesResponse = {
  /** The default branch name (e.g., "main") */
  defaultBranch: string;
  /** List of active worktrees */
  worktrees: WorktreeInfo[];
  /** List of all branches (local + remote) */
  branches: BranchInfo[];
  /** True if the repo has no commits (worktrees can't be created) */
  isEmpty?: boolean;
};

/**
 * Extract ticket ID from a worktree path or branch name.
 * Matches patterns like:
 * - Path: /Users/.../repo-AI-247 -> "AI-247"
 * - Branch: feature/AI-247 -> "AI-247"
 */
const TICKET_PATH_REGEX = /[A-Z]+-\d+$/;
const TICKET_BRANCH_REGEX = /([A-Z]+-\d+)/;

function extractTicketId(pathOrBranch: string): string | null {
  // Try to extract from path format: {repo}-{ticketId}
  const pathMatch = TICKET_PATH_REGEX.exec(pathOrBranch);
  if (pathMatch) {
    return pathMatch[0];
  }

  // Try to extract from branch format: feature/{ticketId} or just {ticketId}
  const branchMatch = TICKET_BRANCH_REGEX.exec(pathOrBranch);
  if (branchMatch) {
    return branchMatch[1];
  }

  return null;
}

/**
 * Get the default branch name from the remote.
 */
function getDefaultBranch(repoPath: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    // ref is like "refs/remotes/origin/main" -> extract "main"
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Try to auto-detect if not set
    try {
      execSync("git remote set-head origin --auto", {
        cwd: repoPath,
        stdio: "pipe",
      });
      const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      // Last resort: use the current branch name (works even in empty repos)
      try {
        return (
          execSync("git branch --show-current", {
            cwd: repoPath,
            stdio: "pipe",
            encoding: "utf-8",
          }).trim() || "main"
        );
      } catch {
        return "main";
      }
    }
  }
}

/**
 * Parse git worktree list --porcelain output.
 * Format:
 *   worktree /path/to/worktree
 *   HEAD abc123
 *   branch refs/heads/feature/AI-247
 *   (blank line)
 */
function parseWorktrees(
  repoPath: string,
  mainRepoPath: string
): WorktreeInfo[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split("\n\n").filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice(9);
        } else if (line.startsWith("branch ")) {
          // refs/heads/feature/AI-247 -> feature/AI-247
          branch = line.slice(7).replace("refs/heads/", "");
        }
      }

      // Skip the main worktree (the bare repo itself)
      if (path && path !== mainRepoPath) {
        worktrees.push({
          path,
          branch,
          ticketId: extractTicketId(basename(path)) || extractTicketId(branch),
        });
      }
    }

    return worktrees;
  } catch (err) {
    console.error("Failed to list worktrees:", err);
    return [];
  }
}

/**
 * Get all branches (local and remote) with their last commit dates.
 */
function getAllBranches(repoPath: string, defaultBranch: string): BranchInfo[] {
  try {
    // Format: refname|committerdate in ISO format
    const output = execSync(
      'git branch -a --format="%(refname:short)|%(committerdate:iso-strict)"',
      {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf-8",
      }
    );

    const branches: BranchInfo[] = [];
    const seen = new Set<string>();

    for (const line of output.split("\n").filter((l) => l.trim())) {
      const [refname, dateStr] = line.split("|");
      if (!refname) {
        continue;
      }

      // Skip HEAD pointer entries
      if (refname.includes("HEAD")) {
        continue;
      }

      // Determine if remote and normalize name
      const isRemote = refname.startsWith("origin/");
      const name = isRemote ? refname.slice(7) : refname;

      // Skip duplicates (prefer local over remote)
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);

      branches.push({
        name,
        isRemote,
        lastCommitDate: dateStr || undefined,
      });
    }

    // Sort: default branch first, then by date descending
    branches.sort((a, b) => {
      if (a.name === defaultBranch) {
        return -1;
      }
      if (b.name === defaultBranch) {
        return 1;
      }

      // Sort by date descending (most recent first)
      const dateA = a.lastCommitDate ? new Date(a.lastCommitDate).getTime() : 0;
      const dateB = b.lastCommitDate ? new Date(b.lastCommitDate).getTime() : 0;
      return dateB - dateA;
    });

    return branches;
  } catch (err) {
    console.error("Failed to list branches:", err);
    return [];
  }
}

/**
 * GET /api/git/branches?repo=/path/to/repo
 *
 * Returns information about branches and worktrees for a repository.
 */
export function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  // Security check
  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const expandedPath = expandHome(repoPath);

  if (!existsSync(expandedPath)) {
    return NextResponse.json(
      { error: `Repository not found: ${expandedPath}` },
      { status: 404 }
    );
  }

  // Detect empty repos (no commits) early — skip expensive git fetch
  let isEmpty = false;
  try {
    execSync("git rev-parse HEAD", { cwd: expandedPath, stdio: "pipe" });
  } catch {
    isEmpty = true;
  }

  if (isEmpty) {
    const defaultBranch = getDefaultBranch(expandedPath);
    return NextResponse.json({
      defaultBranch,
      worktrees: [],
      branches: [],
      isEmpty,
    } satisfies BranchesResponse);
  }

  // Fetch latest from origin (best effort)
  try {
    execSync("git fetch origin", {
      cwd: expandedPath,
      stdio: "pipe",
      timeout: 10_000, // 10 second timeout
    });
  } catch {
    // Ignore fetch failures (e.g., offline)
  }

  const defaultBranch = getDefaultBranch(expandedPath);
  const worktrees = parseWorktrees(expandedPath, expandedPath);
  const branches = getAllBranches(expandedPath, defaultBranch);

  const response: BranchesResponse = {
    defaultBranch,
    worktrees,
    branches,
  };

  return NextResponse.json(response);
}
