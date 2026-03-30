import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { getReviewPaths, isProcessRunning } from "@/lib/engineer/process-utils";
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
  provider?: "claude" | "codex";
  sessionId?: string;
  config: {
    model: string;
    reasoningEffort: string;
    reviewMode: "uncommitted" | "base";
    baseBranch: string;
    instructions?: string;
  };
};

/** If state says "running" but the process is dead, mark it "stopped". */
function reconcileProcessStatus(state: ReviewState): boolean {
  if (state.status !== "running" || !state.pid) {
    return false;
  }
  const alive = isProcessRunning(state.pid);
  if (!alive) {
    state.status = "stopped";
  }
  return alive;
}

const MAX_LOG_BYTES = 100 * 1024;

/** Read the log file, tailing to the last 100 KB for large files. */
async function readLogTail(
  logPath: string
): Promise<{ log: string; logSize: number }> {
  if (!existsSync(logPath)) {
    return { log: "", logSize: 0 };
  }
  const logStats = await stat(logPath);
  const logSize = logStats.size;
  if (logSize <= MAX_LOG_BYTES) {
    return { log: await readFile(logPath, "utf-8"), logSize };
  }
  const buffer = Buffer.alloc(MAX_LOG_BYTES);
  const fd = await import("node:fs/promises").then((fs) =>
    fs.open(logPath, "r")
  );
  await fd.read(buffer, 0, buffer.length, logSize - buffer.length);
  await fd.close();
  return { log: buffer.toString("utf-8"), logSize };
}

/**
 * GET /api/codex/status/[ticketId]?repo=~/Source/claude_code
 *
 * Returns the current codex review status and logs
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");

  if (!ticketId) {
    return NextResponse.json(
      { error: "ticketId is required" },
      { status: 400 }
    );
  }

  if (!repoPath) {
    return NextResponse.json(
      { error: "repo query parameter is required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const provider = searchParams.get("provider"); // optional — if omitted, scan both

  // Build worktree path
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const expandedRepoPath = expandHome(repoPath);
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  // Check if worktree exists
  if (!existsSync(worktreeDir)) {
    return NextResponse.json({
      hasReview: false,
      worktreeDir,
      message: "Worktree not found",
    });
  }

  // Determine which provider's files to read
  const targetProvider = provider ?? resolveProvider(worktreeDir);
  if (!targetProvider) {
    return NextResponse.json({
      hasReview: false,
      worktreeDir,
      message: "No review has been started",
    });
  }

  const { statePath, logPath } = getReviewPaths(worktreeDir, targetProvider);

  if (!existsSync(statePath)) {
    return NextResponse.json({
      hasReview: false,
      worktreeDir,
      message: "No review has been started",
    });
  }

  try {
    const stateContent = await readFile(statePath, "utf-8");
    const state: ReviewState = JSON.parse(stateContent);
    const processRunning = reconcileProcessStatus(state);
    const { log, logSize } = await readLogTail(logPath);

    return NextResponse.json({
      hasReview: true,
      worktreeDir,
      status: state.status,
      processRunning,
      pid: state.pid,
      provider: state.provider,
      sessionId: state.sessionId,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      exitCode: state.exitCode,
      config: state.config,
      log,
      logSize,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read status: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/codex/status/[ticketId]?repo=~/Source/claude_code&provider=claude
 *
 * Clears the review state and log files so the review is no longer visible.
 * If provider is specified, only deletes that provider's files. Otherwise deletes both.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get("repo");
  const provider = searchParams.get("provider");

  if (!(ticketId && repoPath)) {
    return NextResponse.json(
      { error: "ticketId and repo are required" },
      { status: 400 }
    );
  }

  if (!isRepoAllowed(repoPath)) {
    return NextResponse.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const expandedRepoPath = expandHome(repoPath);
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);

  const providers = provider ? [provider] : ["claude", "codex"];
  const workDir = join(worktreeDir, ".closedloop-ai", "work");
  const filesToDelete = providers.flatMap((p) => [
    join(workDir, `codex-review-${p}.json`),
    join(workDir, `codex-review-${p}.log`),
    join(workDir, `codex-review-${p}.pid`),
    join(workDir, `review-findings-${p}.json`),
  ]);

  await Promise.all(filesToDelete.map((f) => unlink(f).catch(() => {})));

  return NextResponse.json({ success: true });
}

/** Scan for any existing provider state file (backwards compat when no provider param given) */
function resolveProvider(worktreeDir: string): string | null {
  const rpWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  // First pass: prefer the provider with a live running review
  for (const p of ["claude", "codex"]) {
    const statePath = join(rpWorkDir, `codex-review-${p}.json`);
    if (!existsSync(statePath)) {
      continue;
    }
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      if (
        state.status === "running" &&
        typeof state.pid === "number" &&
        isProcessRunning(state.pid)
      ) {
        return p;
      }
    } catch {
      // Parse error -- skip
    }
  }
  // Fallback: return the first existing provider regardless of liveness
  for (const p of ["claude", "codex"]) {
    if (existsSync(join(rpWorkDir, `codex-review-${p}.json`))) {
      return p;
    }
  }
  return null;
}
