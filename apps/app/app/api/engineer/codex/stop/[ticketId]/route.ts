import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { resolveReviewReadPaths } from "@/lib/engineer/process-utils";
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
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  // Write paths always target .closedloop-ai/work
  const workDir = join(worktreeDir, ".closedloop-ai", "work");
  return {
    worktreeDir,
    workDir,
    statePath: join(workDir, `codex-review-${provider}.json`),
    logPath: join(workDir, `codex-review-${provider}.log`),
    pidPath: join(workDir, `codex-review-${provider}.pid`),
    findingsPath: join(workDir, `review-findings-${provider}.json`),
  };
}

/**
 * POST /api/engineer/codex/stop/[ticketId]
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

  const { worktreeDir } = getReviewPaths(ticketId, repoPath, provider);
  // Note: do NOT call checkLegacyProcessAndMigrate here. The stop route
  // needs to read state from wherever it exists (legacy or new) to find and
  // kill the review process. Migration would rename the dir while a codex
  // review (whose PID is in codex-review-*.pid, not process.pid) is running.

  // Read paths resolve per-file across both dirs
  const { statePath: readStatePath } = resolveReviewReadPaths(
    worktreeDir,
    provider
  );
  // Write path always targets .closedloop-ai/work
  const { statePath: writeStatePath } = getReviewPaths(
    ticketId,
    repoPath,
    provider
  );

  if (!existsSync(readStatePath)) {
    return NextResponse.json({ error: "No review found" }, { status: 404 });
  }

  try {
    const stateContent = await readFile(readStatePath, "utf-8");
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

    // Update state — always write to canonical .closedloop-ai/work
    const updatedState: ReviewState = {
      ...state,
      status: "stopped",
      completedAt: new Date().toISOString(),
    };
    await mkdir(join(writeStatePath, ".."), { recursive: true });
    await writeFile(writeStatePath, JSON.stringify(updatedState, null, 2));

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
  const { worktreeDir } = getReviewPaths(ticketId, repoPath, p);
  // Resolve each file independently for reads
  const { statePath } = resolveReviewReadPaths(worktreeDir, p);

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

  // Delete from both roots explicitly to catch all copies
  const newWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  const oldWorkDir = join(worktreeDir, ".claude", "work");
  const fileNames = [
    `codex-review-${p}.json`,
    `codex-review-${p}.log`,
    `codex-review-${p}.pid`,
    `review-findings-${p}.json`,
  ];
  const allPaths = new Set(
    fileNames.flatMap((f) => [join(newWorkDir, f), join(oldWorkDir, f)])
  );
  for (const filePath of allPaths) {
    if (existsSync(filePath)) {
      await unlink(filePath).catch(() => {});
      deleted.push(basename(filePath));
    }
  }
}
