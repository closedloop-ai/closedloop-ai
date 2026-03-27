import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { readLiveActivity } from "@/lib/engineer/jsonl-activity";
import { isProcessRunning, readProcessPid } from "@/lib/engineer/process-utils";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

/**
 * Check if completion can be detected from logs when state.json appears stale.
 * This handles the case where the orchestrator outputted <promise>COMPLETE</promise>
 * but failed to update state.json properly.
 */
async function detectCompletionFromLogs(
  worktreeDir: string
): Promise<{ completed: boolean; awaitingUser: boolean; timestamp?: string }> {
  const logPath = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "closedloop-launch.log"
  );

  if (!existsSync(logPath)) {
    return { completed: false, awaitingUser: false };
  }

  try {
    const logContent = await readFile(logPath, "utf-8");

    // Check for completion promise in logs
    if (logContent.includes("<promise>COMPLETE</promise>")) {
      // Get log file modification time as approximate completion time
      const logStats = await stat(logPath);
      const timestamp = logStats.mtime.toISOString();

      // Check if AWAITING_USER was the reason (plan created, needs review)
      const awaitingUser =
        logContent.includes("AWAITING_USER") ||
        logContent.includes("Plan created") ||
        logContent.includes("requires review");

      return { completed: true, awaitingUser, timestamp };
    }

    return { completed: false, awaitingUser: false };
  } catch {
    return { completed: false, awaitingUser: false };
  }
}

type EffectiveState = {
  status: string;
  phase: string;
  fallbackDetected: boolean;
  processRunning: boolean;
  pid: number | null;
};

/**
 * Resolve the effective status/phase when state.json might be stale.
 * Uses early returns to keep each check at a single nesting level.
 */
async function resolveEffectiveState(
  worktreeDir: string,
  state: { status?: string; phase?: string }
): Promise<EffectiveState> {
  const status = state.status || "UNKNOWN";
  const phase = state.phase || "Unknown";
  const pid = await readProcessPid(worktreeDir);
  const processRunning = pid !== null && isProcessRunning(pid);
  const base = { processRunning, pid };

  if (status !== "IN_PROGRESS") {
    return { status, phase, fallbackDetected: false, ...base };
  }

  // Process liveness check: if PID file exists but process is dead, mark as STOPPED
  if (pid !== null && !processRunning) {
    console.log(
      `[Status API] Process ${pid} is dead but state shows IN_PROGRESS, marking as STOPPED`
    );
    return {
      status: "STOPPED",
      phase: "Process stopped unexpectedly",
      fallbackDetected: false,
      ...base,
    };
  }

  // If the loop lock file exists, the loop is actively running — trust state.json
  const lockPath = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".learnings",
    ".lock"
  );
  if (existsSync(lockPath)) {
    return { status, phase, fallbackDetected: false, ...base };
  }

  // Check if state.json was updated recently (within last 2 minutes)
  const statePath = join(worktreeDir, ".closedloop-ai", "work", "state.json");
  let stateAge = Number.POSITIVE_INFINITY;
  try {
    const stateStats = await stat(statePath);
    stateAge = Date.now() - stateStats.mtime.getTime();
  } catch {
    // state.json removed by concurrent kill -- treat as stale
  }
  if (stateAge <= 2 * 60 * 1000) {
    return { status, phase, fallbackDetected: false, ...base };
  }

  // State is stale — check logs for completion signals
  const fallback = await detectCompletionFromLogs(worktreeDir);
  if (!fallback.completed) {
    return { status, phase, fallbackDetected: false, ...base };
  }

  const resolvedStatus = fallback.awaitingUser ? "AWAITING_USER" : "COMPLETED";
  const resolvedPhase = fallback.awaitingUser
    ? "Completed (awaiting review)"
    : "Completed";
  console.log(
    `[Status API] Fallback detection: state.json stale (${Math.round(stateAge / 1000)}s old), loop not running, logs indicate ${resolvedStatus}`
  );
  return {
    status: resolvedStatus,
    phase: resolvedPhase,
    fallbackDetected: true,
    ...base,
  };
}

type TaskProgress = {
  pending: number;
  completed: number;
  total: number;
};

/**
 * Read task progress from plan.json if it exists.
 */
