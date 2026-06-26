import { execSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Observability } from "../../main/observability.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { validateOutboundUrlForSurface } from "../outbound-url-policy.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { getShellEnv, getShellPath } from "../shell-path.js";
import { parseBody } from "./parse-body.js";
import {
  loadReposConfig,
  type RepoDeploymentConfig,
  type ReposConfig,
  saveReposConfig,
} from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { expandHome } from "./symphony-utils.js";

type DeployStatus = "running" | "completed" | "failed" | "not-started";

const SAFE_COMMAND_TIMEOUT_MS = 120_000;
export const DEPLOY_HEALTH_POLICY_DENIAL_CODE = "OUTBOUND_URL_DENIED";
export const DEPLOY_HEALTH_POLICY_FAILED_COMMAND = "health-check-policy";
const DEPLOY_HEALTH_POLICY_DENIAL_ERROR =
  "url blocked by desktop outbound policy";

function isDeployHealthAlive(response: Response): boolean {
  return response.ok || (response.status >= 300 && response.status < 400);
}

export function registerDeployRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string
): void {
  const configDir = () => path.join(getSymphonyDir(), "config");
  dispatcher.register("POST", "/api/gateway/deploy", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const ticketId = asString(body.ticketId);
    const repoPath = asString(body.repoPath);
    const worktreePath = asString(body.worktreePath);

    if (!(ticketId && repoPath && worktreePath)) {
      json(context, 400, {
        error: "ticketId, repoPath, and worktreePath are required",
      });
      return;
    }

    let expandedRepoPath: string;
    let expandedWorktreePath: string;
    try {
      expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
      expandedWorktreePath = enforceAllowed(
        worktreePath,
        getAllowedDirectories()
      );
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    if (!existsSync(expandedWorktreePath)) {
      json(context, 404, {
        error: `Worktree not found: ${expandedWorktreePath}`,
      });
      return;
    }

    const reposConfig = await loadReposConfig(configDir());
    const deployConfig = resolveDeployConfig(
      reposConfig,
      expandedRepoPath,
      expandedWorktreePath
    );
    if (!deployConfig?.command) {
      json(context, 400, {
        error: "No deployment configuration detected for this repository",
      });
      return;
    }

    const repoEntry = reposConfig.repos.find(
      (repo) => expandHome(repo.path) === expandedRepoPath
    );
    if (repoEntry) {
      repoEntry.deployment = {
        ...repoEntry.deployment,
        ...deployConfig,
      };
      await saveReposConfig(reposConfig, configDir());
    }

    const claudeWorkDir = path.join(
      expandedWorktreePath,
      ".closedloop-ai",
      "work"
    );
    await fs.mkdir(claudeWorkDir, { recursive: true });

    const logFile = path.join(claudeWorkDir, "deploy.log");
    const exitJsonPath = path.join(claudeWorkDir, "deploy-exit.json");
    const resultJsonPath = path.join(claudeWorkDir, "deploy-result.json");
    await fs.rm(exitJsonPath, { force: true });
    await fs.rm(resultJsonPath, { force: true });

    copyEnvLocalFiles(expandedRepoPath, expandedWorktreePath).catch(
      () => undefined
    );

    const spawnEnv: NodeJS.ProcessEnv = {
      PATH: await getShellPath(),
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL ?? "/bin/bash",
      TERM: process.env.TERM ?? "xterm-256color",
      NODE_ENV: "development",
    };

    const logFd = openSync(logFile, "a");

    try {
      if (deployConfig.installCommand) {
        execSync(deployConfig.installCommand, {
          cwd: expandedWorktreePath,
          stdio: ["ignore", logFd, logFd],
          timeout: SAFE_COMMAND_TIMEOUT_MS,
          shell: "/bin/bash",
          env: spawnEnv,
        });
      }

      const child = spawn(deployConfig.command, {
        detached: true,
        cwd: expandedWorktreePath,
        shell: true,
        stdio: ["ignore", logFd, logFd],
        env: spawnEnv,
      });

      if (!child.pid) {
        throw new Error("failed to start deploy process");
      }

      await fs.writeFile(
        path.join(claudeWorkDir, "process.pid"),
        String(child.pid)
      );

      child.on("exit", (code) => {
        if (code === 0) {
          return;
        }
        void fs.writeFile(
          exitJsonPath,
          JSON.stringify({ exitCode: code, failedCommand: "deploy" }),
          "utf-8"
        );
      });

      child.unref();

      if (deployConfig.port && deployConfig.healthCheckUrl) {
        startHealthPoll(
          deployConfig.healthCheckUrl,
          resultJsonPath,
          exitJsonPath
        );
      }

      json(context, 200, {
        success: true,
        pid: child.pid,
        logFile,
        deployCommand: deployConfig.command,
        deployType: deployConfig.type,
        repoName: path.basename(expandedRepoPath),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to start deployment: ${message}` });
    } finally {
      try {
        closeSync(logFd);
      } catch {
        // no-op
      }
    }
  });

  dispatcher.register("POST", "/api/gateway/deploy/health", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const url = asString(body.url);
    if (!url) {
      json(context, 400, { error: "url is required" });
      return;
    }

    try {
      const policyDecision = validateOutboundUrlForSurface(
        "deploy_health_check",
        url
      );
      if (!policyDecision.allowed) {
        Observability.outboundNetworkDecision(policyDecision.diagnostics);
        json(context, 200, {
          alive: false,
          statusCode: null,
          error: DEPLOY_HEALTH_POLICY_DENIAL_ERROR,
          code: DEPLOY_HEALTH_POLICY_DENIAL_CODE,
        });
        return;
      }

      Observability.outboundNetworkDecision(policyDecision.diagnostics);
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      json(context, 200, {
        alive: isDeployHealthAlive(response),
        statusCode: response.status,
      });
    } catch {
      json(context, 200, {
        alive: false,
        statusCode: null,
      });
    }
  });

  dispatcher.register("POST", "/api/gateway/deploy/kill", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const pid = asNumber(body.pid);
    if (!pid) {
      json(context, 400, { error: "pid is required and must be a number" });
      return;
    }

    try {
      process.kill(pid, 0);
    } catch {
      json(context, 200, {
        success: true,
        message: "Process already terminated",
        pid,
      });
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
      await wait(500);
      try {
        process.kill(pid, 0);
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process is already gone.
      }

      json(context, 200, {
        success: true,
        message: "Process terminated",
        pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("ESRCH")) {
        json(context, 200, {
          success: true,
          message: "Process already terminated",
          pid,
        });
        return;
      }

      json(context, 500, {
        error: `Failed to kill process: ${message}`,
      });
    }
  });

  dispatcher.register(
    "POST",
    "/api/gateway/deploy/teardown",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const worktreePath = asString(body.worktreePath);
      const pid = asNumber(body.pid);
      const port = asNumber(body.port);

      if (!(repoPath && worktreePath)) {
        json(context, 400, { error: "repoPath and worktreePath are required" });
        return;
      }

      let expandedRepoPath: string;
      let expandedWorktreePath: string;
      try {
        expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
        expandedWorktreePath = enforceAllowed(
          worktreePath,
          getAllowedDirectories()
        );
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const config = await loadReposConfig(configDir());
      const repoEntry = config.repos.find(
        (repo) => expandHome(repo.path) === expandedRepoPath
      );
      const deployConfig = repoEntry?.deployment;

      const primaryPort = deployConfig?.port ?? port ?? null;

      if (pid && killByPid(pid) === "killed") {
        json(context, 200, { success: true });
        return;
      }

      if (
        primaryPort &&
        killByPorts(primaryPort, deployConfig?.additionalPorts)
      ) {
        json(context, 200, { success: true });
        return;
      }

      if (
        deployConfig?.teardownCommand &&
        (await runTeardownCommand(
          deployConfig.teardownCommand,
          expandedWorktreePath
        ))
      ) {
        json(context, 200, { success: true });
        return;
      }

      if (!(primaryPort || pid || deployConfig?.teardownCommand)) {
        json(context, 400, {
          error:
            "No port, PID, or teardown command available to stop the server",
        });
        return;
      }

      json(context, 200, {
        success: false,
        error: "Could not stop the server - process may have already exited",
      });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/deploy/status/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const pidRaw = context.query.get("pid");

      if (!repoPath) {
        json(context, 400, { error: "repo query param is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
      const repoName = path.basename(expandedRepoPath);
      const worktreeParentDir = resolveWorktreeParent(expandedRepoPath);
      const worktreeDir = path.join(
        worktreeParentDir,
        `${repoName}-${sanitizedTicket}`
      );

      try {
        assertPathAllowed(worktreeDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const deployWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      const logsPath = path.join(deployWorkDir, "deploy.log");
      const exitInfoPath = path.join(deployWorkDir, "deploy-exit.json");
      const deployResultPath = path.join(deployWorkDir, "deploy-result.json");
      const logs = (await readTextFile(logsPath)) || null;
      const exitInfo = await readJsonFile<{
        exitCode: number;
        failedCommand: string;
      }>(exitInfoPath);
      const deployResult = await readJsonFile<{
        url?: string;
        serviceId?: string;
      }>(deployResultPath);

      const processAlive = isProcessAlive(pidRaw);
      const status = determineStatus(
        exitInfo,
        deployResult?.url,
        processAlive,
        logs ?? "",
        pidRaw
      );

      json(context, 200, {
        status,
        logs,
        pid: pidRaw ? Number.parseInt(pidRaw, 10) : null,
        deployedUrl: deployResult?.url,
        serviceId: deployResult?.serviceId,
        error: exitInfo
          ? `Deploy command failed with exit code ${exitInfo.exitCode}`
          : undefined,
      });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/deploy/check-existing",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const worktreePath = asString(body.worktreePath);
      if (!(repoPath && worktreePath)) {
        json(context, 400, { error: "repoPath and worktreePath are required" });
        return;
      }

      let expandedRepoPath: string;
      let expandedWorktreePath: string;
      try {
        expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
        expandedWorktreePath = enforceAllowed(
          worktreePath,
          getAllowedDirectories()
        );
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const config = await loadReposConfig(configDir());
      const repoEntry = config.repos.find(
        (repo) => expandHome(repo.path) === expandedRepoPath
      );

      const deployConfig =
        repoEntry?.deployment ?? detectDeployment(expandedWorktreePath);
      if (!deployConfig?.port) {
        json(context, 200, { active: false });
        return;
      }

      const listening = await checkPortListening(deployConfig.port);
      if (listening) {
        json(context, 200, {
          active: true,
          url: `http://localhost:${deployConfig.port}`,
        });
        return;
      }

      json(context, 200, { active: false });
    }
  );

  dispatcher.register("POST", "/api/gateway/deploy/detect", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const repoPath = asString(body.repoPath);
    if (!repoPath) {
      json(context, 400, { error: "repoPath is required" });
      return;
    }

    let expandedRepoPath: string;
    try {
      expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
    } catch (error) {
      if (error instanceof DirectoryNotAllowedError) {
        json(context, 403, { error: "directory not allowed" });
        return;
      }
      throw error;
    }

    const detected = detectDeployment(expandedRepoPath);
    if (!detected) {
      json(context, 200, { detected: false });
      return;
    }

    await persistDeploymentConfig(
      repoPath,
      expandedRepoPath,
      detected,
      configDir()
    );
    json(context, 200, { detected: true, config: detected });
  });

  dispatcher.register(
    "POST",
    "/api/gateway/deploy/redetect",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      if (!repoPath) {
        json(context, 400, { error: "repoPath is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const newConfig = detectDeployment(expandedRepoPath);
      const config = await loadReposConfig(configDir());
      const repoEntry = config.repos.find(
        (repo) => expandHome(repo.path) === expandedRepoPath
      );

      if (newConfig && repoEntry) {
        repoEntry.deployment = newConfig;
        await saveReposConfig(config, configDir());
        json(context, 200, { redetected: true, config: newConfig });
        return;
      }

      if (repoEntry?.deployment) {
        repoEntry.deployment = undefined;
        await saveReposConfig(config, configDir());
      }

      json(context, 200, { redetected: false });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/deploy/extract-info",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      if (!repoPath) {
        json(context, 400, { error: "repoPath is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = enforceAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const config = await loadReposConfig(configDir());
      const repoEntry = config.repos.find(
        (repo) => expandHome(repo.path) === expandedRepoPath
      );

      if (repoEntry?.deployment?.port) {
        json(context, 200, {
          url: `http://localhost:${repoEntry.deployment.port}`,
        });
        return;
      }

      json(context, 200, { url: null });
    }
  );
}

function resolveWorktreeParent(expandedRepoPath: string): string {
  const configured = process.env.SYMPHONY_WORKTREE_PARENT_DIR;
  if (configured?.trim()) {
    return expandHome(configured);
  }
  return path.dirname(expandedRepoPath);
}

function enforceAllowed(
  repoPath: string,
  allowedDirectories: string[]
): string {
  const expanded = expandHome(repoPath);
  assertPathAllowed(expanded, allowedDirectories);
  return expanded;
}

function resolveDeployConfig(
  config: ReposConfig,
  expandedRepoPath: string,
  expandedWorktreePath: string
): RepoDeploymentConfig | null {
  const repoEntry = config.repos.find(
    (repo) => expandHome(repo.path) === expandedRepoPath
  );
  const configured = repoEntry?.deployment;

  if (configured?.command) {
    return normalizeDeployConfig(configured);
  }

  const detected =
    detectDeployment(expandedWorktreePath) ??
    detectDeployment(expandedRepoPath);
  return detected ? normalizeDeployConfig(detected) : null;
}

function normalizeDeployConfig(
  config: RepoDeploymentConfig
): RepoDeploymentConfig {
  const normalized: RepoDeploymentConfig = {
    ...config,
  };

  if (!normalized.command && normalized.startCommand) {
    normalized.command = normalized.startCommand;
  }

  if (!normalized.healthCheckUrl && normalized.port) {
    // The default remains loopback; use-time policy enforcement is the guard if future config changes widen this.
    normalized.healthCheckUrl = `http://localhost:${normalized.port}`;
  }

  return normalized;
}

function detectDeployment(repoPath: string): RepoDeploymentConfig | null {
  const packageJsonPath = path.join(repoPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(
      execSync(`cat ${shellEscape(packageJsonPath)}`, { encoding: "utf-8" })
    ) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    };

    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };

    const framework = detectFramework(deps);
    const script = resolveStartCommand(packageJson.scripts ?? {}, repoPath);
    if (!script) {
      return null;
    }

    const port = detectDefaultPort(framework, packageJson.scripts ?? {});

    return {
      framework,
      packageManager: packageJson.packageManager,
      command: script,
      startCommand: script,
      installCommand: resolveInstallCommand(packageJson.packageManager),
      type: framework ?? "node",
      port,
      healthEndpoint: "/",
      healthCheckUrl: port ? `http://localhost:${port}` : undefined,
    };
  } catch {
    return null;
  }
}

function resolveInstallCommand(packageManager?: string): string {
  if (!packageManager) {
    return "pnpm install";
  }

  if (packageManager.startsWith("pnpm")) {
    return "pnpm install";
  }
  if (packageManager.startsWith("yarn")) {
    return "yarn install";
  }
  if (packageManager.startsWith("npm")) {
    return "npm install";
  }
  return "pnpm install";
}

function detectFramework(
  dependencies: Record<string, string>
): string | undefined {
  if ("next" in dependencies) {
    return "next";
  }
  if ("vite" in dependencies) {
    return "vite";
  }
  if ("react-scripts" in dependencies) {
    return "cra";
  }
  if ("express" in dependencies) {
    return "express";
  }
  return undefined;
}

function resolveStartCommand(
  scripts: Record<string, string>,
  repoPath: string
): string | null {
  if (scripts.dev) {
    if (existsSync(path.join(repoPath, "pnpm-lock.yaml"))) {
      return "pnpm dev";
    }
    if (existsSync(path.join(repoPath, "yarn.lock"))) {
      return "yarn dev";
    }
    return "npm run dev";
  }
  if (scripts.start) {
    if (existsSync(path.join(repoPath, "pnpm-lock.yaml"))) {
      return "pnpm start";
    }
    if (existsSync(path.join(repoPath, "yarn.lock"))) {
      return "yarn start";
    }
    return "npm run start";
  }
  return null;
}

function detectDefaultPort(
  framework: string | undefined,
  scripts: Record<string, string>
): number | undefined {
  const scriptText = [scripts.dev, scripts.start].filter(Boolean).join(" ");
  const explicitPortMatch = scriptText.match(
    /(?:--port|-p|PORT=)\s*(\d{2,5})/i
  );
  if (explicitPortMatch) {
    const parsed = Number.parseInt(explicitPortMatch[1], 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (framework === "vite") {
    return 5173;
  }
  return 3000;
}

function shellEscape(target: string): string {
  return `'${target.replaceAll("'", "'\\''")}'`;
}

async function persistDeploymentConfig(
  repoPath: string,
  expandedRepoPath: string,
  detected: RepoDeploymentConfig,
  reposConfigDir: string
): Promise<void> {
  const config = await loadReposConfig(reposConfigDir);
  const repoEntry = config.repos.find(
    (repo) =>
      expandHome(repo.path) === expandedRepoPath || repo.path === repoPath
  );

  if (repoEntry) {
    repoEntry.deployment = detected;
    await saveReposConfig(config, reposConfigDir);
  }
}

function determineStatus(
  exitInfo: { exitCode: number } | null,
  deployedUrl: string | undefined,
  processAlive: boolean,
  logs: string,
  pidStr: string | null
): DeployStatus {
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

function isProcessAlive(pidRaw: string | null): boolean {
  if (!pidRaw) {
    return false;
  }

  const pid = Number.parseInt(pidRaw, 10);
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

async function readTextFile(targetPath: string): Promise<string> {
  if (!existsSync(targetPath)) {
    return "";
  }

  try {
    return await fs.readFile(targetPath, "utf-8");
  } catch {
    return "";
  }
}

async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  if (!existsSync(targetPath)) {
    return null;
  }

  try {
    const content = (await fs.readFile(targetPath, "utf-8")).trim();
    if (!content) {
      return null;
    }
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function killByPid(pid: number): "killed" | "error" {
  try {
    process.kill(-pid, "SIGTERM");
    return "killed";
  } catch {
    // Try direct PID fallback.
  }

  try {
    process.kill(pid, "SIGTERM");
    return "killed";
  } catch {
    return "error";
  }
}

function killByPorts(primaryPort: number, additionalPorts?: number[]): boolean {
  const ports = new Set([primaryPort, ...(additionalPorts ?? [])]);
  let didKill = false;

  for (const port of ports) {
    const status = killByPort(port);
    if (status === "killed" || status === "none") {
      didKill = true;
    }
  }

  return didKill;
}

function killByPort(port: number): "killed" | "none" | "error" {
  try {
    const output = execSync(`lsof -ti:${port}`, {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const pids = output
      .trim()
      .split("\n")
      .map((raw) => Number.parseInt(raw.trim(), 10))
      .filter((pid) => !Number.isNaN(pid));

    if (pids.length === 0) {
      return "none";
    }

    let killed = false;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch {
        // Process already gone.
      }
    }

    return killed ? "killed" : "none";
  } catch {
    return "none";
  }
}

async function runTeardownCommand(
  command: string,
  worktreePath: string
): Promise<boolean> {
  try {
    execSync(command, {
      cwd: worktreePath,
      shell: "/bin/bash",
      timeout: 60_000,
      stdio: "pipe",
      env: await getShellEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** @internal Exported for policy-focused tests. */
export function startHealthPoll(
  healthCheckUrl: string,
  resultJsonPath: string,
  exitJsonPath: string
): void {
  const policyDecision = validateOutboundUrlForSurface(
    "deploy_health_check",
    healthCheckUrl
  );
  if (!policyDecision.allowed) {
    Observability.outboundNetworkDecision(policyDecision.diagnostics);
    void fs
      .writeFile(
        exitJsonPath,
        JSON.stringify({
          exitCode: -1,
          failedCommand: DEPLOY_HEALTH_POLICY_FAILED_COMMAND,
        }),
        "utf-8"
      )
      .catch(() => undefined);
    return;
  }

  Observability.outboundNetworkDecision(policyDecision.diagnostics);
  const maxAttempts = 30;
  let attempt = 0;

  const interval = setInterval(async () => {
    attempt += 1;

    try {
      const response = await fetch(healthCheckUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });

      if (isDeployHealthAlive(response)) {
        clearInterval(interval);
        await fs.writeFile(
          resultJsonPath,
          JSON.stringify({ url: healthCheckUrl }),
          "utf-8"
        );
        return;
      }
    } catch {
      // keep polling
    }

    if (attempt >= maxAttempts) {
      clearInterval(interval);
      await fs
        .writeFile(
          exitJsonPath,
          JSON.stringify({
            exitCode: -1,
            failedCommand: "health-check-timeout",
          }),
          "utf-8"
        )
        .catch(() => undefined);
    }
  }, 2000);
}

async function checkPortListening(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });

    const settle = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function copyEnvLocalFiles(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const candidateFiles = [
    ".env.local",
    ".env.development.local",
    ".env.test.local",
    ".env.production.local",
  ];

  for (const filename of candidateFiles) {
    const source = path.join(repoPath, filename);
    const target = path.join(worktreePath, filename);

    if (!existsSync(source)) {
      continue;
    }

    if (existsSync(target)) {
      continue;
    }

    await fs.copyFile(source, target).catch(() => undefined);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}
