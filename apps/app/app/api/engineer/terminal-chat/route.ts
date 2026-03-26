import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { withMcpTools } from "@/lib/engineer/allowed-tools";
import {
  getLearningAttributionInstruction,
  getOrgPatternsContext,
} from "@/lib/engineer/learnings";
import { migrateLegacyChatHistory } from "@/lib/engineer/migrate-chat-history";
import { expandHome, loadReposConfig } from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";
import {
  type ContentBlock,
  createStreamState,
  makeResultKillTimer,
  processStreamEvent,
} from "@/lib/engineer/stream-events";

type MessageMode = "claude" | "codex";

type TerminalMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  mode?: MessageMode;
  blocks?: ContentBlock[];
};

type TerminalChatHistory = {
  messages: TerminalMessage[];
  claudeSessionId?: string;
  codexSessionId?: string;
};

const HISTORY_PATH = join(
  homedir(),
  ".claude",
  ".closedloop",
  "chats",
  "_terminal",
  "chat-history.json"
);

const LEGACY_HISTORY_PATH = join(
  homedir(),
  ".claude",
  ".symphony",
  "chats",
  "_terminal",
  "chat-history.json"
);

function loadChatHistory(): TerminalChatHistory {
  migrateLegacyChatHistory(LEGACY_HISTORY_PATH, HISTORY_PATH);
  if (!existsSync(HISTORY_PATH)) {
    return { messages: [] };
  }
  try {
    const content = readFileSync(HISTORY_PATH, "utf-8");
    return JSON.parse(content) as TerminalChatHistory;
  } catch {
    return { messages: [] };
  }
}

