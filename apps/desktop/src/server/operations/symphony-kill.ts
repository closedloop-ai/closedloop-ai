import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { JobStore, LocalJob } from "../../main/job-store.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { expandHome, resolveWorktreeDir } from "./symphony-utils.js";

type ResolveResult =
  | { pid: number; pidFilePath: string | null; worktreeDir: string | null }
  | { noPidFile: true; worktreeDir: string }
  | { error: string; status: number };

function findJobForKill(
  jobStore: JobStore,
  pid: number | null,
  worktreeDir: string | null
): LocalJob | undefined {
  const running = jobStore.listRunning();
  if (pid != null) {
    const byPid = running.find((j) => j.pid === pid);
    if (byPid) {
      return byPid;
    }
  }
  if (worktreeDir != null) {
    return running.find((j) => j.worktreeDir === worktreeDir);
  }
  return undefined;
}

function markJobStopped(
  jobStore: JobStore | undefined,
  pid: number | null,
  worktreeDir: string | null
): void {
  if (!jobStore) {
    return;
  }
  const job = findJobForKill(jobStore, pid, worktreeDir);
  if (job) {
    const now = new Date().toISOString();
    jobStore.upsert({
      ...job,
      status: "STOPPED",
      updatedAt: now,
      completedAt: now,
    });
  }
}

export function registerSymphonyKillRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  jobStore?: JobStore
): void {
  dispatcher.register("POST", "/api/gateway/symphony/kill", async (context) => {
    try {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const resolved = resolvePid(body, getAllowedDirectories);
      if ("error" in resolved) {
        json(context, resolved.status, { error: resolved.error });
        return;
      }

      if ("noPidFile" in resolved) {
        cancelLoop(resolved.worktreeDir);
        markStateAsStopped(resolved.worktreeDir);
        markJobStopped(jobStore, null, resolved.worktreeDir);
        json(context, 200, {
          success: true,
          message: "No process to kill (no PID file), state marked as stopped",
        });
        return;
      }

      const { pid, pidFilePath, worktreeDir } = resolved;

      if (worktreeDir) {
        cancelLoop(worktreeDir);
      }

      try {
        process.kill(pid, 0);
      } catch {
        deletePidFile(pidFilePath);
        if (worktreeDir) {
          markStateAsStopped(worktreeDir);
        }
        markJobStopped(jobStore, pid, worktreeDir);
        json(context, 200, {
          success: true,
          message: "Process already terminated",
          pid,
        });
        return;
      }

      try {
        process.kill(-pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          process.kill(pid, 0);
          process.kill(-pid, "SIGKILL");
        } catch {
          // Process already gone
        }

        deletePidFile(pidFilePath);
        if (worktreeDir) {
          markStateAsStopped(worktreeDir);
        }
        markJobStopped(jobStore, pid, worktreeDir);

        json(context, 200, {
          success: true,
          message: "Process terminated",
          pid,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        if (errorMessage.includes("ESRCH")) {
          deletePidFile(pidFilePath);
          if (worktreeDir) {
            markStateAsStopped(worktreeDir);
          }
          if (jobStore) {
            const job = findJobForKill(jobStore, pid, worktreeDir);
            if (job) {
              const now = new Date().toISOString();
              jobStore.upsert({
                ...job,
                status: "STOPPED",
                updatedAt: now,
                completedAt: now,
              });
            }
          }
          json(context, 200, {
            success: true,
            message: "Process already terminated",
            pid,
          });
          return;
        }

        json(context, 500, {
          error: `Failed to kill process: ${errorMessage}`,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      json(context, 500, {
        error: `Failed to process kill request: ${errorMessage}`,
      });
    }
  });
}
function resolvePid(
  body: Record<string, unknown>,
  getAllowedDirectories: () => string[]
): ResolveResult {
  const pid = typeof body.pid === "number" ? body.pid : null;
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : null;
  const repoPath = typeof body.repoPath === "string" ? body.repoPath : null;

  if (pid && Number.isFinite(pid)) {
    return { pid, pidFilePath: null, worktreeDir: null };
  }

  if (ticketId && repoPath) {
    const expandedRepoPath = expandHome(repoPath);

    try {
      assertPathAllowed(expandedRepoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        return { error: "directory not allowed", status: 403 };
      }
      throw error;
    }

    const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
    const candidate = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      "process.pid"
    );
    const pidFilePath = existsSync(candidate) ? candidate : null;
    if (!pidFilePath) {
      return { noPidFile: true, worktreeDir };
    }

    try {
      const pidContent = readFileSync(pidFilePath, "utf-8");
      const resolvedPid = Number.parseInt(pidContent.trim(), 10);
      if (Number.isNaN(resolvedPid)) {
        return { error: "Invalid PID in process.pid file", status: 500 };
      }

      return { pid: resolvedPid, pidFilePath, worktreeDir };
    } catch {
      return { error: "Failed to read process.pid file", status: 500 };
    }
  }

  return {
    error: "Either pid or (ticketId + repoPath) is required",
    status: 400,
  };
}

function cancelLoop(worktreeDir: string): boolean {
  const stateFile = path.join(
    worktreeDir,
    ".closedloop-ai",
    "symphony-loop.local.md"
  );
  try {
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function clearAgentTypes(worktreeDir: string): void {
  const agentTypesDir = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".agent-types"
  );
  try {
    if (!existsSync(agentTypesDir)) {
      return;
    }

    for (const file of readdirSync(agentTypesDir)) {
      unlinkSync(path.join(agentTypesDir, file));
    }
  } catch {
    // Best effort
  }
}

function markStateAsStopped(worktreeDir: string): void {
  const statePath = path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "state.json"
  );

  try {
    let state: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      const content = readFileSync(statePath, "utf-8");
      state = JSON.parse(content) as Record<string, unknown>;
    }

    state.status = "STOPPED";
    state.phase = "Process stopped by user";
    state.timestamp = new Date().toISOString();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best effort only
  }

  clearAgentTypes(worktreeDir);
}

function deletePidFile(pidFilePath: string | null): void {
  if (!pidFilePath) {
    return;
  }

  try {
    if (existsSync(pidFilePath)) {
      unlinkSync(pidFilePath);
    }
  } catch {
    // Best effort only
  }
}
