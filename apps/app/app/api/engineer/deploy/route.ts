import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { detectDeployment } from "@/lib/engineer/deploy-detect";
import { checkLegacyProcessAndMigrate } from "@/lib/engineer/process-utils";
import {
  expandHome,
  isRepoAllowed,
  loadReposConfig,
  saveReposConfig,
} from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";
import { copyEnvLocalFiles } from "@/lib/engineer/worktree";

/**
 * API route to start a deployment (local dev server)
 *
 * POST /api/engineer/deploy
 * Body: { ticketId, repoPath, worktreePath }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticketId, repoPath, worktreePath } = body as {
      ticketId: string;
      repoPath: string;
      worktreePath: string;
    };

    if (!(ticketId && repoPath && worktreePath)) {
      return NextResponse.json(
        { error: "ticketId, repoPath, and worktreePath are required" },
        { status: 400 }
      );
    }

    if (!isRepoAllowed(repoPath)) {
      return NextResponse.json(
        { error: `Repository not allowed: ${repoPath}` },
        { status: 403 }
      );
    }

    const expandedRepoPath = expandHome(repoPath);
    const expandedWorktreePath = expandHome(worktreePath);

    if (!existsSync(expandedWorktreePath)) {
      return NextResponse.json(
        { error: `Worktree not found: ${expandedWorktreePath}` },
        { status: 404 }
      );
    }

    // Load repo config and find deployment config
    const repoName = basename(expandedRepoPath);
    const deployConfig = resolveDeployConfig(expandedRepoPath);

    if (!deployConfig) {
      return NextResponse.json(
        { error: "No deployment configuration detected for this repository" },
        { status: 400 }
      );
    }

    // Migrate .claude/work → .closedloop-ai/work if needed
    const preflightResult = checkLegacyProcessAndMigrate(expandedWorktreePath);
    if (preflightResult === "live-process-blocking") {
      return NextResponse.json(
        {
          error:
            "A job started before the .closedloop-ai migration is still running. Stop it first, then retry.",
        },
        { status: 409 }
      );
    }

    // Create log directory and file
    const claudeWorkDir = join(expandedWorktreePath, ".closedloop-ai", "work");
    mkdirSync(claudeWorkDir, { recursive: true });

    const logFile = join(claudeWorkDir, "deploy.log");
    const logFd = openSync(logFile, "w");

    // Clean up any previous exit/result status
    const exitJsonPath = join(claudeWorkDir, "deploy-exit.json");
    const resultJsonPath = join(claudeWorkDir, "deploy-result.json");
    clearIfExists(exitJsonPath);
    clearIfExists(resultJsonPath);

    // Copy .env.local files from base repo to worktree (git worktrees don't include ignored files)
    copyEnvLocalFiles(expandedRepoPath, expandedWorktreePath);

    // Pass minimal env vars - let the framework read .env files itself
    const spawnEnv: NodeJS.ProcessEnv = {
      PATH: await getShellPath(),
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL ?? "/bin/zsh",
      TERM: process.env.TERM ?? "xterm-256color",
      NODE_ENV: "development",
    };

    // Install dependencies before starting the dev server
    if (deployConfig.installCommand) {
      execSync(deployConfig.installCommand, {
        cwd: expandedWorktreePath,
        shell: "/bin/bash",
        timeout: 120_000,
        stdio: ["ignore", logFd, logFd],
        env: spawnEnv,
      });
    }

    // Spawn the dev command
    const child = spawn(deployConfig.command, {
      detached: true,
      cwd: expandedWorktreePath,
      shell: true,
      stdio: ["ignore", logFd, logFd],
      env: spawnEnv,
    });

    child.unref();

    // Monitor exit code and write deploy-exit.json
    child.on("exit", (code) => {
      if (code === 0) {
        return;
      }
      bestEffortWrite(exitJsonPath, {
        exitCode: code,
        failedCommand: "deploy",
      });
    });

    // Background health-poll loop for local dev servers with a known port
    if (deployConfig.port && deployConfig.healthCheckUrl) {
      startHealthPoll(
        deployConfig.healthCheckUrl,
        resultJsonPath,
        exitJsonPath
      );
    }

    return NextResponse.json({
      success: true,
      pid: child.pid,
      logFile,
      deployCommand: deployConfig.command,
      deployType: deployConfig.type,
      repoName,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to start deployment: ${errorMessage}` },
      { status: 500 }
    );
  }
}

function resolveDeployConfig(repoPath: string) {
  const config = loadReposConfig();
  const repoEntry = config.repos.find((r) => expandHome(r.path) === repoPath);
  let deployConfig = repoEntry?.deployment;

  if (deployConfig?.installCommand) {
    return deployConfig;
  }

  const detected = detectDeployment(repoPath);
  if (!detected) {
    return deployConfig;
  }

  deployConfig = deployConfig
    ? { ...deployConfig, installCommand: detected.installCommand }
    : detected;
  if (repoEntry) {
    repoEntry.deployment = deployConfig;
    saveReposConfig(config);
  }
  return deployConfig;
}

function clearIfExists(filePath: string): void {
  if (existsSync(filePath)) {
    writeFileSync(filePath, "");
  }
}

function bestEffortWrite(
  filePath: string,
  data: Record<string, unknown>
): void {
  try {
    writeFileSync(filePath, JSON.stringify(data));
  } catch {
    // Best effort
  }
}

/**
 * Poll healthCheckUrl every 2s for up to 60s.
 * On success, write deploy-result.json so the status endpoint sees "completed".
 * On timeout, write deploy-exit.json with a timeout error.
 */
function startHealthPoll(
  healthCheckUrl: string,
  resultJsonPath: string,
  exitJsonPath: string
): void {
  const maxAttempts = 30;
  let attempt = 0;

  const interval = setInterval(async () => {
    attempt++;

    try {
      const response = await fetch(healthCheckUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        clearInterval(interval);
        bestEffortWrite(resultJsonPath, { url: healthCheckUrl });
        return;
      }
    } catch {
      // Server not ready yet
    }

    if (attempt >= maxAttempts) {
      clearInterval(interval);
      bestEffortWrite(exitJsonPath, {
        exitCode: -1,
        failedCommand: "health-check-timeout",
      });
    }
  }, 2000);
}