function saveChatHistory(history: TerminalChatHistory): void {
  const dir = join(HISTORY_PATH, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Parse a user message to determine routing mode.
 * Claude is the default; @codex routes to Codex.
 * @cl prefix still accepted for backward compat.
 */
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

/**
 * Get the GitHub remote URL for a repo path, or null if unavailable.
 */
function getGitRemoteUrl(repoPath: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get the current branch name for a repo path, or null if unavailable.
 */
function getGitBranch(repoPath: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Format a single repo's metadata as markdown list items.
 */
function formatRepoContext(repo: {
  path: string;
  name: string;
  description?: string;
  deployment?: { command: string; port?: number };
}): string {
  const expanded = expandHome(repo.path);
  const remoteUrl = getGitRemoteUrl(expanded);
  const branch = getGitBranch(expanded);

  const lines: string[] = [`- **${repo.name}**`];
  lines.push(`  - Path: \`${repo.path}\``);
  if (remoteUrl) {
    lines.push(`  - Remote: ${remoteUrl}`);
  }
  if (branch) {
    lines.push(`  - Branch: \`${branch}\``);
  }
  if (repo.description) {
    lines.push(`  - Description: ${repo.description}`);
  }
  if (repo.deployment) {
    lines.push(`  - Dev command: \`${repo.deployment.command}\``);
    if (repo.deployment.port) {
      lines.push(`  - Port: ${repo.deployment.port}`);
    }
  }
  return lines.join("\n");
}

/**
 * Read and truncate a repo's CLAUDE.md for project context.
 */
function getClaudeMdContext(repo: {
  path: string;
  name: string;
}): string | null {
  const claudeMdPath = join(expandHome(repo.path), "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    return null;
  }

  try {
    const content = readFileSync(claudeMdPath, "utf-8");
    const truncated =
      content.length > 3000
        ? `${content.slice(0, 3000)}\n\n... (truncated)`
        : content;
    return `## Project Context: ${repo.name} (from CLAUDE.md)\n${truncated}`;
  } catch {
    return null;
  }
}

/**
 * Build a rich system prompt with context from configured repos and org learnings.
 */
function buildClaudeSystemPrompt(): string {
  const parts: string[] = [
    "You are a helpful developer assistant in the closedloop.dev terminal.",
    "You help engineers with questions about their projects, code, debugging, architecture, and development workflow.",
    "",
    "Be concise and helpful. Use markdown formatting for code and structure.",
    "",
    "## Destructive Actions",
    "Any destructive or hard-to-reverse action REQUIRES explicit human approval before execution. This includes but is not limited to:",
    "- Deleting files, branches, or directories (rm, git branch -D, etc.)",
    "- Force-pushing (git push --force, --force-with-lease)",
    "- Resetting or discarding changes (git reset --hard, git checkout ., git clean)",
    "- Dropping or truncating database tables",
    "- Killing processes",
    "- Overwriting uncommitted work",
    "- Modifying CI/CD pipelines or shared infrastructure",
    "",
    "The ONLY exception is when the user's message explicitly requests the destructive action (e.g., 'delete the tmp branch', 'force push to origin'). Even then, confirm if the scope is ambiguous.",
  ];

  const config = loadReposConfig();

  if (config.repos.length > 0) {
    parts.push(
      "",
      "## Configured Repositories",
      "The engineer has the following repos configured in their workspace:",
      ...config.repos.map(formatRepoContext)
    );

    if (config.settings.worktreeParentDir) {
      parts.push(
        "",
        `Worktree parent directory: \`${config.settings.worktreeParentDir}\``
      );
    }
  }

  for (const repo of config.repos) {
    const claudeMd = getClaudeMdContext(repo);
    if (claudeMd) {
      parts.push("", claudeMd);
    }
  }

  const orgPatterns = getOrgPatternsContext();
  if (orgPatterns) {
    parts.push("", orgPatterns, "", getLearningAttributionInstruction());
  }

  return parts.join("\n");
}

/**
 * Handle Claude messages — spawn Claude CLI
 */
async function handleClaude(
  message: string,
  history: TerminalChatHistory,
  encoder: TextEncoder
): Promise<ReadableStream> {
  const isResuming = !!history.claudeSessionId;
  let claudeProcess: ReturnType<typeof spawn> | null = null;

  const shellPath = await getShellPath();
  return new ReadableStream({
    start(controller) {
      const streamState = createStreamState(
        (sessionId) => {
          if (!history.claudeSessionId) {
            history.claudeSessionId = sessionId;
            saveChatHistory(history);
          }
        },
        makeResultKillTimer(() => claudeProcess, "terminal-chat")
      );

      try {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "spawning",
              mode: "claude",
              resuming: isResuming,
            })}\n`
          )
        );

        const claudeArgs = [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          `--allowedTools=${withMcpTools("WebSearch,WebFetch,Bash")}`,
          "--append-system-prompt",
          buildClaudeSystemPrompt(),
        ];

        if (isResuming && history.claudeSessionId) {
          claudeArgs.push("--resume", history.claudeSessionId);
        }

        const claude = spawn("claude", claudeArgs, {
          cwd: homedir(),
          env: {
            ...process.env,
            PATH: shellPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeProcess = claude;

        console.log("[terminal-chat] Claude PID:", claude.pid);

        claude.stdin.write(message);
        claude.stdin.end();

        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "running",
              mode: "claude",
              pid: claude.pid,
            })}\n`
          )
        );

        const enqueue = (msg: string) => {
          controller.enqueue(encoder.encode(`${msg}\n`));
        };

        let stdoutBuffer = "";
        claude.stdout.on("data", (data: Buffer) => {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              processStreamEvent(JSON.parse(trimmed), streamState, enqueue);
            } catch {
              // Not valid JSON
            }
          }
        });

        claude.stderr.on("data", (data: Buffer) => {
          console.error("[terminal-chat claude stderr]", data.toString());
        });

        claude.on("close", (code) => {
          claudeProcess = null;
          if (stdoutBuffer.trim()) {
            try {
              processStreamEvent(
                JSON.parse(stdoutBuffer.trim()),
                streamState,
                enqueue
              );
            } catch {
              // Not valid JSON
            }
            stdoutBuffer = "";
          }

          const { assistantContent, assistantBlocks, capturedSessionId } =
            streamState;
          console.log(
            "[terminal-chat] Claude exited:",
            code,
            "len:",
            assistantContent.length
          );

          if (assistantContent.trim() || assistantBlocks.length > 0) {
            const assistantMessage: TerminalMessage = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: assistantContent.trim(),
              timestamp: new Date().toISOString(),
              mode: "claude",
              blocks: assistantBlocks.length > 0 ? assistantBlocks : undefined,
            };
            history.messages.push(assistantMessage);
          }

          if (capturedSessionId && !history.claudeSessionId) {
            history.claudeSessionId = capturedSessionId;
          }

          saveChatHistory(history);
          enqueue(JSON.stringify({ type: "done", exitCode: code }));
          controller.close();
        });

        claude.on("error", (err) => {
          claudeProcess = null;
          console.error("[terminal-chat] Claude spawn error:", err);
          enqueue(
            JSON.stringify({
              type: "error",
              error: `Failed to start Claude: ${err.message}`,
            })
          );
          controller.close();
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "error", error: errorMessage })}\n`
          )
        );
        controller.close();
      }
    },

    cancel() {
      if (claudeProcess) {
        try {
          claudeProcess.kill("SIGTERM");
        } catch {}
        claudeProcess = null;
      }
    },
  });
}

type CodexStreamCtx = {
  stdoutBuffer: string;
  accumulated: string;
};

/** Append text to accumulated output with a separator, and enqueue for streaming. */
function appendCodexText(
  ctx: CodexStreamCtx,
  text: string,
  enqueue: (msg: string) => void
): void {
  const prefix =
    ctx.accumulated && !ctx.accumulated.endsWith("\n") ? "\n\n" : "";
  ctx.accumulated += prefix + text;
  enqueue(JSON.stringify({ type: "text", content: prefix + text }));
}

/** Route a parsed Codex JSONL event to the appropriate handler. */
function handleCodexEvent(
  event: {
    type?: string;
    thread_id?: string;
    item?: { type?: string; text?: string };
  },
  ctx: CodexStreamCtx,
  history: TerminalChatHistory,
  enqueue: (msg: string) => void
): void {
  if (event.type === "thread.started" && event.thread_id) {
    history.codexSessionId = event.thread_id;
    saveChatHistory(history);
    console.log("[terminal-chat] Codex session:", event.thread_id);
    return;
  }

  if (event.type !== "item.completed" || !event.item?.text) {
    return;
  }

  if (event.item.type === "agent_message") {
    appendCodexText(ctx, event.item.text, enqueue);
  } else if (event.item.type === "reasoning") {
    enqueue(JSON.stringify({ type: "reasoning", content: event.item.text }));
  }
}

/** Process a chunk of stdout data from Codex, parsing JSONL lines. */
function processCodexChunk(
  chunk: string,
  ctx: CodexStreamCtx,
  history: TerminalChatHistory,
  enqueue: (msg: string) => void
): void {
  ctx.stdoutBuffer += chunk;
  const lines = ctx.stdoutBuffer.split("\n");
  ctx.stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      handleCodexEvent(JSON.parse(trimmed), ctx, history, enqueue);
    } catch {
      appendCodexText(ctx, trimmed, enqueue);
    }
  }
}

/** Flush remaining stdout buffer on close. */
function flushCodexBuffer(
  ctx: CodexStreamCtx,
  enqueue: (msg: string) => void
): void {
  const remaining = ctx.stdoutBuffer.trim();
  ctx.stdoutBuffer = "";
  if (!remaining) {
    return;
  }

  try {
    const event = JSON.parse(remaining);
    if (
      event.type === "item.completed" &&
      event.item?.text &&
      event.item.type === "agent_message"
    ) {
      appendCodexText(ctx, event.item.text, enqueue);
    }
  } catch {
    const prefix =
      ctx.accumulated && !ctx.accumulated.endsWith("\n") ? "\n\n" : "";
    ctx.accumulated += prefix + remaining;
  }
}

/** Save accumulated codex output to chat history. */
function saveCodexResult(
  ctx: CodexStreamCtx,
  history: TerminalChatHistory
): void {
  if (!ctx.accumulated.trim()) {
    return;
  }
  history.messages.push({
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: ctx.accumulated.trim(),
    timestamp: new Date().toISOString(),
    mode: "codex",
  });
  saveChatHistory(history);
}

/** Close controller, ignoring errors if already closed. */
function safeClose(controller: ReadableStreamDefaultController): void {
  try {
    controller.close();
  } catch {
    // Already closed
  }
}

/**
 * Handle @codex messages — spawn Codex CLI
 */
function handleCodex(
  message: string,
  history: TerminalChatHistory,
  encoder: TextEncoder
): ReadableStream {
  const isResuming = !!history.codexSessionId;

  const codexArgs: string[] = isResuming
    ? [
        "exec",
        "resume",
        history.codexSessionId!,
        message,
        "--full-auto",
        "--json",
        "-m",
        "codex-mini-latest",
      ]
    : ["exec", "--full-auto", "--json", "-m", "codex-mini-latest", message];

  let disconnected = false;

  return new ReadableStream({
    start(controller) {
      const enqueue = (msg: string) => {
        if (disconnected) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${msg}\n`));
        } catch {
          disconnected = true;
        }
      };

      enqueue(
        JSON.stringify({
          type: "status",
          status: "spawning",
          mode: "codex",
          resuming: isResuming,
        })
      );

      const codex = spawn("codex", codexArgs, {
        cwd: homedir(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          FORCE_COLOR: "0",
        },
      });

      console.log("[terminal-chat] Codex PID:", codex.pid);

      enqueue(
        JSON.stringify({
          type: "status",
          status: "running",
          mode: "codex",
          pid: codex.pid,
        })
      );

      const ctx: CodexStreamCtx = { stdoutBuffer: "", accumulated: "" };

      codex.stdout?.on("data", (data: Buffer) => {
        processCodexChunk(data.toString(), ctx, history, enqueue);
      });

      codex.stderr?.on("data", (data: Buffer) => {
        console.error("[terminal-chat codex stderr]", data.toString());
      });

      codex.on("close", (code) => {
        flushCodexBuffer(ctx, enqueue);
        console.log(
          "[terminal-chat] Codex exited:",
          code,
          "len:",
          ctx.accumulated.length
        );
        saveCodexResult(ctx, history);
        enqueue(JSON.stringify({ type: "done", exitCode: code }));
        safeClose(controller);
      });

      codex.on("error", (err) => {
        console.error("[terminal-chat] Codex spawn error:", err);
        enqueue(
          JSON.stringify({
            type: "error",
            error: `Failed to start Codex: ${err.message}`,
          })
        );
        safeClose(controller);
      });
    },
    cancel() {
      disconnected = true;
    },
  });
}

/**
 * POST /api/engineer/terminal-chat
 *
 * Chat with Claude (default) or Codex (@codex prefix)
 * Body: { message: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { message } = body as { message: string };

  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { mode, cleanMessage } = parseMessageMode(message);
  const history = loadChatHistory();

  // Save user message to history
  const userMessage: TerminalMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
    mode,
  };
  history.messages.push(userMessage);
  saveChatHistory(history);

  const encoder = new TextEncoder();
  const stream =
    mode === "codex"
      ? handleCodex(cleanMessage, history, encoder)
      : await handleClaude(cleanMessage, history, encoder);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/terminal-chat
 *
 * Retrieve chat history
 */
export function GET() {
  const history = loadChatHistory();
  return Response.json(history);
}

/**
 * DELETE /api/terminal-chat
 *
 * Clear chat history
 */
export function DELETE() {
  saveChatHistory({ messages: [] });
  return Response.json({ success: true });
}
