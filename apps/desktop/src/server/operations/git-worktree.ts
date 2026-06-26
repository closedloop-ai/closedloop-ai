import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { loadReposConfig } from "./repos-config-utils.js";
import { json } from "./response-utils.js";
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
        "git",
        ["worktree", "remove", ...(force ? ["--force"] : []), expandedPath],
        expandedPath
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

        const branchResult = await processManager.exec("git", [
          "-C",
          prDir,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]);
        if (branchResult.exitCode !== 0) {
          kept.push(prDir);
          continue;
        }

        const branch = branchResult.stdout.trim();
        const remoteResult = await processManager.exec("git", [
          "-C",
          prDir,
          "ls-remote",
          "--heads",
          "origin",
          branch,
        ]);

        if (remoteResult.exitCode === 0 && remoteResult.stdout.trim() === "") {
          const removeResult = await processManager.exec(
            "git",
            ["worktree", "remove", prDir],
            prDir
          );
          if (removeResult.exitCode === 0) {
            removed.push(prDir);
          } else {
            kept.push(prDir);
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
