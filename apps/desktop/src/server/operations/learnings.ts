import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gatewayLog } from "../../main/gateway-logger.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { getShellEnv, resolveBinaryFromLoginShell } from "../shell-path.js";
import { listAllWorktrees } from "./git-helpers.js";
import { parseBody } from "./parse-body.js";
import { findPluginScript } from "./plugin-cache.js";
import { loadReposConfig } from "./repos-config-utils.js";
import { json } from "./response-utils.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";
import {
  assertRepoAllowed,
  expandHome,
  resolveWorktreeDir,
} from "./symphony-utils.js";

type ParsedLearningPattern = {
  id: string;
  summary: string;
  raw: string;
};

type LearningUsed = {
  summary: string;
};

export function registerLearningsRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string
): void {
  dispatcher.register("GET", "/api/gateway/learnings", async (context) => {
    const newPath = path.join(
      os.homedir(),
      ".closedloop-ai",
      "learnings",
      "org-patterns.toon"
    );
    const legacyPath = path.join(
      os.homedir(),
      ".claude",
      ".learnings",
      "org-patterns.toon"
    );
    const filePath = existsSync(newPath) ? newPath : legacyPath;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      json(context, 200, { patterns: parseToon(content) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        json(context, 200, { patterns: [] });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      json(context, 500, { error: `Failed to read learnings: ${message}` });
    }
  });

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/extract-learnings",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const ticketId = asString(body.ticketId);
      const repoPath = asString(body.repoPath);
      const activeTab = asString(body.activeTab) ?? undefined;
      const chatFile = asString(body.chatFile) ?? "chat-history.json";

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repoPath are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      const chatHistoryPath = path.join(claudeWorkDir, chatFile);

      try {
        assertPathAllowed(claudeWorkDir, getAllowedDirectories());
        assertPathAllowed(chatHistoryPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      if (!existsSync(chatHistoryPath)) {
        json(context, 404, { error: "No chat history found", path: chatFile });
        return;
      }

      const learningsDir = path.join(claudeWorkDir, ".learnings");
      await fs.mkdir(learningsDir, { recursive: true });

      const statusPath = path.join(learningsDir, "chat-extraction-status.json");
      await fs.writeFile(
        statusPath,
        JSON.stringify({
          status: "processing",
          ticketId,
          activeTab: activeTab ?? null,
          timestamp: new Date().toISOString(),
        }),
        "utf-8"
      );

      void (async () => {
        await sleep(250);
        await fs.writeFile(
          statusPath,
          JSON.stringify({
            status: "completed",
            count: 0,
            ticketId,
            activeTab: activeTab ?? null,
            timestamp: new Date().toISOString(),
          }),
          "utf-8"
        );
      })();

      json(context, 200, { status: "processing" });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/process-learnings",
    async (context) => {
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repo are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const statusPath = path.join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        ".learnings",
        "processing-status.json"
      );

      if (!existsSync(statusPath)) {
        json(context, 200, { status: "none" });
        return;
      }

      try {
        const content = await fs.readFile(statusPath, "utf-8");
        json(context, 200, JSON.parse(content));
      } catch {
        json(context, 200, { status: "none" });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/process-learnings",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const ticketId = asString(body.ticketId);
      const repoPath = asString(body.repoPath);
      const waitForExtraction = Boolean(body.waitForExtraction);

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repoPath are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      const learningsDir = path.join(claudeWorkDir, ".learnings");
      const pendingDir = path.join(learningsDir, "pending");
      const processingStatusPath = path.join(
        learningsDir,
        "processing-status.json"
      );

      try {
        assertPathAllowed(claudeWorkDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      await fs.mkdir(learningsDir, { recursive: true });

      if (waitForExtraction) {
        await fs.writeFile(
          processingStatusPath,
          JSON.stringify({
            status: "waiting",
            timestamp: new Date().toISOString(),
          }),
          "utf-8"
        );
        json(context, 200, { status: "waiting" });
        return;
      }

      if (!existsSync(pendingDir)) {
        json(context, 200, {
          status: "skipped",
          reason: "No pending learnings directory",
        });
        return;
      }

      const pendingFiles = await fs
        .readdir(pendingDir)
        .then((entries) => entries.filter((entry) => entry.endsWith(".json")))
        .catch(() => []);

      if (pendingFiles.length === 0) {
        json(context, 200, {
          status: "skipped",
          reason: "No pending learning files",
        });
        return;
      }

      await fs.writeFile(
        processingStatusPath,
        JSON.stringify({
          status: "processing",
          timestamp: new Date().toISOString(),
        }),
        "utf-8"
      );

      const scriptPath = findPluginScript(
        "self-learning",
        "process-chat-learnings.sh"
      );
      if (scriptPath) {
        const logFile = path.join(claudeWorkDir, "process-learnings.log");
        const child = spawn(scriptPath, [claudeWorkDir], {
          detached: true,
          stdio: "ignore",
          cwd: worktreeDir,
          env: await getShellEnv({ CLOSEDLOOP_WORKDIR: claudeWorkDir }),
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          gatewayLog.warn(
            "learnings-launch",
            `detached-spawn-failed: ${err.message}`
          );
        });
        child.unref();
        json(context, 200, { status: "processing", pid: child.pid, logFile });
        return;
      }

      void (async () => {
        await sleep(300);
        await fs.writeFile(
          processingStatusPath,
          JSON.stringify({
            status: "completed",
            processed: pendingFiles.length,
            timestamp: new Date().toISOString(),
          }),
          "utf-8"
        );
      })();

      json(context, 200, { status: "processing", pid: null });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/learnings-status/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const statusPath = path.join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        ".learnings",
        "chat-extraction-status.json"
      );

      if (!existsSync(statusPath)) {
        json(context, 200, { status: "none", count: 0 });
        return;
      }

      try {
        const content = await fs.readFile(statusPath, "utf-8");
        json(context, 200, JSON.parse(content));
      } catch {
        json(context, 200, { status: "none", count: 0 });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/record-learning-use",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const ticketId = asString(body.ticketId);
      const repoPath = asString(body.repoPath);
      const learnings = Array.isArray(body.learnings)
        ? body.learnings.filter((entry): entry is LearningUsed => {
            if (!(entry && typeof entry === "object")) {
              return false;
            }
            return typeof (entry as LearningUsed).summary === "string";
          })
        : [];

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repoPath are required" });
        return;
      }

      if (learnings.length === 0) {
        json(context, 400, {
          error: "learnings array is required and must not be empty",
        });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      const learningsDir = path.join(claudeWorkDir, ".learnings");

      try {
        assertPathAllowed(claudeWorkDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      await fs.mkdir(learningsDir, { recursive: true });

      const outcomesPath = path.join(learningsDir, "outcomes.log");
      const timestamp = new Date().toISOString();
      const runId = `chat-${ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_")}`;

      const lines = learnings.map((learning) => {
        const summary = learning.summary.replaceAll("|", "/");
        return `${timestamp}|${runId}|0|interactive-chat|${summary}|applied|`;
      });

      await fs.appendFile(outcomesPath, `${lines.join("\n")}\n`, "utf-8");
      void triggerSuccessRateComputation(claudeWorkDir);

      json(context, 200, {
        status: "recorded",
        count: learnings.length,
      });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/pending-learnings",
    async (context) => {
      try {
        const configDir = path.join(getSymphonyDir(), "config");
        const reposConfig = await loadReposConfig(configDir);
        let totalCount = 0;
        let worktreeCount = 0;

        for (const repo of reposConfig.repos) {
          const expandedRepoPath = expandHome(repo.path);
          if (!existsSync(expandedRepoPath)) {
            continue;
          }
          const worktrees = listAllWorktrees(expandedRepoPath);
          for (const worktreeDir of worktrees) {
            const pendingDir = path.join(
              worktreeDir,
              ".closedloop-ai",
              "work",
              ".learnings",
              "pending"
            );
            if (!existsSync(pendingDir)) {
              continue;
            }
            try {
              const entries = await fs.readdir(pendingDir);
              const pendingCount = entries.filter((entry) =>
                entry.endsWith(".json")
              ).length;
              if (pendingCount > 0) {
                totalCount += pendingCount;
                worktreeCount += 1;
              }
            } catch {
              // Best-effort — skip worktrees we cannot read
            }
          }
        }

        json(context, 200, { totalCount, worktreeCount });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, {
          error: `Failed to scan pending learnings: ${message}`,
        });
      }
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/process-all-learnings",
    async (context) => {
      const statusPath = path.join(
        os.homedir(),
        ".closedloop-ai",
        "learnings",
        "batch-processing-status.json"
      );

      if (!existsSync(statusPath)) {
        json(context, 200, { status: "none" });
        return;
      }

      try {
        const content = await fs.readFile(statusPath, "utf-8");
        json(context, 200, JSON.parse(content));
      } catch {
        json(context, 200, { status: "none" });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/process-all-learnings",
    async (context) => {
      const statusDir = path.join(os.homedir(), ".closedloop-ai", "learnings");
      const statusPath = path.join(statusDir, "batch-processing-status.json");

      if (existsSync(statusPath)) {
        try {
          const existing = JSON.parse(await fs.readFile(statusPath, "utf-8"));
          if (existing.status === "processing") {
            json(context, 200, {
              status: "already_processing",
              worktreeCount: existing.worktreeCount,
              processedWorktrees: existing.processedWorktrees,
              startedAt: existing.startedAt,
            });
            return;
          }
        } catch {
          // Corrupt status file — fall through and start a new batch
        }
      }

      try {
        const configDir = path.join(getSymphonyDir(), "config");
        const reposConfig = await loadReposConfig(configDir);
        const worktrees: Array<{
          worktreeDir: string;
          claudeWorkDir: string;
          pendingCount: number;
        }> = [];

        for (const repo of reposConfig.repos) {
          const expandedRepoPath = expandHome(repo.path);
          if (!existsSync(expandedRepoPath)) {
            continue;
          }
          const repoWorktrees = listAllWorktrees(expandedRepoPath);
          for (const worktreeDir of repoWorktrees) {
            const claudeWorkDir = path.join(
              worktreeDir,
              ".closedloop-ai",
              "work"
            );
            const pendingDir = path.join(
              claudeWorkDir,
              ".learnings",
              "pending"
            );
            if (!existsSync(pendingDir)) {
              continue;
            }
            try {
              const entries = await fs.readdir(pendingDir);
              const pendingCount = entries.filter((entry) =>
                entry.endsWith(".json")
              ).length;
              if (pendingCount > 0) {
                worktrees.push({ worktreeDir, claudeWorkDir, pendingCount });
              }
            } catch {
              // Best-effort
            }
          }
        }

        if (worktrees.length === 0) {
          json(context, 200, {
            status: "skipped",
            reason: "No pending learnings found",
          });
          return;
        }

        const scriptPath = findPluginScript(
          "self-learning",
          "process-chat-learnings.sh"
        );
        if (!scriptPath) {
          json(context, 404, {
            error:
              "process-chat-learnings.sh not found in self-learning plugin",
          });
          return;
        }

        await fs.mkdir(statusDir, { recursive: true });
        const startedAt = new Date().toISOString();
        const totalPending = worktrees.reduce(
          (sum, w) => sum + w.pendingCount,
          0
        );

        await fs.writeFile(
          statusPath,
          JSON.stringify({
            status: "processing",
            worktreeCount: worktrees.length,
            totalPending,
            processedWorktrees: 0,
            startedAt,
          }),
          "utf-8"
        );

        // Sequentially run the script for each worktree via a detached bash
        // wrapper and update the status file after each. Matches the legacy
        // apps/app handler's wrapper-script shape so downstream callers see
        // the same progress envelope.
        const statusPathEscaped = JSON.stringify(statusPath);
        const perWorktreeCommands = worktrees
          .map((w, i) =>
            [
              `echo "[batch] Processing" ${JSON.stringify(w.worktreeDir)}`,
              `${JSON.stringify(scriptPath)} ${JSON.stringify(w.claudeWorkDir)} || true`,
              `printf '{"status":"processing","worktreeCount":${worktrees.length},"totalPending":${totalPending},"processedWorktrees":${i + 1},"startedAt":"%s"}' "${startedAt}" > ${statusPathEscaped}`,
            ].join(" && ")
          )
          .join("\n");

        const wrapperScript = [
          "#!/usr/bin/env bash",
          perWorktreeCommands,
          `printf '{"status":"completed","worktreeCount":${worktrees.length},"totalPending":${totalPending},"processedWorktrees":${worktrees.length},"completedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > ${statusPathEscaped}`,
        ].join("\n");

        const logFile = path.join(statusDir, "batch-process-learnings.log");
        const logFd = openSync(logFile, "a");

        try {
          const child = spawn("bash", ["-c", wrapperScript], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: await getShellEnv(),
          });
          child.on("error", (err: NodeJS.ErrnoException) => {
            gatewayLog.warn(
              "learnings-batch",
              `detached-spawn-failed: ${err.message}`
            );
          });
          child.unref();
          closeSync(logFd);

          json(context, 200, {
            status: "processing",
            worktreeCount: worktrees.length,
            pid: child.pid,
          });
        } catch (err) {
          closeSync(logFd);
          const message = err instanceof Error ? err.message : "Unknown error";
          await fs.writeFile(
            statusPath,
            JSON.stringify({
              status: "error",
              error: message,
              completedAt: new Date().toISOString(),
            }),
            "utf-8"
          );
          json(context, 500, {
            error: `Failed to spawn batch process: ${message}`,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, {
          error: `Failed to start batch process: ${message}`,
        });
      }
    }
  );
}

function parseToon(content: string): ParsedLearningPattern[] {
  const chunks = content
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk, index) => {
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const candidateLine =
      lines[0]?.startsWith("patterns[") && lines.length > 1
        ? lines[1]
        : (lines[0] ?? "");
    const csvSummaryMatch = candidateLine.match(/^[^,]+,[^,]+,"([^"]+)"/);
    const summary = (
      csvSummaryMatch?.[1] ?? candidateLine.replace(/^[-*#\s]+/, "")
    ).slice(0, 240);
    return {
      id: `pattern-${index + 1}`,
      summary: summary || `Pattern ${index + 1}`,
      raw: chunk,
    };
  });
}

async function triggerSuccessRateComputation(workDir: string): Promise<void> {
  const runLoopPath = findPluginScript("code", "run-loop.sh");
  if (!runLoopPath) {
    return;
  }

  const pluginRoot = path.dirname(path.dirname(runLoopPath));
  const ratesScript = path.join(
    pluginRoot,
    "tools",
    "python",
    "compute_success_rates.py"
  );
  if (!existsSync(ratesScript)) {
    return;
  }

  const py = (
    await resolveBinaryFromLoginShell(
      "python3",
      getOverrideBinaryPaths()?.python3
    )
  ).path;
  const env = await getShellEnv();
  const child = spawn(py, [ratesScript, "--workdir", workDir], {
    stdio: "ignore",
    detached: true,
    env,
  });
  child.unref();
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
