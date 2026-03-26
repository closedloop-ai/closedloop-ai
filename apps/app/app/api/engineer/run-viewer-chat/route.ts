import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import {
  READONLY_CODEBASE_TOOLS,
  WEB_ONLY_TOOLS,
} from "@/lib/engineer/allowed-tools";
import { migrateLegacyChatHistory } from "@/lib/engineer/migrate-chat-history";
import { getShellPath } from "@/lib/engineer/shell-path";
import {
  type ContentBlock,
  createStreamState,
  makeResultKillTimer,
  processStreamEvent,
} from "@/lib/engineer/stream-events";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
};

type ChatHistory = {
  messages: ChatMessage[];
  claudeSessionId?: string;
};

const HISTORY_PATH = join(
  homedir(),
  ".claude",
  ".closedloop",
  "chats",
  "_run-viewer",
  "chat-history.json"
);

const LEGACY_HISTORY_PATH = join(
  homedir(),
  ".claude",
  ".symphony",
  "chats",
  "_run-viewer",
  "chat-history.json"
);

function loadChatHistory(): ChatHistory {
  migrateLegacyChatHistory(LEGACY_HISTORY_PATH, HISTORY_PATH);
  if (!existsSync(HISTORY_PATH)) {
    return { messages: [] };
  }
  try {
    const content = readFileSync(HISTORY_PATH, "utf-8");
    return JSON.parse(content) as ChatHistory;
  } catch {
    return { messages: [] };
  }
}

function saveChatHistory(history: ChatHistory): void {
  const dir = join(HISTORY_PATH, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

const RUN_ARTIFACT_GUIDE = `## Symphony Run Artifact Guide

Symphony runs execute in numbered phases. Key artifacts:

PLANNING:
- prd.md — Original product requirements document
- investigation-log.md — Pre-exploration findings from codebase analysis
- plan.json — Structured plan with tasks, sections, open questions, gaps
- plan.md — Markdown rendering of plan.json content
- plan-evaluation.json — Complexity evaluation: { simple_mode, signals[] }

QUALITY:
- judges.json — Quality scores from parallel judge agents (DRY, KISS, SOLID, readability, etc.)
- reviews/ — Critic review files (architecture, performance, security)

STATE:
- state.json — Current phase, status (IN_PROGRESS|AWAITING_USER|COMPLETED), timestamp
- log.md — Append-only changelog of changes made
- claude-output.jsonl — Raw Claude CLI output per iteration

LEARNINGS:
- .learnings/ — Learning system tracking patterns and outcomes across runs
  - pending/ — Unprocessed learnings
  - org-patterns.toon — Organization-wide patterns
  - goal.yaml — Active goal configuration
  - outcomes.log — Merged relevance/goal/build results
  - runs.log — Per-run session tracking`;

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  function walk(current: string, prefix: string) {
    const items = readdirSync(current, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(join(current, item.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  walk(dir, "");
  return files;
}

function buildSystemPrompt(
  fileContext?: { path: string; contentPreview: string },
  runDir?: string
): string {
  const parts: string[] = [];

  parts.push(
    "You are analyzing artifacts from a ClosedLoop AI planning run.",
    "The user is viewing files from a zip archive containing plans, judge scores, logs, and conversation traces.",
    "Help them understand the run results.",
    "",
    "Be concise and helpful. Use markdown formatting for code and structure."
  );

  if (runDir && existsSync(runDir)) {
    parts.push(
      "",
      "## Run Directory",
      "",
      `All run files are extracted at: ${runDir}`,
      "You have Read, Glob, and Grep tools available. Use them to read any file the user asks about.",
      "When the user asks about a file, read it with the Read tool rather than relying on the preview.",
      "",
      RUN_ARTIFACT_GUIDE
    );

    try {
      const manifest = listFilesRecursive(runDir);
      parts.push("", "## File Manifest", "", "```", ...manifest, "```");
    } catch {
      // Directory listing failed, skip manifest
    }
  }

  if (fileContext) {
    parts.push(
      "",
      "## Currently Viewing",
      "",
      `The user is currently viewing file: ${fileContext.path}`,
      "",
      "File preview (first 4000 chars):",
      fileContext.contentPreview
    );
  }

  return parts.join("\n");
}

/**
 * POST /api/run-viewer-chat
 *
 * Chat with Claude about run viewer files.
 * Body: { message: string, fileContext?: { path: string, contentPreview: string }, runDir?: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { message, fileContext, runDir } = body as {
    message: string;
    fileContext?: { path: string; contentPreview: string };
    runDir?: string;
  };

  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate runDir if provided (security: must be our temp directory)
  const validatedRunDir =
    runDir?.startsWith("/tmp/run-viewer-") && !runDir.includes("..")
      ? runDir
      : undefined;

  const history = loadChatHistory();

  // Save user message
  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };
  history.messages.push(userMessage);
  saveChatHistory(history);

  const encoder = new TextEncoder();
  const stream = await spawnClaude(
    message,
    fileContext,
    validatedRunDir,
    history,
    encoder
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/run-viewer-chat
 *
 * Retrieve chat history.
 */
export function GET() {
  const history = loadChatHistory();
  return Response.json(history);
}

/**
 * DELETE /api/run-viewer-chat
 *
 * Clear chat history.
 */
export function DELETE() {
  saveChatHistory({ messages: [] });
  return Response.json({ success: true });
}

async function spawnClaude(
  message: string,
  fileContext: { path: string; contentPreview: string } | undefined,
  runDir: string | undefined,
  history: ChatHistory,
  encoder: TextEncoder
): Promise<ReadableStream> {
  const isResuming = !!history.claudeSessionId;
  const systemPrompt = buildSystemPrompt(fileContext, runDir);
  const prompt = isResuming
    ? message
    : `${systemPrompt}\n\n---\n\nUser: ${message}`;
  const hasRunDir = runDir && existsSync(runDir);

  // Hoisted so the cancel callback can kill the process
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
        makeResultKillTimer(() => claudeProcess, "run-viewer-chat")
      );

      try {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "spawning",
              mode: "claude",
            })}\n`
          )
        );

        const allowedTools = hasRunDir
          ? READONLY_CODEBASE_TOOLS
          : WEB_ONLY_TOOLS;

        const claudeArgs = [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          `--allowedTools=${allowedTools}`,
        ];

        if (isResuming && history.claudeSessionId) {
          claudeArgs.push("--resume", history.claudeSessionId);
        }

        const claude = spawn("claude", claudeArgs, {
          cwd: hasRunDir ? runDir : homedir(),
          env: {
            ...process.env,
            PATH: shellPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeProcess = claude;

        console.log("[run-viewer-chat] Claude PID:", claude.pid);

        claude.stdin.write(prompt);
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
          console.error("[run-viewer-chat claude stderr]", data.toString());
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
            "[run-viewer-chat] Claude exited:",
            code,
            "len:",
            assistantContent.length
          );

          if (assistantContent.trim() || assistantBlocks.length > 0) {
            const assistantMessage: ChatMessage = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: assistantContent.trim(),
              timestamp: new Date().toISOString(),
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
          console.error("[run-viewer-chat] Claude spawn error:", err);
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
        console.log(
          "[run-viewer-chat] Client cancelled — killing Claude PID:",
          claudeProcess.pid
        );
        try {
          claudeProcess.kill("SIGTERM");
        } catch {}
        claudeProcess = null;
      }
    },
  });
}
