import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

export const dynamic = "force-dynamic";

type ReviewState = {
  status: "running" | "completed" | "failed" | "stopped";
  pid?: number;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  config: {
    model: string;
    reasoningEffort: string;
    reviewMode: "uncommitted" | "base";
    baseBranch: string;
    instructions?: string;
  };
};

function getReviewPaths(ticketId: string, repoPath: string, provider: string) {
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const expandedRepoPath = expandHome(repoPath);
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const workDir = join(
    worktreeParentDir,
    `${repoName}-${sanitizedTicket}`,
    ".claude",
    "work"
  );
  return {
    workDir,
    statePath: join(workDir, `codex-review-${provider}.json`),
    logPath: join(workDir, `codex-review-${provider}.log`),
    pidPath: join(workDir, `codex-review-${provider}.pid`),
    findingsPath: join(workDir, `review-findings-${provider}.json`),
  };
}

/**
 * POST /api/codex/stop/[ticketId]
 * Body: { repo: string }
 *
 * Stops a running codex review
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const body = await request.json();
  const repoPath = body.repo;
  const provider: string = body.provider ?? "codex";

  if (!ticketId) {
    return NextResponse.json(
      { error: "ticketId is required" },
      { status: 400 }
    );
  }

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo is required in body" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const { statePath } = getReviewPaths(ticketId, repoPath, provider);

  if (!existsSync(statePath)) {
    return NextResponse.json({ error: "No review found" }, { status: 404 });
  }

  try {
    const stateContent = await readFile(statePath, "utf-8");
    const state: ReviewState = JSON.parse(stateContent);

    if (state.status !== "running") {
      return NextResponse.json({
        stopped: false,
        message: `Review is not running (status: ${state.status})`,
      });
    }

    if (!state.pid) {
      return NextResponse.json(
        { error: "No PID found for review" },
        { status: 400 }
      );
    }

    // Try to kill the process
    try {
      process.kill(state.pid, "SIGTERM");
      console.log(`[codex-stop] Sent SIGTERM to pid ${state.pid}`);
    } catch {
      // Process may already be dead
      console.log(`[codex-stop] Process ${state.pid} already dead`);
    }

    // Update state
    const updatedState: ReviewState = {
      ...state,
      status: "stopped",
      completedAt: new Date().toISOString(),
    };
    await writeFile(statePath, JSON.stringify(updatedState, null, 2));

    return NextResponse.json({ stopped: true, pid: state.pid });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to stop review: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/codex/stop/[ticketId]?repo=...
 *
 * Deletes review state and log files from disk.
 * Also kills the process if still running.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const repoPath = request.nextUrl.searchParams.get("repo");
  const provider = request.nextUrl.searchParams.get("provider");

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo query param is required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const providers = provider ? [provider] : ["claude", "codex"];
  const deleted: string[] = [];

  for (const p of providers) {
    await deleteReviewFiles(ticketId, repoPath, p, deleted);
  }

  return NextResponse.json({ deleted });
}

async function deleteReviewFiles(
  ticketId: string,
  repoPath: string,
  p: string,
  deleted: string[]
): Promise<void> {
  const { statePath, logPath, pidPath, findingsPath } = getReviewPaths(
    ticketId,
    repoPath,
    p
  );

  // Kill running process if any
  if (existsSync(statePath)) {
    try {
      const state: ReviewState = JSON.parse(await readFile(statePath, "utf-8"));
      if (state.status === "running" && state.pid) {
        try {
          process.kill(state.pid, "SIGTERM");
        } catch {
          // Already dead
        }
      }
    } catch {
      // Corrupted state — continue with deletion
    }
  }

  for (const path of [statePath, logPath, pidPath, findingsPath]) {
    if (existsSync(path)) {
      await unlink(path).catch(() => {});
      deleted.push(basename(path));
    }
  }
}
