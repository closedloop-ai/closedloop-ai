import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import {
  assertPathAllowed,
  DirectoryNotAllowedError,
  isPathAllowed,
} from "../security.js";
import { loadReposConfig } from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { getResolvedGitPath } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  relativeDate: string;
};

type SessionData = {
  sessions?: Array<{
    ticketId: string;
    repoPath: string;
    worktreePath: string;
    pid?: number;
    startedAt?: string;
    lastAccessedAt?: string;
  }>;
};

export function registerMetadataRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string
): void {
  dispatcher.register("GET", "/api/gateway/version", async (context) => {
    try {
      const version = execFileSync(
        getResolvedGitPath(),
        ["rev-parse", "--short", "HEAD"],
        {
          cwd: process.cwd(),
          encoding: "utf-8",
        }
      ).trim();

      const format = "%H|%h|%s|%b|%an|%ci|%cr";
      const rawLog = execFileSync(
        getResolvedGitPath(),
        ["log", "-10", `--pretty=format:${format}---COMMIT_END---`],
        {
          cwd: process.cwd(),
          encoding: "utf-8",
        }
      );

      const commits: Commit[] = rawLog
        .split("---COMMIT_END---")
        .filter((entry) => entry.trim())
        .map((entry) => {
          const parts = entry.trim().split("|");
          return {
            hash: parts[0] ?? "",
            shortHash: parts[1] ?? "",
            subject: parts[2] ?? "",
            body: parts.slice(3, -3).join("|").trim(),
            author: parts.at(-3) ?? "",
            date: parts.at(-2) ?? "",
            relativeDate: parts.at(-1) ?? "",
          };
        });

      json(context, 200, { version, commits });
    } catch {
      json(context, 500, { error: "Failed to get version info" });
    }
  });

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/status",
    async (context) => {
      const workDir = context.query.get("workDir");
      if (!workDir) {
        json(context, 400, { error: "workDir parameter is required" });
        return;
      }

      const expandedWorkDir = expandHome(workDir);
      try {
        assertPathAllowed(expandedWorkDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const stateFile = path.join(
        expandedWorkDir,
        ".closedloop-ai",
        "work",
        "state.json"
      );

      if (!existsSync(stateFile)) {
        json(context, 200, {
          isRunning: false,
          reason: "state.json not found",
        });
        return;
      }

      try {
        const content = await fs.readFile(stateFile, "utf-8");
        const state = JSON.parse(content) as {
          phase?: string;
          status?: string;
          iteration?: number;
          timestamp?: string;
        };

        const completedStatuses = new Set([
          "COMPLETED",
          "ERROR",
          "FAILED",
          "CANCELLED",
        ]);
        const isRunning = !completedStatuses.has(
          state.status?.toUpperCase() ?? ""
        );

        json(context, 200, {
          isRunning,
          phase: state.phase,
          status: state.status,
          iteration: state.iteration,
          lastUpdate: state.timestamp,
        });
      } catch (error) {
        json(context, 500, {
          isRunning: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/work-directory/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      if (!ticketId || typeof ticketId !== "string") {
        json(context, 400, {
          error: "ticketId is required and must be a string",
        });
        return;
      }

      const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
      const allowedDirectories = getAllowedDirectories();
      const symphonyDir = getSymphonyDir();
      const configDir = path.join(symphonyDir, "config");

      const sessionPath = path.join(symphonyDir, "sessions.json");
      if (existsSync(sessionPath)) {
        try {
          const sessionContent = await fs.readFile(sessionPath, "utf-8");
          const sessionData = JSON.parse(sessionContent) as SessionData;
          const session = sessionData.sessions?.find(
            (row) => row.ticketId === ticketId
          );
          if (session?.worktreePath) {
            const expanded = expandHome(session.worktreePath);
            if (
              existsSync(expanded) &&
              isPathAllowed(expanded, allowedDirectories)
            ) {
              json(context, 200, {
                exists: true,
                path: expanded,
                source: "session",
                pendingClaudeMd: checkPendingClaudeMd(expanded),
                branchStatus: checkBranchStatus(expanded),
              });
              return;
            }
          }
        } catch {
          // Ignore parse errors and continue to config scan.
        }
      }

      const reposConfig = await loadReposConfig(configDir);
      for (const repo of reposConfig.repos) {
        const expandedRepoPath = expandHome(repo.path);
        if (!isPathAllowed(expandedRepoPath, allowedDirectories)) {
          continue;
        }

        const parentDir = resolveWorktreeParentDir(
          expandedRepoPath,
          reposConfig.settings.worktreeParentDir
        );
        const repoName = path.basename(expandedRepoPath);
        const worktreePath = path.join(
          parentDir,
          `${repoName}-${sanitizedTicket}`
        );

        if (!existsSync(worktreePath)) {
          continue;
        }
        if (!isPathAllowed(worktreePath, allowedDirectories)) {
          continue;
        }

        json(context, 200, {
          exists: true,
          path: worktreePath,
          source: "worktree",
          pendingClaudeMd: checkPendingClaudeMd(worktreePath),
          branchStatus: checkBranchStatus(worktreePath),
        });
        return;
      }

      json(context, 200, {
        exists: false,
        path: null,
        pendingClaudeMd: null,
        branchStatus: null,
      });
    }
  );
}

function resolveWorktreeParentDir(
  expandedRepoPath: string,
  configured?: string
): string {
  const configuredParent =
    process.env.SYMPHONY_WORKTREE_PARENT_DIR || configured;
  if (configuredParent?.trim()) {
    return expandHome(configuredParent);
  }

  return path.dirname(expandedRepoPath);
}

function checkPendingClaudeMd(worktreePath: string): string | null {
  const claudeMdPath = path.join(worktreePath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    return null;
  }

  try {
    const status = execFileSync(
      getResolvedGitPath(),
      ["status", "--porcelain", "--", "CLAUDE.md"],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5000,
      }
    ).trim();
    return status ? claudeMdPath : null;
  } catch {
    return null;
  }
}

function checkBranchStatus(worktreePath: string): {
  merged: boolean;
  remoteMissing: boolean;
} | null {
  try {
    const branch = execFileSync(
      getResolvedGitPath(),
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5000,
      }
    ).trim();

    const remoteExists = execFileSync(
      getResolvedGitPath(),
      ["ls-remote", "--heads", "origin", branch],
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5000,
      }
    ).trim();

    if (remoteExists) {
      return { merged: false, remoteMissing: false };
    }

    try {
      const mergedBranches = execFileSync(
        getResolvedGitPath(),
        ["branch", "--merged", "origin/main"],
        {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 5000,
        }
      );
      return {
        merged: mergedBranches.includes(branch),
        remoteMissing: true,
      };
    } catch {
      return { merged: false, remoteMissing: true };
    }
  } catch {
    return null;
  }
}
