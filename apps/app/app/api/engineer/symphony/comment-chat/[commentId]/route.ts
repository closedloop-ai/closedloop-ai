import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { ENGINEER_CHAT_TOOLS } from "@/lib/engineer/allowed-tools";
import { getCodexChatStatePath } from "@/lib/engineer/codex-state";
import {
  getLearningAttributionInstruction,
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
import { resolveWorktreeForPR } from "@/lib/engineer/worktree";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sender?: "claude" | "codex";
  blocks?: ContentBlock[];
  responded?: boolean;
};

type CommentContext = {
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  replies?: Array<{ author: string; body: string }>;
};

type CommentChatHistory = {
  messages: ChatMessage[];
  ticketId: string;
  repoPath: string;
  commentId: string;
  commentContext: CommentContext;
  sessionId?: string;
  contextPercent?: number | null;
};

const ALLOWED_TOOLS = ENGINEER_CHAT_TOOLS;

/**
 * Get work directory paths for a ticket.
 *
 * When branchName and prNumber are provided (PR comment-chat), resolves the
 * effective working directory via resolveWorktreeForPR (check HEAD, scan
 * existing worktrees, or create a new one). Otherwise falls back to the
 * legacy ticketId-based worktree lookup.
 */
function getWorkPaths(
  ticketId: string,
  repoPath: string,
  commentId: string,
  branchName?: string | null,
  prNumber?: number | null
) {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedCommentId = commentId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const worktreeParentDir = getWorktreeParentDir();

  let effectiveDir: string;

  if (branchName && prNumber) {
    // PR-aware resolution: HEAD check → existing worktree → create new
    effectiveDir = resolveWorktreeForPR(
      expandedRepoPath,
      branchName,
      prNumber,
      worktreeParentDir
    );
  } else {
    // Legacy: ticketId-based worktree lookup
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
    const repoName = basename(expandedRepoPath);
    const worktreeDir = join(
      worktreeParentDir,
      `${repoName}-${sanitizedTicket}`
    );
    effectiveDir = existsSync(worktreeDir) ? worktreeDir : expandedRepoPath;
  }

  const claudeWorkDir = join(effectiveDir, ".claude", "work");
  const commentChatsDir = join(claudeWorkDir, "comment-chats");

  return {
    effectiveDir,
    claudeWorkDir,
    commentChatsDir,
    historyPath: join(commentChatsDir, `${sanitizedCommentId}.json`),
    planPath: join(claudeWorkDir, "plan.json"),
    prdPath: join(claudeWorkDir, "prd.md"),
  };
}

/**
 * Safe wrapper around getWorkPaths that catches worktree resolution failures
 * and returns a structured error Response instead of throwing.
 */