async function readPlanProgress(
  planPath: string
): Promise<{ taskProgress?: TaskProgress; currentTaskId?: string }> {
  if (!existsSync(planPath)) {
    return {};
  }

  try {
    let planContent = await readFile(planPath, "utf-8");
    // Strip trailing commas before closing brackets (malformed JSON fix)
    planContent = planContent.replaceAll(/,\s*([\]}])/g, "$1");
    const plan = JSON.parse(planContent);
    const pendingTasks: unknown[] = Array.isArray(plan.pendingTasks)
      ? plan.pendingTasks
      : [];
    const completedTasks: unknown[] = Array.isArray(plan.completedTasks)
      ? plan.completedTasks
      : [];
    const firstPending = pendingTasks[0] as { id?: string } | undefined;
    return {
      taskProgress: {
        pending: pendingTasks.length,
        completed: completedTasks.length,
        total: pendingTasks.length + completedTasks.length,
      },
      currentTaskId: firstPending?.id,
    };
  } catch {
    return {};
  }
}

type ActiveAgent = {
  agentId: string;
  agentType: string;
  agentName: string;
  startedAt: string;
};

/**
 * Read active agents from the .agent-types directory.
 * Each file (named by UUID) contains: agent_type|agent_short_name|started_at
 * Skip retry-tracking files (filenames containing "-").
 *
 */
async function readActiveAgents(worktreeDir: string): Promise<ActiveAgent[]> {
  const agentTypesDir = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".agent-types"
  );

  if (!existsSync(agentTypesDir)) {
    return [];
  }

  const agents: ActiveAgent[] = [];

  try {
    const files = await readdir(agentTypesDir);

    for (const file of files) {
      // Skip retry-tracking files (contain "-" which UUIDs don't have in the filename)
      if (file.includes("-")) {
        continue;
      }

      try {
        const content = await readFile(join(agentTypesDir, file), "utf-8");
        const [agentType, agentName, startedAt] = content.trim().split("|");
        if (agentType && agentName) {
          agents.push({
            agentId: file,
            agentType,
            agentName,
            startedAt: startedAt || "",
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip unreadable dir
  }

  return agents;
}

/**
 * API route to read state.json from a Symphony worktree
 *
 * GET /api/symphony/status/[ticketId]?repo=~/Source/claude_code
 *
 * Returns the current Symphony execution status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const { ticketId } = await params;
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get("repo");

    // Validate inputs
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

    // Security check
    if (!isRepoAllowed(repoPath)) {
      return NextResponse.json(
        { error: `Repository not allowed: ${repoPath}` },
        { status: 403 }
      );
    }

    // Sanitize ticket identifier
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");

    // Build worktree path
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const worktreeParentDir = getWorktreeParentDir();
    const worktreeDir = join(
      worktreeParentDir,
      `${repoName}-${sanitizedTicket}`
    );
    const workDir = join(worktreeDir, ".closedloop-ai", "work");
    const statePath = join(workDir, "state.json");

    // Check if worktree exists
    if (!existsSync(worktreeDir)) {
      return NextResponse.json({
        exists: false,
        phase: null,
        status: null,
        message: "Worktree not found",
      });
    }

    // Check if state.json exists
    if (!existsSync(statePath)) {
      const pid = await readProcessPid(worktreeDir);
      const processRunning = pid !== null && isProcessRunning(pid);

      // Process died before writing state.json — report STOPPED instead of STARTING forever
      if (pid !== null && !processRunning) {
        return NextResponse.json({
          exists: true,
          stateExists: false,
          phase: "Process failed to start",
          status: "STOPPED",
          pid,
          processRunning: false,
          message:
            "Process exited before initializing. Check closedloop-launch.log.",
        });
      }

      const liveActivity = await readLiveActivity(worktreeDir);

      return NextResponse.json({
        exists: true,
        stateExists: false,
        phase: "Initializing",
        status: "STARTING",
        pid,
        processRunning: pid !== null,
        message: "ClosedLoop is starting up...",
        liveActivity,
      });
    }

    // Read and parse state.json
    const stateContent = await readFile(statePath, "utf-8");
    const state = JSON.parse(stateContent);

    // Resolve effective status (handles stale state.json fallback detection)
    const effective = await resolveEffectiveState(worktreeDir, state);

    // Read task progress from plan.json
    const planPath = join(workDir, "plan.json");
    const planExists = existsSync(planPath);
    const { taskProgress, currentTaskId } = await readPlanProgress(planPath);

    const activeAgents = await readActiveAgents(worktreeDir);

    return NextResponse.json({
      exists: true,
      stateExists: true,
      phase: effective.phase,
      status: effective.status,
      timestamp: state.timestamp,
      raw: state,
      worktreeDir,
      fallbackDetected: effective.fallbackDetected,
      planExists,
      taskProgress,
      currentTaskId,
      activeAgents,
      pid: effective.pid,
      processRunning: effective.processRunning,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read status: ${errorMessage}` },
      { status: 500 }
    );
  }
}
