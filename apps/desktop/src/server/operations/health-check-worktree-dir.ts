import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayCheckResult as CheckResult } from "./health-check-types.js";

/**
 * The System Check "Worktree Directory" row, and the READ-ONLY config reader it
 * needs.
 *
 * Split out of `health-check.ts` (ISS-5868) to bring that grandfathered file
 * back under its line budget; the row and its reader are the one cohesive unit
 * in it that nothing else touches.
 *
 * The reader here is deliberately NOT `repos-config-utils.loadReposConfig`:
 * that one CREATES `repos.json` when it is missing, and a read-only health
 * check must never write config as a side effect.
 */

type ReposConfig = {
  repos?: Array<{ path: string; description?: string }>;
  settings?: {
    worktreeParentDir?: string;
    worktreeParentDirConfirmed?: boolean;
  };
};

const NOT_CONFIGURED: CheckResult = {
  id: "worktree-dir",
  label: "Worktree Directory",
  required: true,
  passed: false,
  error: "Not configured",
  remediation: "Set the parent directory where git worktrees will be created",
};

async function loadReposConfig(configDir: string): Promise<ReposConfig> {
  try {
    const content = await fs.readFile(
      path.join(configDir, "repos.json"),
      "utf-8"
    );
    return JSON.parse(content) as ReposConfig;
  } catch {
    return {};
  }
}

export async function checkWorktreeDir(
  getConfigDir: () => string
): Promise<CheckResult> {
  let configDir: string;
  try {
    configDir = getConfigDir();
  } catch {
    return { ...NOT_CONFIGURED };
  }
  const config = await loadReposConfig(configDir);
  const configuredDir = config.settings?.worktreeParentDir;
  if (configuredDir && config.settings?.worktreeParentDirConfirmed) {
    return {
      id: "worktree-dir",
      label: "Worktree Directory",
      required: true,
      passed: true,
      version: configuredDir,
    };
  }

  return { ...NOT_CONFIGURED };
}
