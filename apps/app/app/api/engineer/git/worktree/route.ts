import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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

function removeNonWorktree(expandedPath: string, force: boolean): NextResponse {
  if (force) {
    rmSync(expandedPath, { recursive: true, force: true });
    return NextResponse.json({
      success: true,
      message: "Directory removed (not a git worktree)",
    });
  }
  return NextResponse.json(
    { error: "Path is not a git worktree" },
    { status: 400 }
  );
}

function forceRemoveWorktree(expandedPath: string): NextResponse {
  spawnSync("git", ["worktree", "prune"], { stdio: "pipe", cwd: expandedPath });
  rmSync(expandedPath, { recursive: true, force: true });
  return NextResponse.json({
    success: true,
    message: "Worktree forcefully removed",
  });
}

function handleWorktreeRemoveError(
  err: unknown,
  force: boolean,
  expandedPath: string
): NextResponse {
  const errorMessage = err instanceof Error ? err.message : "Unknown error";

  if (errorMessage.includes("contains modified or untracked files") && !force) {
    return NextResponse.json(
      {
        error: "Worktree has uncommitted changes",
        hasChanges: true,
        message: "Use force=true to remove anyway",
      },
      { status: 409 }
    );
  }

  if (force) {
    return forceRemoveWorktree(expandedPath);
  }

  return NextResponse.json(
    { error: `Failed to remove worktree: ${errorMessage}` },
    { status: 500 }
  );
}

function removeWorktree(expandedPath: string, force: boolean): NextResponse {
  if (!existsSync(expandedPath)) {
    return NextResponse.json({
      success: true,
      message: "Worktree does not exist",
    });
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
    const result = spawnSync("git", args, { stdio: "pipe", cwd: expandedPath });
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.toString() ?? "git worktree remove failed"
      );
    }
    return NextResponse.json({
      success: true,
      message: "Worktree removed successfully",
    });
  } catch (err) {
    return handleWorktreeRemoveError(err, force, expandedPath);
  }
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

    return removeWorktree(expandedPath, force);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to process worktree removal: ${errorMessage}` },
      { status: 500 }
    );
  }
}
