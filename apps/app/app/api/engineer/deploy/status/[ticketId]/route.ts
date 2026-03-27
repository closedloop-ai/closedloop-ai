import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8").trim();
    if (!content) {
      return null;
    }
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function isProcessAlive(pidStr: string | null): boolean {
  if (!pidStr) {
    return false;
  }
  const pid = Number.parseInt(pidStr, 10);
  if (Number.isNaN(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function determineStatus(
  exitInfo: { exitCode: number } | null,
  deployedUrl: string | undefined,
  processAlive: boolean,
  logs: string,
  pidStr: string | null
): "running" | "completed" | "failed" | "not-started" {
  if (exitInfo) {
    return "failed";
  }
  if (deployedUrl) {
    return "completed";
  }
  if (processAlive) {
    return "running";
  }
  if (logs && pidStr) {
    return "completed";
  }
  return "not-started";
}

/**
 * API route to poll deployment status
 *
 * GET /api/deploy/status/[ticketId]?repo=...&pid=...
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const { ticketId } = await params;
    const { searchParams } = new URL(request.url);
    const repoPath = searchParams.get("repo");
    const pidStr = searchParams.get("pid");

    if (!repoPath) {
      return NextResponse.json(
        { error: "repo query param is required" },
        { status: 400 }
      );
    }

    // Build worktree path
    const expandedRepoPath = expandHome(repoPath);
    const repoName = basename(expandedRepoPath);
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
    const worktreeDir = join(
      getWorktreeParentDir(),
      `${repoName}-${sanitizedTicket}`
    );
    const workDir = join(worktreeDir, ".closedloop-ai", "work");
    const deployLogPath = join(workDir, "deploy.log");
    const deployExitPath = join(workDir, "deploy-exit.json");
    const deployResultPath = join(workDir, "deploy-result.json");

    const logs = readTextFile(deployLogPath);
    const processAlive = isProcessAlive(pidStr);
    const exitInfo = readJsonFile<{ exitCode: number; failedCommand: string }>(
      deployExitPath
    );
    const deployResult = readJsonFile<{ url?: string; serviceId?: string }>(
      deployResultPath
    );

    const status = determineStatus(
      exitInfo,
      deployResult?.url,
      processAlive,
      logs,
      pidStr
    );

    return NextResponse.json({
      status,
      logs,
      pid: pidStr ? Number.parseInt(pidStr, 10) : null,
      deployedUrl: deployResult?.url,
      serviceId: deployResult?.serviceId,
      error: exitInfo
        ? `Deploy command failed with exit code ${exitInfo.exitCode}`
        : undefined,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to get deploy status: ${errorMessage}` },
      { status: 500 }
    );
  }
}
