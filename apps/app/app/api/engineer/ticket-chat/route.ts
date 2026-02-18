import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import {
  type ContentBlock,
  createStreamState,
  processStreamEvent,
} from "@/lib/engineer/stream-events";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
};

type TicketChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  sessionId?: string; // Claude session ID for --resume
};

type TicketContext = {
  identifier: string;
  title: string;
  description?: string;
  url: string;
};

/**
 * Expand ~ to home directory in paths
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", homedir());
  }
  return path;
}

/**
 * Get chat history directory for a ticket (no worktree required)
 */
function getChatHistoryPath(ticketId: string): string {
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  return join(
    homedir(),
    ".claude",
    ".symphony",
    "chats",
    sanitizedTicket,
    "chat-history.json"
  );
}

/**
 * Load chat history
 */
function loadChatHistory(
  historyPath: string,
  ticketId: string
): TicketChatHistory {
  if (!existsSync(historyPath)) {
    return { messages: [], ticketId };
  }
  try {
    const content = readFileSync(historyPath, "utf-8");
    return JSON.parse(content) as TicketChatHistory;
  } catch {
    return { messages: [], ticketId };
  }
}

/**
 * Save chat history
 */
function saveChatHistory(
  historyPath: string,
  history: TicketChatHistory
): void {
  const dir = join(historyPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Build the system context prompt for ticket questions
 */
function buildTicketContextPrompt(
  ticket: TicketContext,
  repoPath?: string,
  codexAvailable?: boolean
): string {
  const parts: string[] = [];

  parts.push(
    "You are helping a developer understand a Linear ticket before they start implementation.",
    `\n## Ticket: ${ticket.identifier}`,
    `**Title:** ${ticket.title}`,
    `**URL:** ${ticket.url}`
  );

  if (ticket.description) {
    parts.push(`\n**Description:**\n${ticket.description}`);
  }

  parts.push("\n---");

  if (repoPath) {
    parts.push(
      `\nYou have READ-ONLY access to the codebase at ${repoPath}. You can:`,
      "- Read files to understand existing code",
      "- Search for patterns with Grep",
      "- Find files with Glob",
      "\nHelp the user understand this ticket by:"
    );
  } else {
    parts.push("\nHelp the user understand this ticket. You can:");
  }

  parts.push("- Clarifying requirements and scope");
  if (repoPath) {
    parts.push("- Identifying relevant existing code");
  }
  parts.push(
    "- Suggesting implementation approaches",
    "- Pointing out potential edge cases or concerns",
    "- Breaking down the ticket into subtasks",
    "\nBe concise and helpful.",
    // Suggested actions format instructions
    "\n## Suggested Actions Format",
    "When offering the user clear choices or next steps, use this format to create clickable buttons:",
    "```",
    "<suggested-actions>",
    `<action label="Button Text">Message to send when clicked</action>`,
    "</suggested-actions>",
    "```",
    `The label should be short (2-4 words). The message content is what will be sent as the user's next message when they click the button.`,
    `Use this format when presenting options like "Review individually", "Merge all", "Show diff", etc.`
  );

  if (codexAvailable) {
    parts.push(
      "\n## Debating with Codex",
      `When you encounter a questionable claim, uncertain finding, or debatable technical decision, you can initiate a structured debate with Codex (OpenAI's code AI). The purpose is for two LLMs to examine the issue from different angles and converge on the correct answer — not to win an argument.`,
      "Include this action:",
      `<action label="Debate Codex">argue_codex:[brief description of the claim to examine]</action>`,
      "Use this when you want a second opinion or believe something deserves deeper scrutiny from a different perspective."
    );
  }

  return parts.join("\n");
}

/**
 * POST /api/ticket-chat
 *
 * Chat with Claude about a ticket (before planning starts - no worktree required)
 * Body: { ticketId: string, message: string, ticketContext: TicketContext }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticketId, message, ticketContext, repoPath, codexAvailable } =
    body as {
      ticketId: string;
      message: string;
      ticketContext: TicketContext;
      repoPath?: string;
      codexAvailable?: boolean;
    };

  if (!(ticketId && message && ticketContext)) {
    return new Response(
      JSON.stringify({
        error: "ticketId, message, and ticketContext are required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Expand repoPath if provided
  const expandedRepoPath = repoPath ? expandPath(repoPath) : null;

  const historyPath = getChatHistoryPath(ticketId);

  // Load and update chat history with user message
  const history = loadChatHistory(historyPath, ticketId);
  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  };
  history.messages.push(userMessage);
  saveChatHistory(historyPath, history);

  // Determine if we're resuming an existing session or starting new
  const isResuming = !!history.sessionId;
  const contextPrompt = buildTicketContextPrompt(
    ticketContext,
    repoPath,
    codexAvailable
  );
  const prompt = isResuming
    ? message // Just the user message for resumed sessions
    : `${contextPrompt}\n\n---\n\nUser: ${message}`; // Full context for new sessions

  // Create a ReadableStream to stream the response
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const streamState = createStreamState((sessionId) => {
        // Eagerly persist session ID for resume capability
        if (!history.sessionId) {
          history.sessionId = sessionId;
          saveChatHistory(historyPath, history);
          console.log(
            "[Ticket Chat API] Persisted session ID early:",
            sessionId
          );
        }
      });

      try {
        console.log("[Ticket Chat API] Spawning Claude...");
        console.log("[Ticket Chat API] Ticket:", ticketId);
        console.log(
          "[Ticket Chat API] Resuming session:",
          isResuming ? history.sessionId : "new session"
        );

        // Send initial status to client
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "spawning",
              resuming: isResuming,
            })}\n`
          )
        );

        // Build Claude arguments - read-only tools for codebase exploration + web tools
        const allowedTools = expandedRepoPath
          ? "Read,Grep,Glob,WebSearch,WebFetch" // Read-only codebase access + web tools
          : "WebSearch,WebFetch"; // Only web tools when no repo selected

        const claudeArgs = [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          `--allowedTools=${allowedTools}`,
        ];

        // Add --resume flag if we have an existing session
        if (isResuming && history.sessionId) {
          claudeArgs.push("--resume", history.sessionId);
        }

        // Spawn Claude process - use repo path as cwd if provided for codebase access
        const claude = spawn("claude", claudeArgs, {
          cwd: expandedRepoPath || homedir(),
          env: {
            ...process.env,
            PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        console.log("[Ticket Chat API] Claude PID:", claude.pid);

        // Write prompt to stdin and close it
        claude.stdin.write(prompt);
        claude.stdin.end();
        console.log(
          "[Ticket Chat API] Wrote prompt to stdin, length:",
          prompt.length
        );

        // Send confirmation that Claude started
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "running",
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
          // Keep the last partial line in the buffer
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
          console.error("[Claude stderr]", text);
          enqueue(JSON.stringify({ type: "error", error: text }));
        });

        claude.on("close", (code) => {
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

          const { assistantContent, assistantBlocks, capturedSessionId } =
            streamState;
          console.log("[Ticket Chat API] Claude exited with code:", code);
          console.log(
            "[Ticket Chat API] Accumulated content length:",
            assistantContent.length
          );

          // Save assistant response with blocks to history
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

          // Save session ID if we captured one (for new sessions)
          if (capturedSessionId && !history.sessionId) {
            history.sessionId = capturedSessionId;
            console.log(
              "[Ticket Chat API] Saved session ID to history:",
              capturedSessionId
            );
          }

          saveChatHistory(historyPath, history);

          enqueue(JSON.stringify({ type: "done", exitCode: code }));
          controller.close();
        });

        claude.on("error", (err) => {
          console.error("[Ticket Chat API] Claude spawn error:", err);
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
 * GET /api/ticket-chat?ticketId=...
 *
 * Retrieve chat history for a ticket
 */
export function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");

  if (!ticketId) {
    return new Response(
      JSON.stringify({ error: "ticketId parameter is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const historyPath = getChatHistoryPath(ticketId);
  const history = loadChatHistory(historyPath, ticketId);

  return Response.json(history);
}

/**
 * DELETE /api/ticket-chat?ticketId=...
 *
 * Clear chat history for a ticket
 */
export function DELETE(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");

  if (!ticketId) {
    return new Response(
      JSON.stringify({ error: "ticketId parameter is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const historyPath = getChatHistoryPath(ticketId);

  // Reset to empty history (removes session ID too for fresh start)
  saveChatHistory(historyPath, { messages: [], ticketId });

  return Response.json({ success: true });
}
