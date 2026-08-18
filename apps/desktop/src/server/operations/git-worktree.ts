import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { GIT_GATEWAY_EXEC_TIMEOUT_MS } from "./git-gateway-constants.js";
import { parseBody } from "./parse-body.js";
import { loadReposConfig } from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { getResolvedGitPath } from "./symphony-loop.js";
import { expandHome, SymphonyDirNotConfiguredError } from "./symphony-utils.js";

export function registerGitWorktreeRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string
): void {
  const configDir = () => path.join(getSymphonyDir(), "config");

  dispatcher.register(
    "DELETE",
    "/api/gateway/git/worktree",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const worktreePath =
        typeof body.worktreePath === "string" ? body.worktreePath : null;
      const force = body.force === true;

      if (!worktreePath) {
        json(context, 400, {
          error: "worktreePath is required and must be a string",
        });
        return;
      }

      const expandedPath = expandHome(worktreePath);
      try {
        assertPathAllowed(expandedPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      if (!existsSync(expandedPath)) {
        json(context, 200, {
          success: true,
          message: "Worktree does not exist",
        });
        return;
      }

      const removeResult = await processManager.exec(
        getResolvedGitPath(),
        ["worktree", "remove", ...(force ? ["--force"] : []), expandedPath],
        expandedPath,
        { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS }
      );
      if (removeResult.exitCode === 0) {
        json(context, 200, {
          success: true,
          message: "Worktree removed successfully",
        });
        return;
      }

      const errorText = removeResult.stderr || removeResult.stdout;
      if (
        errorText.includes("contains modified or untracked files") &&
        !force
      ) {
        json(context, 409, {
          error: "Worktree has uncommitted changes",
          hasChanges: true,
          message: "Use force=true to remove anyway",
        });
        return;
      }

      if (force) {
        // The forced `git worktree remove` failed. Before falling back to a
        // recursive `fs.rm`, confirm the target is actually a registered
        // worktree of this repo — otherwise a plain directory (or an ordinary
        // repo) that merely lives under the sandbox would be recursively
        // deleted by the fallback.
        const isWorktree = await isRegisteredWorktree(
          processManager,
          expandedPath
        );
        if (!isWorktree) {
          json(context, 500, {
            error: `Failed to remove worktree: ${errorText}`,
          });
          return;
        }
        await fs.rm(expandedPath, { recursive: true, force: true });
        json(context, 200, {
          success: true,
          message: "Worktree forcefully removed",
        });
        return;
      }

      json(context, 500, { error: `Failed to remove worktree: ${errorText}` });
    }
  );

  dispatcher.register("POST", "/api/gateway/git/worktree", async (context) => {
    try {
      const worktreeParentDir = await resolveWorktreeParentDir(configDir());
      if (!existsSync(worktreeParentDir)) {
        json(context, 200, { removed: [], kept: [], errors: [] });
        return;
      }

      const entries = await fs.readdir(worktreeParentDir, {
        withFileTypes: true,
      });
      const prDirs = entries
        .filter((entry) => entry.isDirectory() && /-pr-\d+$/.test(entry.name))
        .map((entry) => path.join(worktreeParentDir, entry.name));

      const removed: string[] = [];
      const kept: string[] = [];
      const errors: string[] = [];

      for (const prDir of prDirs.slice(0, 10)) {
        try {
          assertPathAllowed(prDir, getAllowedDirectories());
        } catch {
          continue;
        }

        // Run with `cwd: prDir` rather than `git -C prDir`: `ProcessManager`
        // reapplies the sandbox gate at exec time only to `cwd`, so `-C` with an
        // undefined cwd would skip that execution-time revalidation and let a
        // dir swapped after the route check escape the allowed roots.
        const branchResult = await processManager.exec(
          getResolvedGitPath(),
          ["rev-parse", "--abbrev-ref", "HEAD"],
          prDir,
          { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS }
        );
        if (branchResult.exitCode !== 0) {
          // A rev-parse failure is a cleanup error, not a healthy live worktree:
          // record it in `errors` so callers can distinguish it from a kept
          // worktree whose branch still exists on origin.
          errors.push(prDir);
          continue;
        }

        const branch = branchResult.stdout.trim();
        const remoteResult = await processManager.exec(
          getResolvedGitPath(),
          ["ls-remote", "--heads", "origin", branch],
          prDir,
          { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS }
        );
        if (remoteResult.exitCode !== 0) {
          errors.push(prDir);
          continue;
        }

        if (remoteResult.stdout.trim() === "") {
          const removeResult = await processManager.exec(
            getResolvedGitPath(),
            ["worktree", "remove", prDir],
            prDir,
            { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS }
          );
          if (removeResult.exitCode === 0) {
            removed.push(prDir);
          } else {
            errors.push(prDir);
          }
        } else {
          kept.push(prDir);
        }
      }

      json(context, 200, { removed, kept, errors });
    } catch (error) {
      if (error instanceof SymphonyDirNotConfiguredError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Worktree cleanup failed: ${message}` });
    }
  });
}

/**
 * Whether `targetPath` is a worktree registered with git (i.e. it appears as a
 * `worktree <path>` entry in `git worktree list --porcelain` run from inside
 * it). Guards the forced-delete fallback so it never recursively removes a plain
 * directory or an ordinary repository that merely lives under the sandbox.
 */
async function isRegisteredWorktree(
  processManager: ProcessManager,
  targetPath: string
): Promise<boolean> {
  const listResult = await processManager.exec(
    getResolvedGitPath(),
    ["worktree", "list", "--porcelain"],
    targetPath,
    { timeoutMs: GIT_GATEWAY_EXEC_TIMEOUT_MS }
  );
  if (listResult.exitCode !== 0) {
    return false;
  }
  const canonicalTarget = await canonicalizePath(targetPath);
  for (const line of listResult.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const registeredPath = await canonicalizePath(
      line.slice("worktree ".length)
    );
    if (registeredPath === canonicalTarget) {
      return true;
    }
  }
  return false;
}

async function canonicalizePath(rawPath: string): Promise<string> {
  try {
    return await fs.realpath(rawPath);
  } catch {
    return path.resolve(rawPath);
  }
}

async function resolveWorktreeParentDir(
  reposConfigDir: string
): Promise<string> {
  if (process.env.SYMPHONY_WORKTREE_PARENT_DIR) {
    return expandHome(process.env.SYMPHONY_WORKTREE_PARENT_DIR);
  }

  const config = await loadReposConfig(reposConfigDir);
  if (config.settings.worktreeParentDir) {
    return expandHome(config.settings.worktreeParentDir);
  }

  throw new Error("Worktree parent directory not configured");
}
