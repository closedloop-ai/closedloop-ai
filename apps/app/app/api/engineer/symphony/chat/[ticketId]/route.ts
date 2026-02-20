import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import simpleGit from "simple-git";
import {
  getLearningAttributionInstruction,
  getLearningCaptureInstruction,
  getOrgPatternsContext,
  triggerAsyncLearningExtraction,
} from "@/lib/engineer/learnings";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";
import {
  createStreamState,
  makeResultKillTimer,
  processStreamEvent,
} from "@/lib/engineer/stream-events";

type ContentBlock = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
  sender?: "claude" | "codex";
};

type ChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  sessionId?: string; // Claude session ID for --resume
  contextPercent?: number | null; // Context window usage % from last turn
};

// Allowed tools (excluding Playwright)
const ALLOWED_TOOLS = [
  "Bash",
  "Grep",
  "Glob",
  "Read",
  "Edit",
  "Write",
  "Task",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
].join(",");

/**
 * Get work directory paths for a ticket
 */
function getWorkPaths(ticketId: string, repoPath: string) {
  const expandedRepoPath = expandHome(repoPath);

  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  const claudeWorkDir = join(worktreeDir, ".claude", "work");

  return {
    worktreeDir,
    claudeWorkDir,
    historyPath: join(claudeWorkDir, "chat-history.json"),
    planPath: join(claudeWorkDir, "plan.json"),
    prdPath: join(claudeWorkDir, "prd.md"),
  };
}

/**
 * Load chat history
 */
function loadChatHistory(
  historyPath: string,
  ticketId: string,
  repoPath: string
): ChatHistory {
  if (!existsSync(historyPath)) {
    return { messages: [], ticketId, repoPath };
  }
  try {
    const content = readFileSync(historyPath, "utf-8");
    return JSON.parse(content) as ChatHistory;
  } catch {
    return { messages: [], ticketId, repoPath };
  }
}

/**
 * Save chat history
 */
function saveChatHistory(historyPath: string, history: ChatHistory): void {
  const dir = join(historyPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Fetch changed files from the worktree using simple-git.
 * Returns both working (uncommitted) and branch (vs main) changes.
 */
async function getChangedFiles(worktreeDir: string): Promise<{
  working: { modified: string[]; created: string[]; deleted: string[] };
  branch: {
    modified: string[];
    created: string[];
    deleted: string[];
    baseBranch: string;
  } | null;
}> {
  const git = simpleGit(worktreeDir);

  // Working changes (git status)
  const status = await git.status();
  const working = {
    modified: status.modified,
    created: [...status.created, ...status.not_added],
    deleted: status.deleted,
  };

  // Branch changes (vs main/master)
  let branch: {
    modified: string[];
    created: string[];
    deleted: string[];
    baseBranch: string;
  } | null = null;
  try {
    const branches = await git.branch();
    const baseBranch = branches.all.includes("main") ? "main" : "master";
    const diff = await git.diffSummary([`origin/${baseBranch}...HEAD`]);

    const modified: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];

    for (const file of diff.files) {
      if ("binary" in file && file.binary) {
        modified.push(file.file);
      } else if (!("binary" in file && file.binary)) {
        const f = file as {
          file: string;
          insertions: number;
          deletions: number;
        };
        if (f.insertions > 0 && f.deletions === 0) {
          created.push(f.file);
        } else if (f.deletions > 0 && f.insertions === 0) {
          deleted.push(f.file);
        } else {
          modified.push(f.file);
        }
      }
    }

    branch = { modified, created, deleted, baseBranch };
  } catch {
    // Branch diff may fail if no remote tracking
  }

  return { working, branch };
}

/**
 * Format file list for context prompt
 */
function formatFileList(
  label: string,
  files: { modified: string[]; created: string[]; deleted: string[] }
): string {
  const allFiles = [
    ...files.modified.map((f) => `  M ${f}`),
    ...files.created.map((f) => `  A ${f}`),
    ...files.deleted.map((f) => `  D ${f}`),
  ];
  if (allFiles.length === 0) {
    return `${label}: (no changes)`;
  }
  return `${label} (${allFiles.length} files):\n${allFiles.join("\n")}`;
}

function getPlanSummary(planPath: string): string | undefined {
  if (!existsSync(planPath)) {
    return undefined;
  }
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    if (!plan.content) {
      return undefined;
    }
    const summary = plan.content.substring(0, 2000);
    return `\n## Current Implementation Plan (summary):\n${summary}${plan.content.length > 2000 ? "\n...(truncated)" : ""}`;
  } catch {
    return undefined;
  }
}

