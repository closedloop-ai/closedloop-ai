import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { ENGINEER_CHAT_TOOLS } from "@/lib/engineer/allowed-tools";
import {
  getLearningCaptureInstruction,
  getOrgPatternsContext,
  triggerAsyncLearningExtraction,
} from "@/lib/engineer/learnings";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";
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

type FindingContext = {
  severity: string;
  priority?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
};

type FindingChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  findingId: string;
  findingContext?: FindingContext;
  sessionId?: string;
  contextPercent?: number | null;
};

const ALLOWED_TOOLS = ENGINEER_CHAT_TOOLS;

/**
 * Get work directory paths for a finding chat.
 *
 * claudeWorkDir always points to .closedloop-ai/work (canonical write target).
 * historyPath resolves per-file: if the legacy path exists but the new path
 * does not, the file is migrated so writes append to the existing transcript.
 */
function getWorkPaths(ticketId: string, repoPath: string, findingId: string) {
  const expandedRepoPath = expandHome(repoPath);

  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const sanitizedFindingId = findingId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  const claudeWorkDir = join(worktreeDir, ".closedloop-ai", "work");
  const findingChatsDir = join(claudeWorkDir, "finding-chats");

  const historyFilename = `${sanitizedFindingId}.json`;

  return {
    worktreeDir,
    claudeWorkDir,
    findingChatsDir,
    historyPath: join(findingChatsDir, historyFilename),
    planPath: join(claudeWorkDir, "plan.json"),
    prdPath: join(claudeWorkDir, "prd.md"),
  };
}

/**
 * Load finding chat history
 */
function loadFindingChatHistory(
  historyPath: string,
  ticketId: string,
  repoPath: string,
  findingId: string,
  findingContext?: FindingContext
): FindingChatHistory {
  if (!existsSync(historyPath)) {
    return {
      messages: [],
      ticketId,
      repoPath,
      findingId,
      findingContext,
    };
  }
  try {
    const content = readFileSync(historyPath, "utf-8");
    return JSON.parse(content) as FindingChatHistory;
  } catch {
    return {
      messages: [],
      ticketId,
      repoPath,
      findingId,
      findingContext,
    };
  }
}

/**
 * Save finding chat history
 */
