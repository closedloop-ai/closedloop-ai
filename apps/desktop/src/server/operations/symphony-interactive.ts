import { execSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { ContentBlock } from "@closedloop-ai/loops-api/stream-types";
import { gatewayLog } from "../../main/gateway-logger.js";
import { type RetrySpawnDeps, retrySpawn } from "../../main/spawn-retry.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { resolveBinaryFromLoginShell } from "../shell-path.js";
import { loadJsonFile, saveJsonFile } from "./chat-history-store.js";
import { ENGINEER_CHAT_TOOLS, withMcpTools } from "./chat-tools.js";
import { parseBody } from "./parse-body.js";
import { findPluginScript } from "./plugin-cache.js";
import { json } from "./response-utils.js";
import { createStreamState, processStreamEvent } from "./stream-events.js";
import { getOverrideBinaryPaths, getResolvedGitPath } from "./symphony-loop.js";
import {
  acquireLaunchLock,
  assertRepoAllowed,
  chatHistoryFilename,
  cleanStaleLock,
  expandHome,
  getLockDir,
  isProcessRunning,
  readLaunchMetadata,
  readProcessPidSync,
  releaseLaunchLock,
  resolveWorktreeDir,
  resolveWorktreeParentDir,
  tryAssertPathAllowed,
  tryAssertRepoAllowed,
  VALID_PROVIDERS,
  writeLaunchMetadata,
} from "./symphony-utils.js";

const COMMIT_JSON_REGEX = /\{[\s\S]*"title"[\s\S]*"description"[\s\S]*\}/;

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
  sender?: "claude" | "codex";
  responded?: boolean;
};

type TicketChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  sessionId?: string;
  contextPercent?: number | null;
};

type CommentChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  commentId: string;
  commentContext?: {
    author: string;
    body: string;
    path?: string;
    line?: number;
    url?: string;
    replies?: Array<{ author: string; body: string }>;
  };
  sessionId?: string;
  contextPercent?: number | null;
};

function assertAllReposAllowed(
  repoPaths: string[],
  allowedDirs: string[]
): { error: string; status: 403 } | null {
  for (const repoPath of repoPaths) {
    const result = tryAssertRepoAllowed(repoPath, allowedDirs);
    if ("error" in result) {
      return result;
    }
  }
  return null;
}

export function registerSymphonyInteractiveRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  deps: RetrySpawnDeps,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): void {
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/chat/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);

      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = asString(body.message);
      const repoInput = asString(body.repoPath) ?? context.query.get("repo");
      const contextRepoPaths = Array.isArray(body.contextRepoPaths)
        ? body.contextRepoPaths.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [];

      if (!(message && repoInput)) {
        json(context, 400, { error: "message and repoPath are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(
          repoInput,
          getAllowedDirectories()
        );
        for (const contextRepoPath of contextRepoPaths) {
          assertRepoAllowed(contextRepoPath, getAllowedDirectories());
        }
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const defaultWorktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const worktreeDir = existsSync(defaultWorktreeDir)
        ? defaultWorktreeDir
        : expandedRepoPath;

      try {
        assertPathAllowed(worktreeDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const provider = asString(body.provider);
      if (provider && !VALID_PROVIDERS.has(provider)) {
        json(context, 400, { error: "unsupported provider" });
        return;
      }
      const historyFilename = chatHistoryFilename(provider);
      const historyReadPath = path.join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        historyFilename
      );
      const history = await loadJsonFile<TicketChatHistory>(historyReadPath, {
        messages: [],
        ticketId,
        repoPath: repoInput,
      });

      history.messages.push({
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      await fs.mkdir(path.dirname(historyReadPath), { recursive: true });
      await saveJsonFile(historyReadPath, history);

      setStreamingHeaders(context.response);
      await streamClaudeChat({
        response: context.response,
        cwd: worktreeDir,
        history,
        historyPath: historyReadPath,
        prompt: buildSymphonyPrompt(message, contextRepoPaths),
        tools: await withMcpTools(ENGINEER_CHAT_TOOLS),
        getClaudeShellEnv,
      });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/comment-chat/:commentId",
    async (context) => {
      const commentId = context.params.commentId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
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

      const historyPath = getCommentHistoryPath(
        ticketId,
        expandedRepoPath,
        commentId
      );
      const history = await loadJsonFile<CommentChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        commentId,
      });

      json(context, 200, history);
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/comment-chat/:commentId",
    async (context) => {
      const commentId = context.params.commentId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = asString(body.message);
      if (!message) {
        json(context, 400, { error: "message is required" });
        return;
      }

      const commentContext =
        body.commentContext && typeof body.commentContext === "object"
          ? (body.commentContext as CommentChatHistory["commentContext"])
          : undefined;

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

      const worktreeDir = resolveWorktreeForComment(ticketId, expandedRepoPath);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const historyPath = getCommentHistoryPath(
        ticketId,
        expandedRepoPath,
        commentId
      );
      const history = await loadJsonFile<CommentChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        commentId,
        ...(commentContext ? { commentContext } : {}),
      });

      if (commentContext) {
        history.commentContext = commentContext;
      }

      history.messages.push({
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await saveJsonFile(historyPath, history);

      setStreamingHeaders(context.response);
      await streamClaudeChat({
        response: context.response,
        cwd: worktreeDir,
        history,
        historyPath,
        prompt: buildCommentPrompt(message, history.commentContext),
        tools: await withMcpTools(ENGINEER_CHAT_TOOLS),
        getClaudeShellEnv,
      });
    }
  );

  dispatcher.register(
    "PATCH",
    "/api/gateway/symphony/comment-chat/:commentId",
    async (context) => {
      const commentId = context.params.commentId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const messageId = asString(body.messageId);
      const responded =
        typeof body.responded === "boolean" ? body.responded : true;

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }

      const historyPath = getCommentHistoryPath(
        ticketId,
        repoResult.path,
        commentId
      );
      const history = await loadJsonFile<CommentChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        commentId,
      });

      if (messageId) {
        const target = history.messages.find(
          (message) => message.id === messageId
        );
        if (target) {
          target.responded = responded;
        }
      } else {
        for (let index = history.messages.length - 1; index >= 0; index -= 1) {
          if (history.messages[index].role === "assistant") {
            history.messages[index].responded = responded;
            break;
          }
        }
      }

      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await saveJsonFile(historyPath, history);
      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/symphony/comment-chat/:commentId",
    async (context) => {
      const commentId = context.params.commentId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
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

      const historyPath = getCommentHistoryPath(
        ticketId,
        expandedRepoPath,
        commentId
      );
      await fs.rm(historyPath, { force: true });
      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/commit-message/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");

      if (!ticketId) {
        json(context, 400, { error: "ticketId is required" });
        return;
      }

      if (!repoPath) {
        json(context, 400, { error: "repo query parameter is required" });
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
        json(context, 200, {
          title: `Work on ${ticketId}`,
          description: "",
          source: "default",
        });
        return;
      }

      try {
        assertPathAllowed(worktreeDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const diff = getGitDiff(worktreeDir);
      if (!diff) {
        json(context, 200, {
          title: `Work on ${ticketId}`,
          description: "",
          source: "default",
        });
        return;
      }

      try {
        const generated = await generateCommitWithClaude(
          worktreeDir,
          ticketId,
          diff,
          deps,
          getClaudeShellEnv
        );
        json(context, 200, {
          ...generated,
          source: "claude",
        });
      } catch (err) {
        gatewayLog.error(
          "commit-message",
          `generation failed: ${err instanceof Error ? err.message : String(err)}`
        );
        json(context, 200, {
          title: `Work on ${ticketId}`,
          description: "",
          source: "default",
        });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/launch",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const ticketIdentifier = asString(body.ticketIdentifier);
      const repoPath = asString(body.repoPath);
      const baseBranch = asString(body.baseBranch);
      const ticket =
        body.ticket && typeof body.ticket === "object"
          ? (body.ticket as Record<string, unknown>)
          : null;

      if (!ticketIdentifier) {
        json(context, 400, {
          error: "ticketIdentifier is required and must be a string",
        });
        return;
      }

      if (!repoPath) {
        json(context, 400, {
          error: "repoPath is required and must be a string",
        });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }
      const expandedRepoPath = repoResult.path;

      const contextRepoPaths = Array.isArray(ticket?.contextRepoPaths)
        ? ticket.contextRepoPaths.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [];
      const contextError = assertAllReposAllowed(
        contextRepoPaths,
        getAllowedDirectories()
      );
      if (contextError) {
        json(context, contextError.status, { error: contextError.error });
        return;
      }

      const branchName = sanitizeBranchName(ticketIdentifier);
      const worktreeDir = resolveWorktreeDir(
        expandedRepoPath,
        ticketIdentifier
      );

      const pathResult = tryAssertPathAllowed(
        path.dirname(worktreeDir),
        getAllowedDirectories()
      );
      if (pathResult !== true) {
        json(context, pathResult.status, { error: pathResult.error });
        return;
      }

      const repoName = path.basename(expandedRepoPath);
      const worktreeParentDir = resolveWorktreeParentDir(expandedRepoPath);
      const sanitizedTicket = ticketIdentifier.replaceAll(
        /[^a-zA-Z0-9-_]/g,
        "_"
      );
      const lockDir = getLockDir(worktreeParentDir, repoName, sanitizedTicket);

      // Fast path: if worktree exists and process is alive, return alreadyRunning
      if (existsSync(worktreeDir)) {
        const existingPid = readProcessPidSync(worktreeDir);
        if (existingPid !== null && isProcessRunning(existingPid)) {
          // Refresh PRD (harmless to running process)
          if (ticket) {
            const claudeWorkDir = path.join(
              worktreeDir,
              ".closedloop-ai",
              "work"
            );
            await fs.mkdir(claudeWorkDir, { recursive: true });
            await createPrdFile(claudeWorkDir, ticket, expandedRepoPath);
          }

          const meta = readLaunchMetadata(worktreeDir);
          const logFile = path.join(
            worktreeDir,
            ".closedloop-ai",
            "work",
            "symphony-launch.log"
          );

          json(context, 200, {
            success: true,
            ticketId: ticketIdentifier,
            branchName,
            worktreePath: worktreeDir,
            pid: existingPid,
            logFile,
            prdFile: path.join(worktreeDir, ".closedloop-ai", "work", "prd.md"),
            baseBranch: meta?.baseBranch,
            parentTicketId: meta?.parentTicketId,
            alreadyRunning: true,
          });
          return;
        }
      }

      // Clean stale locks before acquiring
      cleanStaleLock(lockDir);

      // Acquire atomic lock to prevent duplicate launches
      const lock = acquireLaunchLock(lockDir);
      if (!lock) {
        json(context, 409, { error: "Launch already in progress" });
        return;
      }

      try {
        let resolvedBaseBranch: string | undefined;

        if (!existsSync(worktreeDir)) {
          const result = await createWorktree(
            expandedRepoPath,
            worktreeDir,
            branchName,
            baseBranch
          );
          resolvedBaseBranch = result.resolvedBaseBranch;
        }

        const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
        await fs.mkdir(claudeWorkDir, { recursive: true });

        if (ticket) {
          await createPrdFile(claudeWorkDir, ticket, expandedRepoPath);
        }

        // Write metadata BEFORE PID (ordering guarantee).
        // Merge preserves existing values when new ones are undefined.
        writeLaunchMetadata(worktreeDir, {
          issueId: asString(ticket?.issueId) ?? undefined,
          ticketTitle: asString(ticket?.title) ?? undefined,
          baseBranch: resolvedBaseBranch ?? baseBranch ?? undefined,
          parentTicketId: undefined,
        });

        // Read back merged metadata so the response includes preserved values
        const mergedMeta = readLaunchMetadata(worktreeDir);

        const logFile = path.join(claudeWorkDir, "symphony-launch.log");
        const scriptPath = findPluginScript("code", "run-loop.sh");

        let pid: number | null = null;
        if (scriptPath) {
          const logFd = openSync(logFile, "a");
          let fdClosed = false;
          const child = spawn(scriptPath, [claudeWorkDir], {
            cwd: worktreeDir,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: await getClaudeShellEnv({
              CLOSEDLOOP_WORKDIR: claudeWorkDir,
            }),
          });
          child.on("error", (err: NodeJS.ErrnoException) => {
            if (!fdClosed) {
              try {
                closeSync(logFd);
                fdClosed = true;
              } catch (closeErr) {
                gatewayLog.warn(
                  "symphony-launch",
                  `closeSync failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`
                );
              }
            }
            gatewayLog.warn(
              "symphony-launch",
              `detached-spawn-failed: ${err.message}`
            );
          });
          if (!child.pid) {
            if (!fdClosed) {
              closeSync(logFd);
              fdClosed = true;
            }
            json(context, 500, {
              error: "failed to launch work loop: process did not start",
            });
            return;
          }
          child.unref();
          pid = child.pid;

          // Close parent's copy of the log fd — the child inherited it via spawn
          if (!fdClosed) {
            closeSync(logFd);
            fdClosed = true;
          }
        }

        // Write PID AFTER metadata
        if (pid) {
          await fs.writeFile(
            path.join(claudeWorkDir, "process.pid"),
            String(pid)
          );
        }

        json(context, 200, {
          success: true,
          ticketId: ticketIdentifier,
          branchName,
          worktreePath: worktreeDir,
          pid,
          logFile,
          prdFile: path.join(worktreeDir, ".closedloop-ai", "work", "prd.md"),
          baseBranch: mergedMeta?.baseBranch,
          parentTicketId: mergedMeta?.parentTicketId,
        });
      } catch (error) {
        json(context, 500, {
          error: `Failed to launch Symphony: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      } finally {
        releaseLaunchLock(lockDir, lock.fd);
      }
    }
  );
}

async function streamClaudeChat(options: {
  response: ServerResponse;
  cwd: string;
  history: TicketChatHistory | CommentChatHistory;
  historyPath: string;
  prompt: string;
  tools: string;
  getClaudeShellEnv: ClaudeCodeShellEnvProvider;
}): Promise<void> {
  const {
    response,
    cwd,
    history,
    historyPath,
    prompt,
    tools,
    getClaudeShellEnv,
  } = options;

  const streamState = createStreamState(async (sessionId) => {
    history.sessionId = sessionId;
    await saveJsonFile(historyPath, history);
  });

  try {
    const child = spawn(
      "claude",
      [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--allowedTools",
        tools,
        ...(history.sessionId ? ["--resume", history.sessionId] : []),
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: await getClaudeShellEnv(),
      }
    );

    if (!child.pid) {
      throw new Error("failed to spawn claude process");
    }

    writeEvent(response, {
      type: "status",
      status: "running",
      pid: child.pid,
    });

    child.stdout.setEncoding("utf-8");
    let buffer = "";
    child.stdout.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event as never, streamState, (msg) =>
            response.write(`${msg}\n`)
          );
        } catch {
          // Ignore malformed stream lines.
        }
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      writeEvent(response, { type: "error", error: text });
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitCode = await waitForExit(child);

    if (streamState.assistantContent.trim()) {
      history.messages.push({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: streamState.assistantContent.trim(),
        timestamp: new Date().toISOString(),
        blocks: streamState.assistantBlocks,
      });
    }
    history.contextPercent = streamState.contextPercent;
    if (
      exitCode !== 0 &&
      streamState.authChallengeDetected &&
      history.sessionId
    ) {
      history.sessionId = undefined;
    }
    await saveJsonFile(historyPath, history);

    writeEvent(response, { type: "result", success: exitCode === 0 });
    writeEvent(response, { type: "done" });
    response.end();
  } catch (error) {
    writeEvent(response, {
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    writeEvent(response, { type: "done" });
    response.end();
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function buildSymphonyPrompt(
  message: string,
  contextRepoPaths: string[]
): string {
  if (contextRepoPaths.length === 0) {
    return message;
  }

  return [
    "Additional context repositories are available:",
    ...contextRepoPaths.map((repoPath) => `- ${expandHome(repoPath)}`),
    "",
    message,
  ].join("\n");
}

function buildCommentPrompt(
  message: string,
  commentContext?: CommentChatHistory["commentContext"]
): string {
  if (!commentContext) {
    return message;
  }

  const parts = [
    `PR comment from @${commentContext.author}:`,
    commentContext.body,
    "",
    message,
  ];

  if (commentContext.path) {
    parts.unshift(
      "File: " +
        commentContext.path +
        (commentContext.line ? `:${commentContext.line}` : "")
    );
  }

  return parts.join("\n");
}

function getCommentHistoryPath(
  ticketId: string,
  expandedRepoPath: string,
  commentId: string
): string {
  const worktreeDir = resolveWorktreeForComment(ticketId, expandedRepoPath);
  const sanitizedComment = commentId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    "comment-chats",
    `${sanitizedComment}.json`
  );
}

function resolveWorktreeForComment(
  ticketId: string,
  expandedRepoPath: string
): string {
  const candidate = resolveWorktreeDir(expandedRepoPath, ticketId);
  if (existsSync(candidate)) {
    return candidate;
  }
  return expandedRepoPath;
}

// Strips AI-vendor branding from commit text and normalises whitespace.
// Backticks are intentionally NOT stripped here — slugs used in URL paths
// (e.g. /implementation-plans/<slug>) never contain backticks because slug
// values arrive as alphanumeric-hyphen strings; the caller additionally strips
// newlines via .replace(/[\r\n]/g, ''), so the result is safe for shell
// heredocs and template-literal URL construction.
export function sanitizeCommitMessage(text: string): string {
  return text
    .replaceAll(/claude\s*code/gi, "")
    .replaceAll(/\bopus\b/gi, "")
    .replaceAll(/\bclaude\b/gi, "")
    .replaceAll(/\bsonnet\b/gi, "")
    .replaceAll(/\bhaiku\b/gi, "")
    .replaceAll(/\banthropic\b/gi, "")
    .replaceAll(/AI\s*assistant/gi, "")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

function getGitDiff(worktreeDir: string): string {
  try {
    const raw = execSync(
      "git diff HEAD --stat && echo '---' && git diff HEAD",
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      }
    );

    // The echo separator is always present; strip it to detect empty diffs
    const diff = raw.replaceAll(/^---\n?$/gm, "").trim();
    if (!diff) {
      return "";
    }

    if (raw.length > 15_000) {
      return `${raw.slice(0, 15_000)}\n\n[diff truncated...]`;
    }

    return raw;
  } catch {
    return "";
  }
}

async function generateCommitWithClaude(
  worktreeDir: string,
  ticketId: string,
  diff: string,
  deps: RetrySpawnDeps,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider
): Promise<{ title: string; description: string }> {
  const env = await getClaudeShellEnv();
  const claudeBin = (
    await resolveBinaryFromLoginShell(
      "claude",
      getOverrideBinaryPaths()?.claude
    )
  ).path;
  return retrySpawn(
    () =>
      new Promise<{ title: string; description: string }>((resolve, reject) => {
        const prompt = [
          `Generate a git commit message for ticket ${ticketId}.`,
          "",
          "Here is the diff of all changes:",
          "```diff",
          diff,
          "```",
          "",
          "Return ONLY a JSON object with this exact format:",
          '{"title": "Short title under 72 chars", "description": "Bullet points of what changed"}',
          "",
          "Do NOT include AI or assistant references.",
        ].join("\n");

        const child = spawn(claudeBin, ["--model", "haiku", "-p", prompt], {
          cwd: worktreeDir,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("claude timed out after 30s"));
        }, 30_000);

        child.on("close", (code) => {
          clearTimeout(timer);

          if (stderr) {
            gatewayLog.error(
              "commit-message",
              `claude stderr: ${stderr.slice(0, 500)}`
            );
          }

          if (code !== 0) {
            gatewayLog.error(
              "commit-message",
              `claude exited with code ${code}`
            );
          }

          // Parse stdout regardless of exit code — claude may produce
          // valid output even with non-zero exit.
          const match = COMMIT_JSON_REGEX.exec(stdout);
          if (match?.[0]) {
            try {
              const parsed = JSON.parse(match[0]) as {
                title?: string;
                description?: string;
              };
              resolve({
                title: sanitizeCommitMessage(
                  parsed.title ?? `Work on ${ticketId}`
                ),
                description: sanitizeCommitMessage(parsed.description ?? ""),
              });
              return;
            } catch {
              // JSON parse failed, fall through
            }
          }

          reject(
            new Error(`claude exited with code ${code}, no usable output`)
          );
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          gatewayLog.error(
            "commit-message",
            `failed to spawn claude: ${err.message}`
          );
          reject(err);
        });
      }),
    deps
  );
}

function sanitizeBranchName(ticketId: string): string {
  const normalized = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "-");
  return `feature/${normalized}`;
}

async function createWorktree(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string,
  baseBranch?: string | null
): Promise<{ resolvedBaseBranch: string }> {
  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

  const gitBin = getResolvedGitPath();
  try {
    execSync(`${gitBin} fetch origin`, {
      cwd: expandedRepoPath,
      stdio: "pipe",
    });
  } catch {
    // non-fatal
  }

  const resolvedBaseRef = resolveBaseRef(expandedRepoPath, baseBranch);
  execSync(
    `${shellEscapeArg(gitBin)} worktree add -B ${shellEscapeArg(branchName)} ${shellEscapeArg(worktreeDir)} ${shellEscapeArg(resolvedBaseRef)}`,
    {
      cwd: expandedRepoPath,
      stdio: "pipe",
    }
  );

  return { resolvedBaseBranch: resolvedBaseRef };
}

function resolveBaseRef(
  expandedRepoPath: string,
  baseBranch?: string | null
): string {
  if (baseBranch) {
    const candidate = baseBranch.trim();
    if (/^[a-zA-Z0-9/_.-]+$/.test(candidate)) {
      const gitBin = getResolvedGitPath();
      try {
        execSync(
          `${shellEscapeArg(gitBin)} rev-parse --verify ${shellEscapeArg(candidate)}`,
          {
            cwd: expandedRepoPath,
            stdio: "pipe",
          }
        );
        return candidate;
      } catch {
        try {
          const originRef = `origin/${candidate}`;
          execSync(
            `${shellEscapeArg(gitBin)} rev-parse --verify ${shellEscapeArg(originRef)}`,
            {
              cwd: expandedRepoPath,
              stdio: "pipe",
            }
          );
          return originRef;
        } catch {
          // continue to default
        }
      }
    }
  }

  try {
    const ref = execSync(
      `${shellEscapeArg(getResolvedGitPath())} symbolic-ref refs/remotes/origin/HEAD`,
      {
        cwd: expandedRepoPath,
        stdio: "pipe",
        encoding: "utf-8",
      }
    ).trim();
    return ref.replace("refs/remotes/", "");
  } catch {
    return "HEAD";
  }
}

function shellEscapeArg(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

async function createPrdFile(
  claudeWorkDir: string,
  ticket: Record<string, unknown>,
  primaryRepoPath: string
): Promise<void> {
  const title = asString(ticket.title) ?? "Untitled Ticket";
  const identifier = asString(ticket.identifier) ?? "UNKNOWN";
  const url = asString(ticket.url) ?? "";
  const description = asString(ticket.description) ?? "";
  const additionalContext = asString(ticket.additionalContext);

  const contextRepoPaths = Array.isArray(ticket.contextRepoPaths)
    ? ticket.contextRepoPaths.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : [];

  const primaryRepoName = path.basename(primaryRepoPath);
  const mentionedFiles = Array.isArray(ticket.mentionedFiles)
    ? (ticket.mentionedFiles.filter(
        (entry): entry is { repoPath: string; filePath: string } => {
          if (!(entry && typeof entry === "object")) {
            return false;
          }
          const raw = entry as Record<string, unknown>;
          return (
            typeof raw.repoPath === "string" && typeof raw.filePath === "string"
          );
        }
      ) as Array<{ repoPath: string; filePath: string }>)
    : [];

  const referencedFiles = mentionedFiles.map((file) => {
    const repoName = path.basename(expandHome(file.repoPath));
    if (repoName === primaryRepoName) {
      return path.join(path.dirname(claudeWorkDir), file.filePath);
    }

    return path.join(expandHome(file.repoPath), file.filePath);
  });

  const prdContent = [
    `# ${title}`,
    "",
    `**Ticket:** [${identifier}](${url})`,
    "",
    "## Description",
    "",
    description,
    additionalContext
      ? `\n## Additional Instructions\n\n${additionalContext}`
      : "",
    contextRepoPaths.length > 0
      ? "\n## Context Repositories\n\n" +
        contextRepoPaths
          .map((repoPath) => `- \`${expandHome(repoPath)}\``)
          .join("\n")
      : "",
    referencedFiles.length > 0
      ? "\n## Referenced Files\n\n" +
        referencedFiles.map((file) => `- \`${file}\``).join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(path.join(claudeWorkDir, "prd.md"), prdContent, "utf-8");
}

function setStreamingHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.socket?.setNoDelay(true);
}

function writeEvent(
  response: ServerResponse,
  payload: Record<string, unknown>
): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
