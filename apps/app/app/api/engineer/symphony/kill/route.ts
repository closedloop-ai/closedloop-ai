import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";

type ResolveResult =
  | { pid: number; pidFilePath: string | null; worktreeDir: string | null }
  | { noPidFile: true; worktreeDir: string }
  | { error: string; status: number };

/**
 * Resolve PID from either direct pid parameter or ticketId + repoPath.
 * Returns { pid, pidFilePath, worktreeDir }, { noPidFile, worktreeDir }, or { error }.
 */
function resolvePid(body: {
  pid?: number;
  ticketId?: string;
  repoPath?: string;
}): ResolveResult {
  const { pid, ticketId, repoPath } = body;

  // Direct PID provided
  if (pid && typeof pid === "number") {
    return { pid, pidFilePath: null, worktreeDir: null };
  }

  // Resolve from ticketId + repoPath
  if (ticketId && repoPath) {
    if (!isRepoAllowed(repoPath)) {
      return { error: `Repository not allowed: ${repoPath}`, status: 403 };
    }

    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const worktreeParentDir = getWorktreeParentDir();
    const worktreeDir = join(
      worktreeParentDir,
      `${repoName}-${sanitizedTicket}`
    );
    const pidFile = join(worktreeDir, ".closedloop-ai", "work", "process.pid");

    if (existsSync(pidFile)) {
      try {
        const content = readFileSync(pidFile, "utf-8");
        const resolvedPid = Number.parseInt(content.trim(), 10);
        if (!Number.isNaN(resolvedPid)) {
          return { pid: resolvedPid, pidFilePath: pidFile, worktreeDir };
        }
      } catch {
        // Can't read -- fall through
      }
    }

    // No PID file - return worktreeDir so we can still update state.json
    return { noPidFile: true, worktreeDir };
  }

  return {
    error: "Either pid or (ticketId + repoPath) is required",
    status: 400,
  };
}

/**
 * Delete the PID file if it exists.
 */
function deletePidFile(pidFilePath: string | null): void {
  if (pidFilePath === null) {
    return;
  }
  try {
    if (existsSync(pidFilePath)) {
      unlinkSync(pidFilePath);
    }
  } catch {
    // Ignore deletion errors
  }
}

/**
 * API route to kill a Symphony process
 *
 * POST /api/engineer/symphony/kill
 * Body: { pid: number } OR { ticketId: string, repoPath: string }
 *
 * Kills the process group using negative PID to ensure
 * all child processes are also terminated.
 */
/**
 * Cancel the symphony loop by deleting its state file.
 * This is the equivalent of /ralph-loop:cancel-ralph — the loop checks this file
 * between iterations, and update_iteration() will fail under set -e when it's gone.
 */
function cancelLoop(worktreeDir: string): boolean {
  const stateFile = join(
    worktreeDir,
    ".closedloop-ai",
    "closedloop-loop.local.md"
  );
  if (!existsSync(stateFile)) {
    return false;
  }
  try {
    unlinkSync(stateFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear .agent-types/ so the UI doesn't show stale subagent indicators on resume.
 */
function clearAgentTypes(worktreeDir: string): void {
  const agentTypesDir = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".agent-types"
  );
  try {
    if (existsSync(agentTypesDir)) {
      for (const file of readdirSync(agentTypesDir)) {
        unlinkSync(join(agentTypesDir, file));
      }
    }
  } catch {
    // Best effort
  }
}

/**
 * Update state.json to mark status as STOPPED.
 */
function markStateAsStopped(worktreeDir: string): void {
  const workDir = join(worktreeDir, ".closedloop-ai", "work");
  const statePath = join(workDir, "state.json");
  try {
    let state: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      const content = readFileSync(statePath, "utf-8");
      state = JSON.parse(content);
    }
    state.status = "STOPPED";
    state.phase = "Process stopped by user";
    state.timestamp = new Date().toISOString();
    mkdirSync(workDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // Ignore errors - best effort
  }
  clearAgentTypes(worktreeDir);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const resolved = resolvePid(body);

    if ("error" in resolved) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }

    // Handle case where there's no PID file (legacy tickets)
    if ("noPidFile" in resolved) {
      cancelLoop(resolved.worktreeDir);
      markStateAsStopped(resolved.worktreeDir);
      return NextResponse.json({
        success: true,
        message: "No process to kill (no PID file), state marked as stopped",
      });
    }

    // At this point we know resolved has pid and pidFilePath
    const { pid, pidFilePath, worktreeDir } = resolved as {
      pid: number;
      pidFilePath: string | null;
      worktreeDir: string | null;
    };

    // Cancel the loop first — delete the state file so no new iteration starts
    if (worktreeDir) {
      cancelLoop(worktreeDir);
    }

    // Check if process exists before trying to kill
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
    } catch {
      // Process doesn't exist (already dead)
      deletePidFile(pidFilePath);
      if (worktreeDir) {
        markStateAsStopped(worktreeDir);
      }
      return NextResponse.json({
        success: true,
        message: "Process already terminated",
        pid,
      });
    }

    // Kill the process group (negative PID kills all processes in the group)
    // Since we spawned with detached: true, the PID is also the PGID
    try {
      process.kill(-pid, "SIGTERM");

      // Give it a moment to terminate gracefully
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if it's still alive and force kill if needed
      try {
        process.kill(pid, 0);
        // Still alive, send SIGKILL
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process is dead, good
      }

      // Delete the PID file and update state after successful kill
      deletePidFile(pidFilePath);
      if (worktreeDir) {
        markStateAsStopped(worktreeDir);
      }

      return NextResponse.json({
        success: true,
        message: "Process terminated",
        pid,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      // ESRCH means process not found - that's OK
      if (errorMessage.includes("ESRCH")) {
        deletePidFile(pidFilePath);
        if (worktreeDir) {
          markStateAsStopped(worktreeDir);
        }
        return NextResponse.json({
          success: true,
          message: "Process already terminated",
          pid,
        });
      }

      return NextResponse.json(
        { error: `Failed to kill process: ${errorMessage}` },
        { status: 500 }
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to process kill request: ${errorMessage}` },
      { status: 500 }
    );
  }
}