function saveFindingChatHistory(
  historyPath: string,
  history: FindingChatHistory
): void {
  const dir = join(historyPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Build system context prompt for a specific finding
 */
function buildContextPrompt(
  paths: ReturnType<typeof getWorkPaths>,
  findingContext: FindingContext
): string {
  const parts: string[] = [];

  parts.push(
    "You are an advisory assistant helping a developer analyze a code review finding from OpenAI Codex. Your role is to investigate, analyze, and **propose** — the human always decides what gets applied.",
    `\nWork directory: ${paths.claudeWorkDir}`,
    `Worktree directory: ${paths.worktreeDir}`
  );

  // Include the finding being discussed
  parts.push("\n## Code Review Finding:");
  parts.push(`- **Severity:** ${findingContext.severity.toUpperCase()}`);
  if (findingContext.priority) {
    parts.push(`- **Priority:** ${findingContext.priority}`);
  }
  if (findingContext.file) {
    const loc = findingContext.line
      ? `${findingContext.file}:${findingContext.line}`
      : findingContext.file;
    parts.push(`- **Location:** \`${loc}\``);
  }
  parts.push(`- **Message:** ${findingContext.message}`);
  if (findingContext.suggestion) {
    parts.push(`- **Suggestion:** ${findingContext.suggestion}`);
  }

  // Include plan summary if it exists
  if (existsSync(paths.planPath)) {
    try {
      const planContent = readFileSync(paths.planPath, "utf-8");
      const plan = JSON.parse(planContent);
      if (plan.content) {
        const summary = plan.content.substring(0, 1500);
        parts.push(
          `\n## Implementation Plan (summary):\n${summary}${plan.content.length > 1500 ? "\n...(truncated)" : ""}`
        );
      }
    } catch {
      // Plan file exists but couldn't be read
    }
  }

  parts.push(
    "\n## Your Task:",
    "Read the referenced source files and assess whether this finding is valid or a false positive.",
    "If the issue is valid, propose a concrete fix with code examples — but do not apply changes until the human approves via a suggested action.",
    "If the reviewer is mistaken, explain why clearly.",
    "",
    "After your analysis, include suggested action buttons using the <suggested-actions> format. Choose actions based on your verdict:",
    "",
    "**If the finding is VALID (you agree with Codex):** offer actions like:",
    "<suggested-actions>",
    `<action label="Apply Fix">Apply the suggested fix for this finding</action>`,
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>",
    "",
    "**If the finding is INVALID or you're UNCERTAIN:** offer the debate action so the user can get a second opinion from Codex:",
    "<suggested-actions>",
    `<action label="Debate Codex">argue_codex:${findingContext.message.split("\n")[0].slice(0, 80)}</action>`,
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>",
    "",
    `The "argue_codex:" prefix signals the UI to initiate a structured debate with Codex. Only include it when you disagree with or are uncertain about the finding.`,
    "",
    '**After applying code changes** (e.g. the user clicked "Apply Fix" and you made edits), always offer a "Dismiss Finding" action so the user can close the resolved finding:',
    "<suggested-actions>",
    `<action label="Dismiss Finding">/dismiss</action>`,
    "</suggested-actions>"
  );

  // Inject organization learnings if available
  const orgPatterns = getOrgPatternsContext();
  if (orgPatterns) {
    parts.push(`\n${orgPatterns}`);
  }

  // Inject learning capture instructions
  parts.push(
    `\n${getLearningCaptureInstruction(paths.claudeWorkDir, "code-review")}`
  );

  return parts.join("\n");
}

/**
 * GET /api/codex/finding-chat/[findingId]?ticketId=...&repo=...
 *
 * Returns the chat history for a specific finding
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  const { findingId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo parameters are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const paths = getWorkPaths(ticketId, repoPath, findingId);
  const history = loadFindingChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    findingId
  );

  return Response.json(history);
}

/**
 * POST /api/engineer/codex/finding-chat/[findingId]?ticketId=...&repo=...
 *
 * Sends a message to Claude for discussing a specific finding and streams the response.
 * Body: { message: string, findingContext?: FindingContext }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  const { findingId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo parameters are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const body = await request.json();
  const { message, findingContext, displayMessage } = body as {
    message: string;
    findingContext?: FindingContext;
    displayMessage?: string;
  };

  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const paths = getWorkPaths(ticketId, repoPath, findingId);

  // Check if worktree exists
  if (!existsSync(paths.worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Load chat history (don't save user message yet -- defer until after Claude responds
  // to avoid race with the GET query on the client)
  const history = loadFindingChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    findingId,
    findingContext
  );

  // Update finding context if provided
  if (findingContext) {
    history.findingContext = findingContext;
  }

  // Save the display-friendly message (not the full context prompt)
  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: displayMessage || message,
    timestamp: new Date().toISOString(),
  };

  // Determine if we're resuming or starting new
  const isResuming = !!history.sessionId;
  const defaultContext = history.findingContext || {
    severity: "info",
    message: "Unknown finding",
  };
  const prompt = isResuming
    ? message
    : `${buildContextPrompt(paths, defaultContext)}\n\n---\n\n${message}`;

  // Create streaming response
  const encoder = new TextEncoder();

  // Hoisted so the cancel callback can kill the process
  let claudeProcess: ReturnType<typeof spawn> | null = null;

  const shellPath = await getShellPath();
  const stream = new ReadableStream({
    start(controller) {
      const streamState = createStreamState(
        (sessionId) => {
          // Eagerly persist session ID so we can resume if Claude gets killed
          if (!history.sessionId) {
            history.sessionId = sessionId;
            saveFindingChatHistory(paths.historyPath, history);
            console.log(
              "[Finding Chat API] Persisted session ID early:",
              sessionId
            );
          }
        },
        makeResultKillTimer(() => claudeProcess, "Finding Chat API")
      );

      try {
        console.log("[Finding Chat API] Spawning Claude...");
        console.log("[Finding Chat API] CWD:", paths.worktreeDir);
        console.log("[Finding Chat API] Finding ID:", findingId);

        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "spawning",
              resuming: isResuming,
            })}\n`
          )
        );

        const claudeArgs = [
          "-p",
          "--model",
          "opus",
          "--verbose",
          "--output-format",
          "stream-json",
          `--allowedTools=${ALLOWED_TOOLS}`,
        ];

        if (isResuming && history.sessionId) {
          claudeArgs.push("--resume", history.sessionId);
        }

        const claude = spawn("claude", claudeArgs, {
          cwd: paths.worktreeDir,
          env: {
            ...process.env,
            CLOSEDLOOP_WORKDIR: paths.claudeWorkDir,
            PATH: shellPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeProcess = claude;

        console.log("[Finding Chat API] Claude PID:", claude.pid);

        claude.stdin.write(prompt);
        claude.stdin.end();

        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "running",
              pid: claude.pid,
            })}\n`
          )
        );

        let clientDisconnected = false;
        const enqueue = (msg: string) => {
          if (clientDisconnected) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(`${msg}\n`));
          } catch {
            clientDisconnected = true;
          }
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
              // Not valid JSON — skip
            }
          }
        });

        claude.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          console.error("[Finding Chat stderr]", text);
          enqueue(JSON.stringify({ type: "error", error: text }));
        });

        claude.on("close", (code) => {
          claudeProcess = null;
          // Flush any remaining buffered stdout
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

          const {
            assistantContent,
            assistantBlocks,
            capturedSessionId,
            usedEditTools,
          } = streamState;
          console.log("[Finding Chat API] Claude exited with code:", code);
          console.log(
            "[Finding Chat API] Content length:",
            assistantContent.length
          );
          console.log(
            "[Finding Chat API] Session ID:",
            capturedSessionId || "none"
          );
          console.log(
            "[Finding Chat API] Client disconnected:",
            clientDisconnected
          );

          // Save user message now (deferred to avoid race with GET query on client)
          history.messages.push(userMessage);
          appendAssistantMessageToHistory(
            history,
            assistantContent,
            assistantBlocks
          );

          if (capturedSessionId && !history.sessionId) {
            history.sessionId = capturedSessionId;
          }
          if (streamState.contextPercent !== null) {
            history.contextPercent = streamState.contextPercent;
          }

          saveFindingChatHistory(paths.historyPath, history);
          maybeTriggerLearningExtraction(
            usedEditTools,
            ticketId,
            paths,
            enqueue
          );

          enqueue(JSON.stringify({ type: "done", exitCode: code }));
          try {
            controller.close();
          } catch {
            // Stream already closed (client disconnected)
          }
        });

        claude.on("error", (err) => {
          claudeProcess = null;
          console.error("[Finding Chat API] Claude spawn error:", err);
          enqueue(
            JSON.stringify({
              type: "error",
              error: `Failed to start Claude: ${err.message}`,
            })
          );
          try {
            controller.close();
          } catch {
            // Stream already closed
          }
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
          "[Finding Chat API] Client cancelled — killing Claude PID:",
          claudeProcess.pid
        );
        try {
          claudeProcess.kill("SIGTERM");
        } catch {}
        claudeProcess = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * PATCH /api/codex/finding-chat/[findingId]?ticketId=...&repo=...
 *
 * Appends a message to the finding chat history without spawning Claude.
 * Used by the debate hook to save debate messages to a finding's conversation.
 * Body: { message: ChatMessage }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  const { findingId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo parameters are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const body = await request.json();
  const { message } = body as { message: ChatMessage };

  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const paths = getWorkPaths(ticketId, repoPath, findingId);
  const history = loadFindingChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    findingId
  );
  history.messages.push(message);
  saveFindingChatHistory(paths.historyPath, history);

  return Response.json({ success: true });
}

/**
 * DELETE /api/codex/finding-chat/[findingId]?ticketId=...&repo=...
 *
 * Clears the chat history for a specific finding
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  const { findingId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo parameters are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const paths = getWorkPaths(ticketId, repoPath, findingId);
  const history = loadFindingChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    findingId
  );

  // Clear all messages and session
  history.messages = [];
  history.sessionId = undefined;
  saveFindingChatHistory(paths.historyPath, history);

  return Response.json({ success: true });
}

function appendAssistantMessageToHistory(
  history: FindingChatHistory,
  assistantContent: string,
  assistantBlocks: ContentBlock[]
): void {
  if (!assistantContent.trim() && assistantBlocks.length === 0) {
    return;
  }
  history.messages.push({
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: assistantContent.trim(),
    timestamp: new Date().toISOString(),
    blocks: assistantBlocks.length > 0 ? assistantBlocks : undefined,
  });
}

function maybeTriggerLearningExtraction(
  usedEditTools: boolean,
  ticketId: string | null | undefined,
  paths: ReturnType<typeof getWorkPaths>,
  enqueue: (msg: string) => void
): void {
  if (!(usedEditTools && ticketId)) {
    return;
  }
  enqueue(JSON.stringify({ type: "learnings", status: "triggered" }));
  triggerAsyncLearningExtraction({
    symphonyWorkDir: paths.claudeWorkDir,
    worktreeDir: paths.worktreeDir,
    chatHistoryPath: paths.historyPath,
    activeTab: "code-review",
    ticketId,
  });
}
