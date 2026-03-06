import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getSelfLearningScriptPath,
  getWorktreesWithPendingLearnings,
} from "@/lib/engineer/repos";

const STATUS_DIR = join(homedir(), ".closedloop-ai", "learnings");
const STATUS_PATH = join(STATUS_DIR, "batch-processing-status.json");

// Legacy location — migrate on first access
const LEGACY_STATUS_DIR = join(homedir(), ".claude", ".learnings");
const LEGACY_STATUS_PATH = join(
  LEGACY_STATUS_DIR,
  "batch-processing-status.json"
);

function migrateLegacyLearningsDir(): void {
  if (!existsSync(LEGACY_STATUS_DIR)) {
    return;
  }

  mkdirSync(STATUS_DIR, { recursive: true });

  // Move batch-processing-status.json if it exists
  if (existsSync(LEGACY_STATUS_PATH) && !existsSync(STATUS_PATH)) {
    try {
      renameSync(LEGACY_STATUS_PATH, STATUS_PATH);
    } catch {
      // Cross-device rename — fall back to copy+delete
      try {
        writeFileSync(STATUS_PATH, readFileSync(LEGACY_STATUS_PATH));
        rmSync(LEGACY_STATUS_PATH, { force: true });
      } catch {
        // Best-effort
      }
    }
  }

  // Move log file if it exists
  const legacyLog = join(LEGACY_STATUS_DIR, "batch-process-learnings.log");
  const newLog = join(STATUS_DIR, "batch-process-learnings.log");
  if (existsSync(legacyLog) && !existsSync(newLog)) {
    try {
      renameSync(legacyLog, newLog);
    } catch {
      try {
        writeFileSync(newLog, readFileSync(legacyLog));
        rmSync(legacyLog, { force: true });
      } catch {
        // Best-effort
      }
    }
  }

  // Remove legacy dir if empty
  try {
    if (readdirSync(LEGACY_STATUS_DIR).length === 0) {
      rmSync(LEGACY_STATUS_DIR, { recursive: true, force: true });
    }
  } catch {
    // Best-effort
  }
}

/**
 * GET /api/engineer/symphony/process-all-learnings
 *
 * Returns the current batch processing status.
 */
export function GET() {
  migrateLegacyLearningsDir();

  if (!existsSync(STATUS_PATH)) {
    return Response.json({ status: "none" });
  }

  try {
    const content = readFileSync(STATUS_PATH, "utf-8");
    const status = JSON.parse(content);
    return Response.json(status);
  } catch {
    return Response.json({ status: "none" });
  }
}

/**
 * POST /api/engineer/symphony/process-all-learnings
 *
 * Processes pending learnings across all worktrees.
 * Spawns a detached bash wrapper that runs process-chat-learnings.sh
 * for each worktree sequentially.
 */
export function POST() {
  migrateLegacyLearningsDir();

  const worktrees = getWorktreesWithPendingLearnings();
  if (worktrees.length === 0) {
    return Response.json({
      status: "skipped",
      reason: "No pending learnings found",
    });
  }

  const scriptPath = getSelfLearningScriptPath();
  if (!scriptPath) {
    return new Response(
      JSON.stringify({
        error: "process-chat-learnings.sh not found in self-learning plugin",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Write initial status
  mkdirSync(STATUS_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  writeFileSync(
    STATUS_PATH,
    JSON.stringify({
      status: "processing",
      worktreeCount: worktrees.length,
      totalPending: worktrees.reduce((s, w) => s + w.pendingCount, 0),
      processedWorktrees: 0,
      startedAt,
    })
  );

  // Build bash commands: run script for each worktree, update progress after each
  const statusPathEscaped = JSON.stringify(STATUS_PATH);
  const totalPending = worktrees.reduce((s, w) => s + w.pendingCount, 0);

  const perWorktreeCommands = worktrees
    .map((w, i) =>
      [
        `echo "[batch] Processing ${w.worktreeDir}..."`,
        `${JSON.stringify(scriptPath)} ${JSON.stringify(w.claudeWorkDir)} || true`,
        `printf '{"status":"processing","worktreeCount":${worktrees.length},"totalPending":${totalPending},"processedWorktrees":${i + 1},"startedAt":"%s"}' "${startedAt}" > ${statusPathEscaped}`,
      ].join(" && ")
    )
    .join("\n");

  const wrapperScript = [
    "#!/usr/bin/env bash",
    perWorktreeCommands,
    `printf '{"status":"completed","worktreeCount":${worktrees.length},"totalPending":${totalPending},"processedWorktrees":${worktrees.length},"completedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > ${statusPathEscaped}`,
  ].join("\n");

  const logDir = STATUS_DIR;
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "batch-process-learnings.log");
  const logFd = openSync(logFile, "a");

  try {
    const child = spawn("bash", ["-c", wrapperScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      },
    });

    child.unref();

    return Response.json({
      status: "processing",
      worktreeCount: worktrees.length,
      pid: child.pid,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Write error status
    writeFileSync(
      STATUS_PATH,
      JSON.stringify({
        status: "error",
        error: message,
        completedAt: new Date().toISOString(),
      })
    );
    return new Response(
      JSON.stringify({ error: `Failed to spawn batch process: ${message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
