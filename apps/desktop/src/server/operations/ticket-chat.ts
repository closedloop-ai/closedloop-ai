import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { resolveBinaryFromLoginShell } from "../shell-path.js";
import { loadJsonFile, saveJsonFile } from "./chat-history-store.js";
import { getReadonlyCodebaseTools, getWebOnlyTools } from "./chat-tools.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { createStreamState, processStreamEvent } from "./stream-events.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";
import { expandHome } from "./symphony-utils.js";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

type TicketChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  sessionId?: string;
};

type TicketContext = {
  identifier: string;
  title: string;
  description?: string;
  url: string;
};

export function registerTicketChatRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): void {
  dispatcher.register("GET", "/api/gateway/ticket-chat", async (context) => {
    const ticketId = context.query.get("ticketId");
    if (!ticketId) {
      json(context, 400, { error: "ticketId parameter is required" });
      return;
    }

    const history = await loadChatHistory(getSymphonyDir(), ticketId);
    json(context, 200, history);
  });

  dispatcher.register("DELETE", "/api/gateway/ticket-chat", async (context) => {
    const ticketId = context.query.get("ticketId");
    if (!ticketId) {
      json(context, 400, { error: "ticketId parameter is required" });
      return;
    }

    await saveChatHistory(getSymphonyDir(), ticketId, {
      messages: [],
      ticketId,
    });
    json(context, 200, { success: true });
  });

  dispatcher.register("POST", "/api/gateway/ticket-chat", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const ticketId = typeof body.ticketId === "string" ? body.ticketId : null;
    const message = typeof body.message === "string" ? body.message : null;
    const expectedMcpUrl =
      typeof body.expectedMcpUrl === "string" ? body.expectedMcpUrl : undefined;
    const ticketContext = isTicketContext(body.ticketContext)
      ? body.ticketContext
      : null;
    const repoPath =
      typeof body.repoPath === "string" ? body.repoPath : undefined;

    if (!(ticketId && message && ticketContext)) {
      json(context, 400, {
        error: "ticketId, message, and ticketContext are required",
      });
      return;
    }

    let expandedRepoPath: string | undefined;
    if (repoPath) {
      expandedRepoPath = expandHome(repoPath);
      try {
        assertPathAllowed(expandedRepoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }
    }

    const dir = getSymphonyDir();
    const history = await loadChatHistory(dir, ticketId);
    history.messages.push({
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });
    await saveChatHistory(dir, ticketId, history);

    const isResuming = Boolean(history.sessionId);
    const contextPrompt = buildTicketContextPrompt(
      ticketContext,
      expandedRepoPath
    );
    const prompt = isResuming
      ? message
      : `${contextPrompt}\n\n---\n\nUser: ${message}`;
    const allowedTools = expandedRepoPath
      ? await getReadonlyCodebaseTools(expectedMcpUrl)
      : await getWebOnlyTools(expectedMcpUrl);

    setStreamingHeaders(context.response);
    writeEvent(context.response, {
      type: "status",
      status: "spawning",
      resuming: isResuming,
    });

    const shellEnv = await getClaudeShellEnv();
    const claudeBin = (
      await resolveBinaryFromLoginShell(
        "claude",
        getOverrideBinaryPaths()?.claude
      )
    ).path;

    await new Promise<void>((resolve) => {
      const streamState = createStreamState(async (sessionId) => {
        if (!history.sessionId) {
          history.sessionId = sessionId;
          await saveChatHistory(dir, ticketId, history);
        }
      });

      let handled = false;
      const finish = async () => {
        if (handled) {
          return;
        }
        handled = true;

        if (streamState.assistantContent.trim()) {
          history.messages.push({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: streamState.assistantContent.trim(),
            timestamp: new Date().toISOString(),
          });
          if (streamState.capturedSessionId && !history.sessionId) {
            history.sessionId = streamState.capturedSessionId;
          }
          await saveChatHistory(dir, ticketId, history);
        }

        writeEvent(context.response, { type: "done" });
        context.response.end();
        resolve();
      };

      void processManager
        .spawnStreaming({
          command: claudeBin,
          args: [
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            `--allowedTools=${allowedTools}`,
            ...(isResuming && history.sessionId
              ? ["--resume", history.sessionId]
              : []),
          ],
          cwd: expandedRepoPath ?? os.homedir(),
          env: shellEnv,
          input: prompt,
          onLine: (line) => {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              processStreamEvent(parsed as never, streamState, (msg) =>
                context.response.write(`${msg}\n`)
              );
            } catch {
              // Skip malformed JSON lines.
            }
          },
          onError: (error) => {
            writeEvent(context.response, {
              type: "error",
              error: error.message,
            });
          },
          onExit: (exitCode) => {
            if (
              exitCode !== 0 &&
              streamState.authChallengeDetected &&
              history.sessionId
            ) {
              history.sessionId = undefined;
              void saveChatHistory(dir, ticketId, history);
            }
            writeEvent(context.response, {
              type: "result",
              success: exitCode === 0,
            });
            void finish();
          },
        })
        .then((handle) => {
          writeEvent(context.response, {
            type: "status",
            status: "running",
            pid: handle.pid,
          });
        })
        .catch((error) => {
          writeEvent(context.response, { type: "error", error: error.message });
          void finish();
        });
    });
  });
}

function getChatsRootDir(symphonyDir: string): string {
  return path.join(symphonyDir, "chats");
}

function getHistoryPath(symphonyDir: string, ticketId: string): string {
  const sanitized = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(
    getChatsRootDir(symphonyDir),
    sanitized,
    "chat-history.json"
  );
}

async function loadChatHistory(
  symphonyDir: string,
  ticketId: string
): Promise<TicketChatHistory> {
  return loadJsonFile<TicketChatHistory>(
    getHistoryPath(symphonyDir, ticketId),
    {
      messages: [],
      ticketId,
    }
  );
}

async function saveChatHistory(
  symphonyDir: string,
  ticketId: string,
  history: TicketChatHistory
): Promise<void> {
  await saveJsonFile(getHistoryPath(symphonyDir, ticketId), history);
}

function isTicketContext(value: unknown): value is TicketContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const context = value as Record<string, unknown>;
  return (
    typeof context.identifier === "string" &&
    typeof context.title === "string" &&
    typeof context.url === "string"
  );
}

function buildTicketContextPrompt(
  ticket: TicketContext,
  repoPath?: string
): string {
  const parts: string[] = [];
  parts.push(
    "You are helping a developer understand a Linear ticket before implementation.",
    `## Ticket: ${ticket.identifier}`,
    `Title: ${ticket.title}`,
    `URL: ${ticket.url}`
  );
  if (ticket.description) {
    parts.push("", ticket.description);
  }
  if (repoPath) {
    parts.push("", `Repository context path: ${repoPath}`);
  }
  parts.push("", "Be concise and helpful.");
  return parts.join("\n");
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
