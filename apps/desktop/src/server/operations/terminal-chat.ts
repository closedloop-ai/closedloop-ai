import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { getShellEnv, resolveBinaryFromLoginShell } from "../shell-path.js";
import { loadJsonFile, saveJsonFile } from "./chat-history-store.js";
import { withMcpTools } from "./chat-tools.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { createStreamState, processStreamEvent } from "./stream-events.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";

type MessageMode = "claude" | "codex";

type TerminalMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  mode?: MessageMode;
};

type TerminalChatHistory = {
  messages: TerminalMessage[];
  claudeSessionId?: string;
  codexSessionId?: string;
};

export function registerTerminalChatRoutes(
  dispatcher: OperationDispatcher,
  processManager: ProcessManager,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): void {
  dispatcher.register("GET", "/api/gateway/terminal-chat", async (context) => {
    const history = await loadChatHistory(getSymphonyDir());
    json(context, 200, history);
  });

  dispatcher.register(
    "DELETE",
    "/api/gateway/terminal-chat",
    async (context) => {
      await saveChatHistory(getSymphonyDir(), { messages: [] });
      json(context, 200, { success: true });
    }
  );

  dispatcher.register("POST", "/api/gateway/terminal-chat", async (context) => {
    const body = parseBody(context);
    if (!body) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }

    const message = typeof body.message === "string" ? body.message : null;
    if (!message) {
      json(context, 400, { error: "message is required" });
      return;
    }

    const { mode, cleanMessage } = parseMessageMode(message);
    const expectedMcpUrl =
      typeof body.expectedMcpUrl === "string" ? body.expectedMcpUrl : undefined;
    const dir = getSymphonyDir();
    const history = await loadChatHistory(dir);
    history.messages.push({
      id: `user-${Date.now()}`,
      role: "user",
      content: cleanMessage,
      timestamp: new Date().toISOString(),
      mode,
    });
    await saveChatHistory(dir, history);

    const terminalCwd = await resolveTerminalWorkingDirectory(
      getAllowedDirectories()
    );
    if (!terminalCwd) {
      json(context, 500, {
        error:
          "No allowed directory is available for terminal chat execution. Update sandbox settings.",
      });
      return;
    }

    setStreamingHeaders(context.response);
    writeEvent(context.response, {
      type: "status",
      status: "spawning",
      mode,
    });

    if (mode === "claude") {
      await streamClaude(
        context.response,
        processManager,
        cleanMessage,
        history,
        terminalCwd,
        dir,
        expectedMcpUrl,
        getClaudeShellEnv
      );
      return;
    }

    await streamCodex(
      context.response,
      processManager,
      cleanMessage,
      history,
      terminalCwd,
      dir
    );
  });
}

async function streamClaude(
  response: ServerResponse,
  processManager: ProcessManager,
  message: string,
  history: TerminalChatHistory,
  terminalCwd: string,
  symphonyDir: string,
  expectedMcpUrl: string | undefined,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider
): Promise<void> {
  const streamState = createStreamState(async (sessionId) => {
    if (!history.claudeSessionId) {
      history.claudeSessionId = sessionId;
      await saveChatHistory(symphonyDir, history);
    }
  });

  const shellEnv = await getClaudeShellEnv();
  const allowedTools = await withMcpTools(
    "WebSearch,WebFetch,Bash",
    expectedMcpUrl
  );
  const claudeBin = (
    await resolveBinaryFromLoginShell(
      "claude",
      getOverrideBinaryPaths()?.claude
    )
  ).path;

  await new Promise<void>((resolve) => {
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
          mode: "claude",
        });
        await saveChatHistory(symphonyDir, history);
      }

      writeEvent(response, { type: "done" });
      response.end();
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
          ...(history.claudeSessionId
            ? ["--resume", history.claudeSessionId]
            : []),
        ],
        cwd: terminalCwd,
        env: shellEnv,
        input: message,
        onLine: (line) => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            processStreamEvent(parsed as never, streamState, (msg) =>
              response.write(`${msg}\n`)
            );
          } catch {
            // Ignore malformed JSON lines from CLI output.
          }
        },
        onError: (error) => {
          writeEvent(response, { type: "error", error: error.message });
        },
        onExit: (exitCode) => {
          if (
            exitCode !== 0 &&
            streamState.authChallengeDetected &&
            history.claudeSessionId
          ) {
            history.claudeSessionId = undefined;
            void saveChatHistory(symphonyDir, history);
          }
          writeEvent(response, {
            type: "result",
            success: exitCode === 0,
          });
          void finish();
        },
      })
      .then((handle) => {
        writeEvent(response, {
          type: "status",
          status: "running",
          mode: "claude",
          pid: handle.pid,
        });
      })
      .catch((error) => {
        writeEvent(response, { type: "error", error: error.message });
        void finish();
      });
  });
}

