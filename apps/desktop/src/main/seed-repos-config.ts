import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  loadReposConfig,
  saveReposConfig,
} from "../server/operations/repos-config-utils.js";
import { computeSymphonyDir } from "../server/operations/symphony-utils.js";
import { normalizeScopePath } from "../shared/sandbox-policy.js";
import { gatewayLog } from "./gateway-logger.js";

/**
 * Seeds repos.json within the symphony config directory for the given sandbox.
 *
 * - Sets worktreeParentDir + worktreeParentDirConfirmed
 *
 * Repos are added explicitly by the user via POST /api/gateway/repos — this
 * function never auto-discovers repos from the filesystem.
 *
 * Best-effort — logs errors but never throws. When provided, `isCancelled`
 * lets long-running callers avoid writing stale repo defaults after the user
 * has switched to another onboarding/settings path.
 */
export async function seedReposConfig(
  rawSandboxBaseDirectory: string,
  options: { isCancelled?: () => boolean } = {}
): Promise<void> {
  try {
    if (options.isCancelled?.()) {
      return;
    }
    const sandboxBaseDirectory = normalizeScopePath(rawSandboxBaseDirectory);
    if (!sandboxBaseDirectory) {
      return;
    }
    if (options.isCancelled?.()) {
      return;
    }

    const symphonyDir = computeSymphonyDir(sandboxBaseDirectory);
    const configDir = path.join(symphonyDir, "config");
    if (options.isCancelled?.()) {
      return;
    }
    mkdirSync(configDir, { recursive: true });

    // Ensure worktreeParentDir + worktreeParentDirConfirmed are both set.
    // The health check (health-check.ts:176) requires BOTH to be truthy.
    // Rules:
    //   - If worktreeParentDir is missing or outside the sandbox → overwrite
    //     to sandboxBaseDirectory + confirmed. A stale dir outside the sandbox
    //     would fail sandbox policy checks on worktree operations.
    //   - If worktreeParentDir is within the sandbox and confirmed → leave alone
    //     (user may have customised to a subdirectory).
    //   - If worktreeParentDir is within the sandbox but not confirmed →
    //     set confirmed only.
    // Single load → mutate in-memory → single save.
    const config = await loadReposConfig(configDir);
    if (options.isCancelled?.()) {
      return;
    }
    let dirty = false;

    const existingDir = config.settings.worktreeParentDir;
    const normalizedExisting = existingDir
      ? normalizeScopePath(existingDir)
      : null;
    const isWithinSandbox =
      normalizedExisting != null &&
      (normalizedExisting === sandboxBaseDirectory ||
        normalizedExisting.startsWith(sandboxBaseDirectory + path.sep));

    if (!(existingDir && isWithinSandbox)) {
      config.settings = {
        ...config.settings,
        worktreeParentDir: sandboxBaseDirectory,
        worktreeParentDirConfirmed: true,
      };
      dirty = true;
    } else if (!config.settings.worktreeParentDirConfirmed) {
      config.settings = {
        ...config.settings,
        worktreeParentDirConfirmed: true,
      };
      dirty = true;
    }

    if (dirty && !options.isCancelled?.()) {
      await saveReposConfig(config, configDir);
    }
  } catch (err) {
    // Best-effort — never block onboarding/settings/boot
    const message = err instanceof Error ? err.message : String(err);
    gatewayLog.error("seed-repos-config", `seedReposConfig failed: ${message}`);
  }
}
