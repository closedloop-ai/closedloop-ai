import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import {
  assertRepoAllowed,
  chatHistoryFilename,
  resolveWorktreeDir,
  VALID_PROVIDERS,
} from "./symphony-utils.js";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sender?: "claude" | "codex";
};

type ChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  sessionId?: string;
  contextPercent?: number | null;
};

export function registerSymphonyChatHistoryRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/symphony/chat-history/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider");

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      if (provider && !VALID_PROVIDERS.has(provider)) {
        json(context, 400, { error: "unsupported provider" });
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

      const historyPath = getChatHistoryPath(
        ticketId,
        expandedRepoPath,
        provider
      );
      const workDir = path.dirname(historyPath);
      const codexSessionExists = existsSync(
        path.join(workDir, "codex-chat-review.json")
      );

      if (!existsSync(historyPath)) {
        json(context, 200, {
          messages: [],
          ticketId,
          repoPath,
          codexSessionExists,
        });
        return;
      }

      try {
        const content = await fs.readFile(historyPath, "utf-8");
        const history = JSON.parse(content) as ChatHistory;
        json(context, 200, { ...history, codexSessionExists });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, {
          error: `Failed to read chat history: ${message}`,
        });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/chat-history/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider");

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      if (provider && !VALID_PROVIDERS.has(provider)) {
        json(context, 400, { error: "unsupported provider" });
        return;
      }

      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
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

      const message = parseMessage(body.message);
      const sessionId =
        typeof body.sessionId === "string" ? body.sessionId : undefined;

      const historyReadPath = getChatHistoryPath(
        ticketId,
        expandedRepoPath,
        provider
      );
      const historyWritePath = historyReadPath;
      const historyWriteDir = path.dirname(historyWritePath);

      try {
        assertPathAllowed(historyWriteDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      await fs.mkdir(historyWriteDir, { recursive: true });

      let history: ChatHistory;
      if (existsSync(historyReadPath)) {
        try {
          const content = await fs.readFile(historyReadPath, "utf-8");
          history = JSON.parse(content) as ChatHistory;
        } catch {
          history = { messages: [], ticketId, repoPath };
        }
      } else {
        history = { messages: [], ticketId, repoPath };
      }

      if (sessionId && !message) {
        history.sessionId = sessionId;
        try {
          await fs.writeFile(
            historyWritePath,
            JSON.stringify(history, null, 2),
            "utf-8"
          );
          json(context, 200, { success: true, sessionId });
        } catch (error) {
          const messageText =
            error instanceof Error ? error.message : "Unknown error";
          json(context, 500, {
            error: `Failed to save session ID: ${messageText}`,
          });
        }
        return;
      }

      if (!(message?.content && message.role)) {
        json(context, 400, {
          error: "message with content and role is required",
        });
        return;
      }

      history.messages.push(message);

      try {
        await fs.writeFile(
          historyWritePath,
          JSON.stringify(history, null, 2),
          "utf-8"
        );
        json(context, 200, { success: true, history });
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, {
          error: `Failed to save chat history: ${messageText}`,
        });
      }
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/symphony/chat-history/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const indexParam = context.query.get("index");
      const provider = context.query.get("provider");

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      if (provider && !VALID_PROVIDERS.has(provider)) {
        json(context, 400, { error: "unsupported provider" });
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

      const historyPath = getChatHistoryPath(
        ticketId,
        expandedRepoPath,
        provider
      );
      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const workDir = path.join(worktreeDir, ".closedloop-ai", "work");

      if (!existsSync(historyPath)) {
        if (indexParam === null && provider === "codex") {
          await fs.rm(path.join(workDir, "codex-chat-review.json"), {
            force: true,
          });
        } else if (indexParam === null && !provider) {
          await deleteSharedCodexChatState(workDir);
        }
        json(context, 200, {
          success: true,
          message: "No history to delete",
        });
        return;
      }

      try {
        if (indexParam === null) {
          await fs.rm(historyPath, { force: true });

          if (provider === "codex") {
            await fs.rm(path.join(workDir, "codex-chat-review.json"), {
              force: true,
            });
          } else if (!provider) {
            await deleteSharedCodexChatState(workDir);
          }
          // provider=claude: do NOT touch any codex state files

          json(context, 200, {
            success: true,
            message: "Chat history cleared",
          });
          return;
        }

        const index = Number.parseInt(indexParam, 10);
        if (Number.isNaN(index) || index < 0) {
          json(context, 400, { error: "Invalid index" });
          return;
        }

        const content = await fs.readFile(historyPath, "utf-8");
        const history = JSON.parse(content) as ChatHistory;

        if (index >= history.messages.length) {
          json(context, 404, { error: "Index out of bounds" });
          return;
        }

        history.messages.splice(index, 1);
        await fs.writeFile(
          historyPath,
          JSON.stringify(history, null, 2),
          "utf-8"
        );
        json(context, 200, { success: true, history });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, { error: `Failed to delete: ${message}` });
      }
    }
  );
}

/** Returns the canonical path for chat history reads and writes. */
function getChatHistoryPath(
  ticketId: string,
  expandedRepoPath: string,
  provider?: string | null
): string {
  const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
  const filename = chatHistoryFilename(provider);
  return path.join(worktreeDir, ".closedloop-ai", "work", filename);
}

/** Delete shared-surface Codex chat state files. */
async function deleteSharedCodexChatState(workDir: string): Promise<void> {
  for (const name of ["codex-chat.json", "codex-chat-review.json"]) {
    await fs.rm(path.join(workDir, name), { force: true });
  }
}
function parseMessage(value: unknown): ChatMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    (candidate.role !== "user" && candidate.role !== "assistant") ||
    typeof candidate.content !== "string" ||
    typeof candidate.timestamp !== "string"
  ) {
    return undefined;
  }

  const parsed: ChatMessage = {
    id: candidate.id,
    role: candidate.role,
    content: candidate.content,
    timestamp: candidate.timestamp,
  };

  if (candidate.sender === "claude" || candidate.sender === "codex") {
    parsed.sender = candidate.sender;
  }

  return parsed;
}