async function streamCodex(
  response: ServerResponse,
  processManager: ProcessManager,
  message: string,
  history: TerminalChatHistory,
  terminalCwd: string,
  symphonyDir: string
): Promise<void> {
  let assistantContent = "";
  const codexShellEnv = await getShellEnv();
  const codexBin = (
    await resolveBinaryFromLoginShell("codex", getOverrideBinaryPaths()?.codex)
  ).path;

  await new Promise<void>((resolve) => {
    let handled = false;

    const finish = async () => {
      if (handled) {
        return;
      }
      handled = true;

      if (assistantContent.trim()) {
        history.messages.push({
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: assistantContent.trim(),
          timestamp: new Date().toISOString(),
          mode: "codex",
        });
        await saveChatHistory(symphonyDir, history);
      }

      writeEvent(response, { type: "done" });
      response.end();
      resolve();
    };

    void processManager
      .spawnStreaming({
        command: codexBin,
        args: [
          "exec",
          "--full-auto",
          "--json",
          "-m",
          "codex-mini-latest",
          message,
        ],
        cwd: terminalCwd,
        env: codexShellEnv,
        isResultEvent: (line) => {
          try {
            const parsed = JSON.parse(line) as { type?: string };
            return parsed.type === "done";
          } catch {
            return false;
          }
        },
        onLine: (line) => {
          const text = extractCodexText(line);
          if (!text) {
            return;
          }

          assistantContent += text;
          writeEvent(response, { type: "text", content: text });
        },
        onError: (error) => {
          writeEvent(response, { type: "error", error: error.message });
        },
        onExit: (exitCode) => {
          writeEvent(response, {
            type: "result",
            success: exitCode === 0,
          });
          void finish();
        },
      })
      .then((handle) => {
        writeEvent(response, {
          type: "status",
          status: "running",
          mode: "codex",
          pid: handle.pid,
        });
      })
      .catch((error) => {
        writeEvent(response, { type: "error", error: error.message });
        void finish();
      });
  });
}

async function resolveTerminalWorkingDirectory(
  allowedDirectories: string[]
): Promise<string | null> {
  const unique = [
    ...new Set(allowedDirectories.map((entry) => entry.trim()).filter(Boolean)),
  ];
  for (const candidate of unique) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing/inaccessible candidates.
    }
  }
  return null;
}

function extractCodexText(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.output_text === "string") {
      return parsed.output_text;
    }
    if (typeof parsed.text === "string") {
      return parsed.text;
    }

    const item = parsed.item as Record<string, unknown> | undefined;
    if (item && typeof item.text === "string") {
      return item.text;
    }
    return "";
  } catch {
    return line;
  }
}

function parseMessageMode(message: string): {
  mode: MessageMode;
  cleanMessage: string;
} {
  const trimmed = message.trim();
  if (trimmed.startsWith("@codex ")) {
    return { mode: "codex", cleanMessage: trimmed.slice(7).trim() };
  }
  if (trimmed.startsWith("@cl ")) {
    return { mode: "claude", cleanMessage: trimmed.slice(4).trim() };
  }
  return { mode: "claude", cleanMessage: trimmed };
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
function getChatsRootDir(symphonyDir: string): string {
  return path.join(symphonyDir, "chats");
}

function getHistoryPath(symphonyDir: string): string {
  return path.join(
    getChatsRootDir(symphonyDir),
    "_terminal",
    "chat-history.json"
  );
}

async function loadChatHistory(
  symphonyDir: string
): Promise<TerminalChatHistory> {
  return loadJsonFile<TerminalChatHistory>(getHistoryPath(symphonyDir), {
    messages: [],
  });
}

async function saveChatHistory(
  symphonyDir: string,
  history: TerminalChatHistory
): Promise<void> {
  await saveJsonFile(getHistoryPath(symphonyDir), history);
}