function safeGetWorkPaths(
  ...args: Parameters<typeof getWorkPaths>
): ReturnType<typeof getWorkPaths> | Response {
  try {
    return getWorkPaths(...args);
  } catch (err) {
    return Response.json(
      {
        error: `Worktree resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }
}

/**
 * Load comment chat history
 */
function loadCommentChatHistory(
  historyPath: string,
  ticketId: string,
  repoPath: string,
  commentId: string,
  commentContext?: CommentContext
): CommentChatHistory {
  if (!existsSync(historyPath)) {
    return {
      messages: [],
      ticketId,
      repoPath,
      commentId,
      commentContext: commentContext || { author: "", body: "" },
    };
  }
  try {
    const content = readFileSync(historyPath, "utf-8");
    return JSON.parse(content) as CommentChatHistory;
  } catch {
    return {
      messages: [],
      ticketId,
      repoPath,
      commentId,
      commentContext: commentContext || { author: "", body: "" },
    };
  }
}

/**
 * Save comment chat history
 */
function saveCommentChatHistory(
  historyPath: string,
  history: CommentChatHistory
): void {
  const dir = join(historyPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Build system context prompt for PR comment
 */
function buildContextPrompt(
  paths: ReturnType<typeof getWorkPaths>,
  commentContext: CommentContext
): string {
  const parts: string[] = [];

  // --- Role + environment ---
  parts.push(
    `You are a senior engineer helping a teammate address a PR review comment from @${commentContext.author}.`,
    "Your job: investigate thoroughly, then propose ONE clear action. The human decides what ships — you never apply changes unilaterally.",
    `\nWork directory: ${paths.claudeWorkDir}`,
    `Worktree directory: ${paths.effectiveDir}`
  );

  // --- PR comment + thread + project context ---
  appendCommentContext(parts, commentContext);
  appendProjectContext(parts, paths);

  // --- Workflow + examples + format + constraints (static) ---
  parts.push(WORKFLOW_PROMPT);

  // --- Suggested action buttons ---
  parts.push(
    "\n## ACTION BUTTONS",
    "Include suggested action buttons at the END of your message when there are logical next steps. Format:",
    "<suggested-actions>",
    `<action label="Short Label">Message to send when clicked</action>`,
    "</suggested-actions>",
    "",
    "**Include actions when:**",
    "- You proposed a diff and the user might want to apply it or request changes",
    "- You composed a <pr_response> and the user might want to send it or edit it",
    `- You want to offer follow-up investigation (e.g., "Check related tests", "Look at callers")`,
    "",
    "**Skip actions when:**",
    `- You're just answering a clarifying question with no follow-up needed`,
    "",
    `**Guidelines:** 1-3 actions max, short labels (2-4 words), think "what does the user likely want to do next?"`,
    "",
    "**IMPORTANT — typed actions for special UI behaviors:**",
    `- Apply/accept changes: use type="accept-changes". The message should instruct the assistant to also provide a <pr_response> afterward.`,
    `  <action label="Apply changes" type="accept-changes">Proceed with the proposed changes. After applying, provide a <pr_response> acknowledging the fix so I can reply to the reviewer.</action>`,
    `- Send PR response: use type="send-response". The UI will extract the <pr_response> content and post it as a GitHub comment.`,
    `  <action label="Send response" type="send-response">Send the draft response to the reviewer.</action>`
  );

  // --- Dynamic suffixes: org learnings + learning capture ---
  const orgPatterns = getOrgPatternsContext();
  if (orgPatterns) {
    parts.push(`\n${orgPatterns}`, `\n${getLearningAttributionInstruction()}`);
  }
  parts.push(
    `\n${getLearningCaptureInstruction(paths.claudeWorkDir, "comments")}`
  );

  return parts.join("\n");
}

function appendCommentContext(parts: string[], ctx: CommentContext): void {
  const commentLines = ["\n## PR Comment to Address"];
  if (ctx.path) {
    const loc = ctx.line ? `:${ctx.line}` : "";
    commentLines.push(`**File:** \`${ctx.path}${loc}\``);
  }
  commentLines.push(`\n> ${ctx.body.split("\n").join("\n> ")}`);
  if (ctx.replies && ctx.replies.length > 0) {
    commentLines.push(`\n### Thread (${ctx.replies.length} replies)`);
    for (const r of ctx.replies) {
      commentLines.push(`> **@${r.author}:** ${r.body}`);
    }
  }
  parts.push(...commentLines);
}

const WORKFLOW_PROMPT = `
## Workflow

### 1. Investigate
Read the file at the flagged location. Don't stop at one line — read enough context to understand the function, component, or module it belongs to.
- Grep for callers, consumers, and related types
- Check for tests that exercise this code path
- If the reviewer cites a specific concern (race condition, perf, type safety, etc.), verify it against the actual code — don't take the claim at face value

### 2. Classify the comment
Before responding, determine which category applies:
- **Bug / correctness** — the code is wrong or will break. Fix required.
- **Design / architecture** — the code works but the approach is questionable. Propose an alternative or explain the tradeoff.
- **Style / nitpick** — naming, formatting, minor preference. Respond concisely.
- **Question / clarification** — the reviewer is asking "why?", not requesting a change. Answer with evidence from the code.
- **Invalid / misunderstanding** — the reviewer misread the code. Respectfully correct with evidence.

State the category and your reasoning in 1-2 sentences before proposing anything.

### 3. Assess impact
Briefly state:
1. What the reviewer is asking for (in your own words)
2. Whether the concern is valid — cite specific code you read as evidence
3. What else depends on this code (callers, tests, sibling logic) and whether your fix affects them

### 4. Respond — exactly ONE of these two paths:

**Path A — Code changes needed:**
Show proposed changes in \`\`\`diff fenced blocks. The UI detects these to surface an "Accept Changes" button.
- Do NOT use Edit or Write tools — only Read files and show diffs
- Do NOT include a <pr_response> tag in the same message as diff blocks
- Include the file path as the diff header: \`\`\`diff /path/to/file.ts

**Path B — No code changes needed:**
Explain why with code evidence, then wrap a suggested reviewer reply in <pr_response>...</pr_response> tags. The UI detects this to surface a "Send Response" button.

## Examples

### Example A: Code change needed
\`\`\`
**Category:** Bug — the null check is missing and will throw at runtime.

The reviewer is right. \`user.settings\` can be \`undefined\` when the account
was created via SSO (confirmed by checking \`createSSOUser()\` at auth.ts:84
which skips the settings initialization step).

Two callers: \`ProfilePage\` and \`SettingsAPI\`. Both pass through this path.

\`\`\`diff /src/utils/user.ts
- const theme = user.settings.theme;
+ const theme = user.settings?.theme ?? "light";
\`\`\`
\`\`\`

### Example B: No change needed — push back
\`\`\`
**Category:** Invalid — the reviewer misread the control flow.

This looks like a race condition at first glance, but \`mutex.acquire()\`
at line 42 guarantees exclusive access. The lock is released in the
\`finally\` block at line 58. I confirmed no other code path bypasses
the lock by grepping for direct calls to \`updateBalance\`.

<pr_response>
Good catch on the concurrency concern! This is actually safe — the \`mutex.acquire()\` call at line 42 serializes access, and the lock is always released in the \`finally\` block. No other caller bypasses the lock.
</pr_response>
\`\`\`

## Output format (critical — the UI parses these)
- Code proposals MUST use \`\`\`diff blocks (not \`\`\`typescript, \`\`\`tsx, etc.). This triggers the "Accept Changes" button.
- Reviewer replies MUST use <pr_response>...</pr_response> tags. This triggers the "Send Response" button.
- Never combine both in one message — the UI handles one action at a time.
- Every response must lead to exactly one of these two actions.

## Constraints
- **Propose, don't apply.** Never use Edit or Write tools unless the human explicitly approves. Present diffs and rationale, then wait.
- **Stay scoped.** Fix only what the reviewer asked about — no surrounding refactors, no unrelated improvements, no drive-by cleanups.
- **Simplest correct fix wins.** Don't over-engineer. If a one-line change addresses the concern, prefer it over a refactor.
- **When the reviewer is wrong, say so respectfully.** Back it up with evidence from the code. Don't make unnecessary changes just to appease.
- **When the comment is ambiguous, investigate first.** Read the code to determine the most likely intent before asking for clarification. If you still can't tell after investigation, state your best interpretation and ask the human to confirm.

## Conferral with Codex
If a specific sub-question would benefit from Codex's perspective (e.g., verifying types, checking build tool behavior, getting a second opinion on an algorithm), you may confer by including this on its own line near the end of your response (before any action buttons):

@codex [your specific question here]

Rules:
- Give your own analysis first — never defer your entire answer
- Use sparingly — only when Codex adds distinct value
- One focused question per conferral
- Place on its own line near the end, before <suggested-actions>`;

/**
 * Append plan and PRD context to the prompt if available in the work directory.
 */
function appendProjectContext(
  parts: string[],
  paths: ReturnType<typeof getWorkPaths>
): void {
  const prd = readFileSafe(paths.prdPath);
  if (prd) {
    const summary = prd.substring(0, 2000);
    parts.push(
      `\n## PRD (feature context):\n${summary}${prd.length > 2000 ? "\n...(truncated)" : ""}`
    );
  }

  const planText = readPlanContent(paths.planPath);
  if (planText) {
    const limit = prd ? 1500 : 3000;
    const summary = planText.substring(0, limit);
    parts.push(
      `\n## Implementation Plan (summary):\n${summary}${planText.length > limit ? "\n...(truncated)" : ""}`
    );
  }
}

function readFileSafe(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function readPlanContent(planPath: string): string | null {
  const raw = readFileSafe(planPath);
  if (!raw) {
    return null;
  }
  try {
    const plan = JSON.parse(raw);
    return plan.content || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/symphony/comment-chat/[commentId]?ticketId=...&repo=...
 *
 * Returns the chat history for a specific PR comment
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  const { commentId } = await params;
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

  const branch = searchParams.get("branch");
  const prNum = searchParams.get("prNumber");
  const paths = safeGetWorkPaths(
    ticketId,
    repoPath,
    commentId,
    branch,
    prNum ? Number(prNum) : null
  );
  if (paths instanceof Response) {
    return paths;
  }
  const history = loadCommentChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    commentId
  );

  return Response.json(history);
}

/**
 * POST /api/engineer/symphony/comment-chat/[commentId]?ticketId=...&repo=...
 *
 * Sends a message to Claude for addressing a PR comment and streams the response.
 * Body: { message: string, commentContext?: CommentContext }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  const { commentId } = await params;
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
  const { message, displayContent, commentContext, branchName, prNumber } =
    body as {
      message: string;
      displayContent?: string;
      commentContext?: CommentContext;
      branchName?: string;
      prNumber?: number;
    };

  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const paths = safeGetWorkPaths(
    ticketId,
    repoPath,
    commentId,
    branchName,
    prNumber
  );
  if (paths instanceof Response) {
    return paths;
  }

  // Check if effective directory exists
  if (!existsSync(paths.effectiveDir)) {
    return new Response(JSON.stringify({ error: "Work directory not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Load and update chat history with user message
  const history = loadCommentChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    commentId,
    commentContext
  );

  // Update comment context if provided
  if (commentContext) {
    history.commentContext = commentContext;
  }

  // Store the display content (with <context> block) if provided, otherwise extract
  // user guidance from the full message (which contains the full context prompt for Claude)
  const userInput = displayContent ?? message;

  const userMessage: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userInput,
    timestamp: new Date().toISOString(),
  };
  history.messages.push(userMessage);
  saveCommentChatHistory(paths.historyPath, history);

  // Determine if we're resuming or starting new
  const isResuming = !!history.sessionId;
  const prompt = isResuming
    ? message
    : `${buildContextPrompt(paths, history.commentContext)}\n\n---\n\n${message}`;

  // Create streaming response
  const encoder = new TextEncoder();

  // Hoisted so the cancel callback can kill the process
  let claudeProcess: ReturnType<typeof spawn> | null = null;
  let streamStateRef: ReturnType<typeof createStreamState> | null = null;

  const shellPath = await getShellPath();
  const stream = new ReadableStream({
    start(controller) {
      const streamState = createStreamState(
        (sessionId) => {
          // Eagerly persist session ID so we can resume if Claude gets killed
          if (!history.sessionId) {
            history.sessionId = sessionId;
            saveCommentChatHistory(paths.historyPath, history);
            console.log(
              "[Comment Chat API] Persisted session ID early:",
              sessionId
            );
          }
        },
        makeResultKillTimer(() => claudeProcess, "Comment Chat API")
      );
      streamStateRef = streamState;

      try {
        console.log("[Comment Chat API] Spawning Claude...");
        console.log("[Comment Chat API] CWD:", paths.effectiveDir);
        console.log("[Comment Chat API] Comment ID:", commentId);

        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "status",
              status: "spawning",
              resuming: isResuming,
            })}\n`
          )
        );

        // Let the client know which directory Claude will operate in
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "worktree_resolved",
              effectiveDir: paths.effectiveDir,
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
          cwd: paths.effectiveDir,
          env: {
            ...process.env,
            CLOSEDLOOP_WORKDIR: paths.claudeWorkDir,
            PATH: shellPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        claudeProcess = claude;

        console.log("[Comment Chat API] Claude PID:", claude.pid);

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
            // Client disconnected (tab switch, navigation, etc.)
            clientDisconnected = true;
          }
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
          console.error("[Comment Chat stderr]", text);
          enqueue(JSON.stringify({ type: "error", error: text }));
        });

        claude.on("close", (code) => {
          claudeProcess = null;
          stdoutBuffer = flushCommentStdoutBuffer(
            stdoutBuffer,
            streamState,
            enqueue
          );

          console.log("[Comment Chat API] Claude exited with code:", code);
          console.log(
            "[Comment Chat API] Content length:",
            streamState.assistantContent.length
          );
          console.log(
            "[Comment Chat API] Session ID:",
            streamState.capturedSessionId || "none"
          );
          console.log(
            "[Comment Chat API] Client disconnected:",
            clientDisconnected
          );

          appendCommentMessageToHistory(history, streamState);
          saveCommentChatHistory(paths.historyPath, history);

          if (streamState.usedEditTools && ticketId) {
            enqueue(JSON.stringify({ type: "learnings", status: "triggered" }));
            triggerAsyncLearningExtraction({
              symphonyWorkDir: paths.claudeWorkDir,
              worktreeDir: paths.effectiveDir,
              chatHistoryPath: paths.historyPath,
              activeTab: "comments",
              ticketId,
            });
          }

          enqueue(JSON.stringify({ type: "done", exitCode: code }));
          try {
            controller.close();
          } catch {
            // Stream already closed (client disconnected)
          }
        });

        claude.on("error", (err) => {
          claudeProcess = null;
          console.error("[Comment Chat API] Claude spawn error:", err);
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
          "[Comment Chat API] Client cancelled — killing Claude PID:",
          claudeProcess.pid
        );
        try {
          claudeProcess.kill("SIGTERM");
        } catch {}

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
          saveCommentChatHistory(paths.historyPath, history);
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

/**
 * DELETE /api/symphony/comment-chat/[commentId]?ticketId=...&repo=...&index=...
 *
 * Deletes a specific message from the chat history by index
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  const { commentId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const ticketId = searchParams.get("ticketId");
  const repoPath = searchParams.get("repo");
  const indexStr = searchParams.get("index");

  if (!(ticketId && repoPath)) {
    return new Response(
      JSON.stringify({ error: "ticketId and repo parameters are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const branch = searchParams.get("branch");
  const prNum = searchParams.get("prNumber");
  const paths = safeGetWorkPaths(
    ticketId,
    repoPath,
    commentId,
    branch,
    prNum ? Number(prNum) : null
  );
  if (paths instanceof Response) {
    return paths;
  }
  const history = loadCommentChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    commentId
  );

  if (indexStr === null) {
    // Clear all messages
    history.messages = [];
    history.sessionId = undefined;
    saveCommentChatHistory(paths.historyPath, history);

    // Also delete this comment's Codex session file (scoped cleanup)
    const codexPath = getCodexChatStatePath(
      paths.claudeWorkDir,
      `comment-${commentId}`
    );
    if (existsSync(codexPath)) {
      try {
        unlinkSync(codexPath);
      } catch {
        /* best-effort */
      }
    }
  } else {
    // Delete specific message by index
    const index = Number.parseInt(indexStr, 10);
    if (index >= 0 && index < history.messages.length) {
      history.messages.splice(index, 1);
      saveCommentChatHistory(paths.historyPath, history);
    }
  }

  return Response.json({ success: true });
}

