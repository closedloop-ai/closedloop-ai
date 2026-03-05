import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { migrateLegacySessions } from "@/lib/engineer/migrate-sessions";
import {
  expandHome,
  getConfiguredReposList,
  getWorktreeParentDir,
} from "@/lib/engineer/repos";

/**
 * Interface for session data stored in ~/.closedloop-ai/sessions.json
 */
type SessionData = {
  sessions: Array<{
    ticketId: string;
    repoPath: string;
    worktreePath: string;
    pid?: number;
    startedAt?: string;
    lastAccessedAt?: string;
  }>;
};

/**
 * Check if CLAUDE.md has uncommitted changes in the worktree
 * Returns the full path to CLAUDE.md if it has changes, null otherwise
 */
function checkPendingClaudeMd(worktreePath: string): string | null {
  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    return null;
  }

  try {
    const status = execSync("git status --porcelain -- CLAUDE.md", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return status ? claudeMdPath : null;
  } catch {
    return null;
  }
}

/**
 * Check the branch status (merged, remote missing)
 */
function checkBranchStatus(
  worktreePath: string
): { merged: boolean; remoteMissing: boolean } | null {
  try {
    // Get current branch name
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    // Check if remote tracking branch exists
    const remoteExists = execSync(`git ls-remote --heads origin ${branch}`, {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!remoteExists) {
      // Remote branch doesn't exist - could be merged and deleted
      // Check if branch is merged into main
      try {
        const mergedBranches = execSync("git branch --merged origin/main", {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 5000,
        });
        const isMerged = mergedBranches.includes(branch);
        return { merged: isMerged, remoteMissing: true };
      } catch {
        // Can't check merged status, just report remote missing
        return { merged: false, remoteMissing: true };
      }
    }

    return { merged: false, remoteMissing: false };
  } catch {
    return null;
  }
}

/**
 * API route to check if work directory exists for a ticket
 *
 * GET /api/work-directory/[ticketId]
 *
 * Checks in order:
 * 1. Sessions file (~/.closedloop-ai/sessions.json) for existing worktreePath
 * 2. Configured repo worktree patterns ({worktreeParentDir}/{repoName}-{ticketId})
 *
 * Returns:
 * - exists: boolean - Whether the work directory exists
 * - path: string - Full path to the work directory
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const { ticketId } = await params;

    // Validate input
    if (!ticketId || typeof ticketId !== "string") {
      return NextResponse.json(
        { error: "ticketId is required and must be a string" },
        { status: 400 }
      );
    }

    // Sanitize ticket identifier to prevent path traversal
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");

    // 1. First check sessions file for existing worktreePath
    migrateLegacySessions();
    const sessionsPath = expandHome("~/.closedloop-ai/sessions.json");
    if (existsSync(sessionsPath)) {
      try {
        const sessionsContent = readFileSync(sessionsPath, "utf-8");
        const sessionsData: SessionData = JSON.parse(sessionsContent);
        const session = sessionsData.sessions?.find(
          (s) => s.ticketId === ticketId
        );
        if (session?.worktreePath) {
          const expandedPath = expandHome(session.worktreePath);
          if (existsSync(expandedPath)) {
            return NextResponse.json({
              exists: true,
              path: expandedPath,
              source: "session",
              pendingClaudeMd: checkPendingClaudeMd(expandedPath),
              branchStatus: checkBranchStatus(expandedPath),
            });
          }
        }
      } catch {
        // Ignore session file errors, fall through to pattern matching
      }
    }

    // 2. Check worktree patterns: {worktreeParentDir}/{repoName}-{ticketId}
    const worktreeParentDir = getWorktreeParentDir();
    const repoNames = getConfiguredReposList().map((r) => r.name);
    for (const repoName of repoNames) {
      const worktreePath = join(
        worktreeParentDir,
        `${repoName}-${sanitizedTicket}`
      );
      if (existsSync(worktreePath)) {
        return NextResponse.json({
          exists: true,
          path: worktreePath,
          source: "worktree",
          pendingClaudeMd: checkPendingClaudeMd(worktreePath),
          branchStatus: checkBranchStatus(worktreePath),
        });
      }
    }

    // No worktree found
    return NextResponse.json({
      exists: false,
      path: null,
      pendingClaudeMd: null,
      branchStatus: null,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        error: `Failed to check work directory: ${errorMessage}`,
      },
      { status: 500 }
    );
  }
}
