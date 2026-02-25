import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import {
  expandHome,
  getSymphonyScriptPath,
  getWorktreeParentDir,
} from "@/lib/engineer/repos";

/**
 * GET /api/symphony/process-learnings?ticketId=...&repo=...
 *
 * Returns the current processing status from processing-status.json.
 */
export function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  const statusPath = join(
    worktreeDir,
    ".claude",
    "work",
    ".learnings",
    "processing-status.json"
  );

  if (!existsSync(statusPath)) {
    return Response.json({ status: "none" });
  }

  try {
    const content = readFileSync(statusPath, "utf-8");
    const status = JSON.parse(content);
    return Response.json(status);
  } catch {
    return Response.json({ status: "none" });
  }
}

/**
 * POST /api/engineer/symphony/process-learnings
 *
 * Processes pending learnings captured during a chat session.
 * Called when the chat dialog closes and learnings were captured.
 * Fire-and-forget — spawns a detached background process.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticketId, repoPath, waitForExtraction } = body as {
    ticketId: string;
    repoPath: string;
    waitForExtraction?: boolean;
  };

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repoPath are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  const claudeWorkDir = join(worktreeDir, ".claude", "work");
  const pendingDir = join(claudeWorkDir, ".learnings", "pending");

  if (!existsSync(worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // When extraction is still in flight, spawn a wrapper that polls until it completes
  if (waitForExtraction) {
    return spawnWaitingWrapper(claudeWorkDir, worktreeDir);
  }

  // Check if there are actually pending learnings to process
  if (!existsSync(pendingDir)) {
    return Response.json({
      status: "skipped",
      reason: "No pending learnings directory",
    });
  }

  let hasPendingFiles = false;
  try {
    const files = readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    hasPendingFiles = files.length > 0;
  } catch {
    // Directory read failed
  }

  if (!hasPendingFiles) {
    return Response.json({
      status: "skipped",
      reason: "No pending learning files",
    });
  }

  // Find the process-chat-learnings.sh script (same plugin directory as run-loop.sh)
  const runLoopPath = getSymphonyScriptPath();
  if (!runLoopPath) {
    return new Response(
      JSON.stringify({ error: "Symphony scripts not found in plugin cache" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const scriptPath = join(runLoopPath, "..", "process-chat-learnings.sh");
  if (!existsSync(scriptPath)) {
    return new Response(
      JSON.stringify({ error: "process-chat-learnings.sh not found" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Ensure log directory exists
  mkdirSync(claudeWorkDir, { recursive: true });
  const logFile = join(claudeWorkDir, "process-learnings.log");
  const logFd = openSync(logFile, "a");

  try {
    const child = spawn(scriptPath, [claudeWorkDir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: worktreeDir,
      env: {
        ...process.env,
        SYMPHONY_WORKDIR: claudeWorkDir,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      },
    });

    child.unref();

    return Response.json({
      status: "processing",
      pid: child.pid,
      logFile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: `Failed to spawn process: ${message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Spawn a detached bash wrapper that polls the extraction status file
 * until it completes (or errors/times out), then runs process-chat-learnings.sh.
 */
function spawnWaitingWrapper(
  claudeWorkDir: string,
  worktreeDir: string
): Response {
  const runLoopPath = getSymphonyScriptPath();
  if (!runLoopPath) {
    return new Response(
      JSON.stringify({ error: "Symphony scripts not found in plugin cache" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const scriptPath = join(runLoopPath, "..", "process-chat-learnings.sh");
  if (!existsSync(scriptPath)) {
    return new Response(
      JSON.stringify({ error: "process-chat-learnings.sh not found" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const learningsDir = join(claudeWorkDir, ".learnings");
  mkdirSync(learningsDir, { recursive: true });

  // Reset processing-status.json so page.tsx polling doesn't read stale "completed" from a previous run
  const processingStatusPath = join(learningsDir, "processing-status.json");
  writeFileSync(
    processingStatusPath,
    JSON.stringify({ status: "waiting", timestamp: new Date().toISOString() })
  );

  const logFile = join(claudeWorkDir, "process-learnings.log");
  const logFd = openSync(logFile, "a");

  const statusFile = join(learningsDir, "chat-extraction-status.json");
  const pendingDir = join(learningsDir, "pending");

  // Inline node script that reads the status file and prints the status field
  const readStatusExpr = [
    "try {",
    "  const d = require('fs').readFileSync(process.argv[1], 'utf-8');",
    "  const s = JSON.parse(d).status || 'unknown';",
    "  process.stdout.write(s);",
    "} catch { process.stdout.write('unknown'); }",
  ].join(" ");

  // Bash wrapper: poll status file every 5s, run script on completion, handle errors/timeout
  const wrapperScript = [
    "#!/usr/bin/env bash",
    `STATUS_FILE=${JSON.stringify(statusFile)}`,
    `PENDING_DIR=${JSON.stringify(pendingDir)}`,
    `SCRIPT=${JSON.stringify(scriptPath)}`,
    `WORKDIR=${JSON.stringify(claudeWorkDir)}`,
    "TIMEOUT=120",
    "ELAPSED=0",
    'echo "[wait-wrapper] Waiting for extraction to complete..."',
    "while [ $ELAPSED -lt $TIMEOUT ]; do",
    `  STATUS=$(node -e ${JSON.stringify(readStatusExpr)} "$STATUS_FILE" 2>/dev/null)`,
    '  if [ "$STATUS" = "completed" ]; then',
    '    echo "[wait-wrapper] Extraction completed. Running process-chat-learnings.sh..."',
    '    exec "$SCRIPT" "$WORKDIR"',
    "  fi",
    '  if [ "$STATUS" = "error" ]; then',
    '    echo "[wait-wrapper] Extraction errored. Exiting."',
    "    exit 1",
    "  fi",
    "  sleep 5",
    "  ELAPSED=$((ELAPSED + 5))",
    "done",
    "# Timeout: check if any pending files appeared anyway",
    'if [ -d "$PENDING_DIR" ] && [ "$(ls "$PENDING_DIR"/*.json 2>/dev/null | head -1)" != "" ]; then',
    '  echo "[wait-wrapper] Timeout but pending files found. Running process-chat-learnings.sh..."',
    '  exec "$SCRIPT" "$WORKDIR"',
    "fi",
    'echo "[wait-wrapper] Timeout with no pending files. Exiting."',
  ].join("\n");

  try {
    const child = spawn("bash", ["-c", wrapperScript], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: worktreeDir,
      env: {
        ...process.env,
        SYMPHONY_WORKDIR: claudeWorkDir,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      },
    });

    child.unref();

    return Response.json({
      status: "waiting",
      pid: child.pid,
      logFile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: `Failed to spawn waiting wrapper: ${message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
