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

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

type RunViewerChatHistory = {
  messages: ChatMessage[];
  claudeSessionId?: string;
};

export function registerRunViewerChatRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/run-viewer-chat",
    async (context) => {
      const dir = getSymphonyDir();
      const history = await loadChatHistory(dir);
      json(context, 200, history);
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/run-viewer-chat",
    async (context) => {
      await saveChatHistory(getSymphonyDir(), { messages: [] });
      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/run-viewer-chat",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = typeof body.message === "string" ? body.message : null;
      const expectedMcpUrl =
        typeof body.expectedMcpUrl === "string"
          ? body.expectedMcpUrl
          : undefined;
      const runDir = typeof body.runDir === "string" ? body.runDir : undefined;
      if (!message) {
        json(context, 400, { error: "message is required" });
        return;
      }

      let validatedRunDir: string | undefined;
      if (runDir) {
        try {
          assertPathAllowed(runDir, getAllowedDirectories());
          validatedRunDir = path.resolve(runDir);
        } catch (error) {
          if (error instanceof DirectoryNotAllowedError) {
            json(context, 403, { error: "directory not allowed" });
            return;
          }
          throw error;
        }
      }

      const dir = getSymphonyDir();
      const history = await loadChatHistory(dir);
      history.messages.push({
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      await saveChatHistory(dir, history);

      const isResuming = Boolean(history.claudeSessionId);
      const allowedTools = validatedRunDir
        ? await getReadonlyCodebaseTools(expectedMcpUrl)
        : await getWebOnlyTools(expectedMcpUrl);
      const systemPrompt = buildRunViewerSystemPrompt(validatedRunDir);
      const prompt = isResuming
        ? message
        : `${systemPrompt}\n\n---\n\nUser: ${message}`;

      setStreamingHeaders(context.response);
      writeEvent(context.response, {
        type: "status",
        status: "spawning",
        mode: "claude",
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
          if (!history.claudeSessionId) {
            history.claudeSessionId = sessionId;
            await saveChatHistory(dir, history);
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
            await saveChatHistory(dir, history);
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
              ...(isResuming && history.claudeSessionId
                ? ["--resume", history.claudeSessionId]
                : []),
            ],
            cwd: validatedRunDir ?? os.homedir(),
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
                history.claudeSessionId
              ) {
                history.claudeSessionId = undefined;
                void saveChatHistory(dir, history);
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
              mode: "claude",
              pid: handle.pid,
            });
          })
          .catch((error) => {
            writeEvent(context.response, {
              type: "error",
              error: error.message,
            });
            void finish();
          });
      });
    }
  );
}

function getChatsRootDir(symphonyDir: string): string {
  return path.join(symphonyDir, "chats");
}

function getHistoryPath(symphonyDir: string): string {
  return path.join(
    getChatsRootDir(symphonyDir),
    "_run-viewer",
    "chat-history.json"
  );
}

async function loadChatHistory(
  symphonyDir: string
): Promise<RunViewerChatHistory> {
  return loadJsonFile<RunViewerChatHistory>(getHistoryPath(symphonyDir), {
    messages: [],
  });
}

async function saveChatHistory(
  symphonyDir: string,
  history: RunViewerChatHistory
): Promise<void> {
  await saveJsonFile(getHistoryPath(symphonyDir), history);
}

function buildRunViewerSystemPrompt(runDir?: string): string {
  const parts = [
    "You are analyzing artifacts from a Symphony AI run.",
    "Help the user understand plans, logs, and outputs.",
  ];
  if (runDir) {
    parts.push(`Run directory: ${runDir}`);
  }
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
