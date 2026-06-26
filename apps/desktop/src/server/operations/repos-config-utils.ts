import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./symphony-utils.js";

export type RepoDeploymentConfig = {
  framework?: string;
  packageManager?: string;
  port?: number;
  healthEndpoint?: string;
  startCommand?: string;
  command?: string;
  installCommand?: string;
  teardownCommand?: string;
  healthCheckUrl?: string;
  additionalPorts?: number[];
  type?: string;
};

export type ConfiguredRepo = {
  path: string;
  description?: string;
  deployment?: RepoDeploymentConfig;
  addedAt: string;
};

export type RepoSettings = {
  worktreeParentDir?: string;
  worktreeParentDirConfirmed?: boolean;
};

export type ReposConfig = {
  repos: ConfiguredRepo[];
  settings: RepoSettings;
};

export async function loadReposConfig(configDir: string): Promise<ReposConfig> {
  const configPath = path.join(configDir, "repos.json");
  await fs.mkdir(configDir, { recursive: true });

  if (!existsSync(configPath)) {
    const emptyConfig: ReposConfig = { repos: [], settings: {} };
    await saveReposConfig(emptyConfig, configDir);
    return emptyConfig;
  }

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as Partial<ReposConfig>;
    return {
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      settings: parsed.settings ?? {},
    };
  } catch {
    const emptyConfig: ReposConfig = { repos: [], settings: {} };
    await saveReposConfig(emptyConfig, configDir);
    return emptyConfig;
  }
}

export async function saveReposConfig(
  config: ReposConfig,
  configDir: string
): Promise<void> {
  const configPath = path.join(configDir, "repos.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function addRepo(
  pathInput: string,
  description: string | undefined,
  configDir: string
): Promise<{
  success: boolean;
  error?: string;
  repo?: ConfiguredRepo;
}> {
  const normalizedPath = normalizePath(pathInput);
  const expandedPath = expandHome(normalizedPath);

  if (!existsSync(expandedPath)) {
    return { success: false, error: "Path does not exist" };
  }

  const directoryStats = await fs.stat(expandedPath).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return { success: false, error: "Path must be a directory" };
  }

  const config = await loadReposConfig(configDir);
  const alreadyExists = config.repos.some(
    (repo) => normalizePath(repo.path) === normalizedPath
  );
  if (alreadyExists) {
    return { success: false, error: "Repository already configured" };
  }

  const deployment = await detectSimpleDeployment(expandedPath);
  const repo: ConfiguredRepo = {
    path: normalizedPath,
    ...(description ? { description } : {}),
    ...(deployment ? { deployment } : {}),
    addedAt: new Date().toISOString(),
  };
  config.repos.push(repo);
  await saveReposConfig(config, configDir);
  return { success: true, repo };
}

export async function removeRepo(
  pathInput: string,
  configDir: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedPath = normalizePath(pathInput);
  const config = await loadReposConfig(configDir);
  const initialLength = config.repos.length;
  config.repos = config.repos.filter(
    (repo) => normalizePath(repo.path) !== normalizedPath
  );

  if (config.repos.length === initialLength) {
    return { success: false, error: "Repository not found" };
  }

  await saveReposConfig(config, configDir);
  return { success: true };
}

export async function updateSettings(
  updates: Record<string, string | boolean>,
  configDir: string
): Promise<{ success: boolean; error?: string }> {
  const config = await loadReposConfig(configDir);
  config.settings = { ...config.settings, ...updates };
  await saveReposConfig(config, configDir);
  return { success: true };
}

export function normalizePath(pathInput: string): string {
  const expanded = expandHome(pathInput);
  const normalized = path.resolve(expanded);
  const home = os.homedir();
  if (normalized.startsWith(home)) {
    return `~${normalized.slice(home.length)}`;
  }
  return normalized;
}

async function detectSimpleDeployment(
  repoPath: string
): Promise<RepoDeploymentConfig | undefined> {
  const packageJsonPath = path.join(repoPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(
      await fs.readFile(packageJsonPath, "utf-8")
    ) as {
      scripts?: Record<string, string>;
      packageManager?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    };

    const framework = detectFramework(allDependencies);
    const startCommand = packageJson.scripts?.dev
      ? "pnpm dev"
      : packageJson.scripts?.start
        ? "pnpm start"
        : undefined;

    return {
      ...(framework ? { framework } : {}),
      ...(packageJson.packageManager
        ? { packageManager: packageJson.packageManager }
        : {}),
      ...(startCommand ? { startCommand } : {}),
    };
  } catch {
    return undefined;
  }
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
  if ("react" in dependencies) {
    return "react";
  }
  if ("express" in dependencies) {
    return "express";
  }
  return undefined;
}