/**
 * PATCH /api/symphony/comment-chat/[commentId]?ticketId=...&repo=...
 *
 * Appends a single message to comment chat history.
 * Used by the debate hook's saveDebateMessage and sendHumanToCodex.
 * Body: { message: ChatMessage }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  const { commentId } = await params;
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

  const branch = searchParams.get("branch");
  const prNum = searchParams.get("prNumber");

  const body = await request.json();
  const { message, markResponded } = body as {
    message?: ChatMessage;
    markResponded?: string;
  };

  const paths = safeGetWorkPaths(
    ticketId,
    repoPath,
    commentId,
    branch,
    prNum ? Number(prNum) : null
  );
  if (paths instanceof Response) {
    return paths;
  }
  const history = loadCommentChatHistory(
    paths.historyPath,
    ticketId,
    repoPath,
    commentId
  );

  // Mark a message as responded (by ID)
  if (markResponded) {
    const target = history.messages.find((m) => m.id === markResponded);
    if (target) {
      target.responded = true;
      saveCommentChatHistory(paths.historyPath, history);
    }
    return Response.json({ success: true });
  }

  // Append a new message
  if (!(message?.id && message.role) || typeof message.content !== "string") {
    return new Response(
      JSON.stringify({
        error: "valid message object or markResponded is required",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  history.messages.push(message);
  saveCommentChatHistory(paths.historyPath, history);

  return Response.json({ success: true });
}

function flushCommentStdoutBuffer(
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

function appendCommentMessageToHistory(
  history: CommentChatHistory,
  streamState: ReturnType<typeof createStreamState>
): void {
  const {
    assistantContent,
    assistantBlocks,
    capturedSessionId,
    contextPercent,
  } = streamState;
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
  }
  if (contextPercent !== null) {
    history.contextPercent = contextPercent;
  }
}