function buildContextReposSection(repoPaths: string[]): string[] {
  const parts: string[] = [
    "\n## Context Repositories",
    "The user may reference files from these additional repositories using @mentions:",
  ];
  for (const repoPath of repoPaths) {
    parts.push(`- ${basename(repoPath)} → ${expandHome(repoPath)}`);
  }
  parts.push(
    "\nWhen the user mentions a file like `repoName/path/to/file.ts`, you can find it at the absolute path shown above."
  );
  return parts;
}

function buildChangedFilesSection(
  changedFiles: NonNullable<Awaited<ReturnType<typeof getChangedFiles>>>
): string[] {
  const parts: string[] = [
    "\n## Changed Files",
    formatFileList("Working tree changes", changedFiles.working),
  ];
  if (changedFiles.branch) {
    parts.push(
      formatFileList(
        `Branch changes (vs ${changedFiles.branch.baseBranch})`,
        changedFiles.branch
      )
    );
  }
  parts.push(
    "\nThe user is viewing the changed files list. They may ask about specific changes, request code reviews, or want modifications to these files."
  );
  return parts;
}

/**
 * Build the system context prompt (only used for new sessions)
 */
function buildContextPrompt(
  paths: ReturnType<typeof getWorkPaths>,
  changedFiles?: Awaited<ReturnType<typeof getChangedFiles>>,
  activeTab?: string,
  contextRepoPaths?: string[],
  codexReview?: { model: string },
  codexAvailable?: boolean
): string {
  const parts: string[] = [];

  if (codexReview) {
    // Codex review context (model, PRD/bug text) is included in the user
    // message's <context> block — keep the system prompt minimal.
    parts.push(
      "You are assisting with a discussion about an OpenAI Codex code review.",
      `\nWork directory: ${paths.claudeWorkDir}`,
      `Worktree directory: ${paths.worktreeDir}`
    );
  } else {
    parts.push(
      "You are assisting with a Symphony planning session.",
      `\nWork directory: ${paths.claudeWorkDir}`,
      `Worktree directory: ${paths.worktreeDir}`
    );
  }

  // Include context repositories if provided
  if (contextRepoPaths && contextRepoPaths.length > 0) {
    parts.push(...buildContextReposSection(contextRepoPaths));
  }

  parts.push(
    "\n## CHANGE APPROVAL POLICY",
    `**When the user explicitly asks you to make a change** (e.g., "update the plan", "fix this bug", "add this feature"), proceed with the change directly.`,
    "**When you want to proactively suggest or make changes** that the user did not explicitly request:",
    "- You MUST describe what you plan to change and ask for permission first.",
    "- Wait for explicit approval before proceeding.",
    "- Do NOT make unsolicited modifications to files without user consent.",
    "\n## ACTION BUTTONS",
    "Include suggested action buttons at the END of your message when there are logical next steps. Format:",
    "<suggested-actions>",
    `<action label="Short Label">Message to send when clicked</action>`,
    "</suggested-actions>",
    "",
    "**Include actions when:**",
    `- You completed a task that has natural follow-ups (edited files → "Commit changes" or "Push changes"; resolved conflicts → "Push changes"; created something → "Run tests")`,
    `- You're proposing changes that need approval before you proceed`,
    `- You're offering multiple approaches for the user to choose from`,
    "",
    "**Skip actions when:**",
    `- You're just answering a question with no follow-up needed`,
    `- The user said they'll handle the next step`,
    "",
    `**Guidelines:** 1-3 actions max, short labels (2-4 words), think "what does the user likely want to do next?"`
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

  const planSummary = getPlanSummary(paths.planPath);
  if (planSummary) {
    parts.push(planSummary);
  }

  // Mention PRD if exists
  if (existsSync(paths.prdPath)) {
    parts.push(`\nA PRD file exists at: ${paths.prdPath}`);
  }

  if (changedFiles) {
    parts.push(...buildChangedFilesSection(changedFiles));
  }

  parts.push(
    `\nWhen the user's message contains <attached-images> blocks, use the Read tool to view each listed file path. These are images the user pasted into the chat.`,
    "\nThe user can ask questions about the plan, request changes, or ask for clarifications.",
    `If the user asks to modify the plan, read and edit the plan file at: ${paths.planPath}`,
    `The plan content is in the "content" field of plan.json as a markdown string. Use the Edit tool to make targeted changes to the content field.`,
    `IMPORTANT: Whenever you modify plan.json, you MUST also update plan.md (at ${join(paths.claudeWorkDir, "plan.md")}) to keep it in sync. Extract the markdown content from plan.json's "content" field and write it to plan.md so both files always match.`
  );

  // Inject organization learnings if available
  const orgPatterns = getOrgPatternsContext();
  if (orgPatterns) {
    parts.push(`\n${orgPatterns}`, `\n${getLearningAttributionInstruction()}`);
  }

  // Inject learning capture instructions
  parts.push(
    `\n${getLearningCaptureInstruction(paths.claudeWorkDir, activeTab)}`
  );

  return parts.join("\n");
}

/**
 * Build the prompt for a resumed session (just the user message)
 */
function buildResumePrompt(message: string): string {
  return message;
}

/**
 * Build the prompt for a new session (includes context)
 */
async function buildNewSessionPrompt(
  message: string,
  paths: ReturnType<typeof getWorkPaths>,
  activeTab?: string,
  contextRepoPaths?: string[],
  codexReview?: { model: string },
  codexAvailable?: boolean
): Promise<string> {
  let changedFiles: Awaited<ReturnType<typeof getChangedFiles>> | undefined;

  if (activeTab === "changes") {
    try {
      changedFiles = await getChangedFiles(paths.worktreeDir);
    } catch (err) {
      console.error("[Chat API] Failed to get changed files:", err);
    }
  }

  const contextPrompt = buildContextPrompt(
    paths,
    changedFiles,
    activeTab,
    contextRepoPaths,
    codexReview,
    codexAvailable
  );
  return `${contextPrompt}\n\n---\n\nUser: ${message}`;
}

/**
 * POST /api/engineer/symphony/chat/[ticketId]?repo=...
 *
 * Sends a message to Claude and streams the response.
 * Body: { message: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoPath = searchParams.get("repo");

  if (!repoPath) {
    return new Response(
      JSON.stringify({ error: "repo parameter is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const body = await request.json();
  const {
    message,
    displayContent,
    activeTab,
    contextRepoPaths,
    codexReview,
    codexAvailable,
  } = body as {
    message: string;
    displayContent?: string;
    activeTab?: string;
    contextRepoPaths?: string[];
    codexReview?: { model: string };
    codexAvailable?: boolean;
  };

  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const paths = getWorkPaths(ticketId, repoPath);

  // Check if worktree exists
  if (!existsSync(paths.worktreeDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Load chat history and determine session state
  const history = loadChatHistory(paths.historyPath, ticketId, repoPath);
  const isResuming = !!history.sessionId;

  // For the first Codex review message, inject PRD/bug text into the
  // message's <context> block so Claude gets everything in one message.
  let finalMessage = message;
  if (codexReview && !isResuming && existsSync(paths.prdPath)) {
    try {
      const prdContent = readFileSync(paths.prdPath, "utf-8");
      const prdSummary = prdContent.substring(0, 3000);
      const prdBlock = `<context>\n## Ticket / Bug Description\n${prdSummary}${prdContent.length > 3000 ? "\n...(truncated)" : ""}\n</context>\n\n`;
      finalMessage = prdBlock + message;
    } catch {
      // PRD couldn't be read — continue without it
    }
  }

  // Save user message to history (use displayContent for UI when provided)
  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: displayContent ?? finalMessage,
    timestamp: new Date().toISOString(),
  };
  history.messages.push(userMessage);
  saveChatHistory(paths.historyPath, history);

  const prompt = isResuming
    ? buildResumePrompt(finalMessage)
    : await buildNewSessionPrompt(
        finalMessage,
        paths,
        activeTab,
        contextRepoPaths,
        codexReview,
        codexAvailable
      );

  // Create a ReadableStream to stream the response
  const encoder = new TextEncoder();

  // Hoisted so the cancel callback can kill the process
  let claudeProcess: ReturnType<typeof spawn> | null = null;
  let streamStateRef: ReturnType<typeof createStreamState> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const streamState = createStreamState(
        (sessionId) => {
          if (!history.sessionId) {
            history.sessionId = sessionId;
            saveChatHistory(paths.historyPath, history);
            console.log("[Chat API] Persisted session ID early:", sessionId);
          }
        },
        makeResultKillTimer(() => claudeProcess, "Chat API")
      );
      streamStateRef = streamState;

      try {
        console.log("[Chat API] Spawning Claude...");
        console.log("[Chat API] CWD:", paths.worktreeDir);
        console.log(
          "[Chat API] Resuming session:",
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

        // Build Claude arguments
        const claudeArgs = [
          "-p",
          "--model",
          "opus",
          "--verbose",
          "--output-format",
          "stream-json",
          `--allowedTools=${ALLOWED_TOOLS}`,
        ];

        // Add --resume flag if we have an existing session
        if (isResuming && history.sessionId) {
          claudeArgs.push("--resume", history.sessionId);
        }

        // Spawn Claude process
        const claude = spawn("claude", claudeArgs, {
          cwd: paths.worktreeDir,
          env: {
            ...process.env,
            SYMPHONY_WORKDIR: paths.claudeWorkDir,
            PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeProcess = claude;

        console.log("[Chat API] Claude PID:", claude.pid);
        console.log("[Chat API] Claude args:", claudeArgs.join(" "));

        // Write prompt to stdin and close it
        claude.stdin.write(prompt);
        claude.stdin.end();
        console.log("[Chat API] Wrote prompt to stdin, length:", prompt.length);

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
          console.error("[Claude stderr]", text);
          enqueue(JSON.stringify({ type: "error", error: text }));
        });

        claude.on("close", (code) => {
          claudeProcess = null;
          stdoutBuffer = flushChatStdoutBuffer(
            stdoutBuffer,
            streamState,
            enqueue
          );

          console.log("[Chat API] Claude exited with code:", code);
          console.log(
            "[Chat API] Accumulated content length:",
            streamState.assistantContent.length
          );
          console.log(
            "[Chat API] Accumulated blocks:",
            streamState.assistantBlocks.length
          );
          console.log(
            "[Chat API] Session ID:",
            streamState.capturedSessionId || history.sessionId || "none"
          );
          console.log("[Chat API] Client disconnected:", clientDisconnected);

          appendChatMessageToHistory(history, streamState);
          saveChatHistory(paths.historyPath, history);

          if (streamState.usedEditTools) {
            enqueue(JSON.stringify({ type: "learnings", status: "triggered" }));
            triggerAsyncLearningExtraction({
              symphonyWorkDir: paths.claudeWorkDir,
              worktreeDir: paths.worktreeDir,
              chatHistoryPath: paths.historyPath,
              activeTab,
              ticketId,
            });
          }

          enqueue(JSON.stringify({ type: "done", exitCode: code }));
          try {
            controller.close();
          } catch {
            // Stream already closed
          }
        });

        claude.on("error", (err) => {
          claudeProcess = null;
          console.error("[Chat API] Claude spawn error:", err);
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
      // Client aborted the request (stop button pressed)
      if (claudeProcess) {
        console.log(
          "[Chat API] Client cancelled — killing Claude PID:",
          claudeProcess.pid
        );
        claudeProcess.kill("SIGTERM");

        // Save partial response so it's not lost
        if (streamStateRef) {
          const { assistantContent, assistantBlocks, capturedSessionId } =
            streamStateRef;
          if (assistantContent.trim() || assistantBlocks.length > 0) {
            history.messages.push({
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: assistantContent.trim(),
              timestamp: new Date().toISOString(),
              blocks: assistantBlocks.length > 0 ? assistantBlocks : undefined,
            });
          }
          if (capturedSessionId && !history.sessionId) {
            history.sessionId = capturedSessionId;
          }
          saveChatHistory(paths.historyPath, history);
        }
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

function flushChatStdoutBuffer(
  buffer: string,
  streamState: ReturnType<typeof createStreamState>,
  enqueue: (msg: string) => void
): string {
  if (buffer.trim()) {
    try {
      processStreamEvent(JSON.parse(buffer.trim()), streamState, enqueue);
    } catch {
      // Not valid JSON
    }
  }
  return "";
}

function appendChatMessageToHistory(
  history: ChatHistory,
  streamState: ReturnType<typeof createStreamState>
): void {
  const { assistantContent, assistantBlocks, capturedSessionId } = streamState;
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
  if (capturedSessionId && !history.sessionId) {
    history.sessionId = capturedSessionId;
    console.log("[Chat API] Saved session ID to history:", capturedSessionId);
  }
  if (streamState.contextPercent !== null) {
    history.contextPercent = streamState.contextPercent;
  }
}
