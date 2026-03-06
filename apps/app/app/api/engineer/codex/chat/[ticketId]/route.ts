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
import simpleGit from "simple-git";
import {
  DEFAULT_CODEX_MODEL,
  MODEL_ERROR_REGEX,
} from "@/lib/engineer/codex-models";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";
import { resolveWorktreeForPR } from "@/lib/engineer/worktree";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ChatHistoryMessage = {
  role: string;
  content: string;
  sender?: "claude" | "codex";
};

type CommentContext = {
  author: string;
  body: string;
  path?: string;
  line?: number;
};

type ChatRequest = {
  prompt: string;
  chatHistory?: ChatHistoryMessage[];
  repoPath: string;
  branchName?: string;
  prNumber?: number;
  activeTab?: string;
  contextRepoPaths?: string[];
  commentContext?: CommentContext;
  model?: string;
};

type CodexChatState = {
  sessionId?: string;
  messageCount: number;
};

function getWorktreeDir(
  repoPath: string,
  ticketId: string,
  branchName?: string,
  prNumber?: number
): string {
  const expandedRepoPath = expandHome(repoPath);
  const worktreeParentDir = getWorktreeParentDir();

  if (branchName && prNumber) {
    // PR-aware resolution: base repo HEAD check → existing worktree → create
    return resolveWorktreeForPR(
      expandedRepoPath,
      branchName,
      prNumber,
      worktreeParentDir
    );
  }

  // Legacy: ticketId-based worktree lookup, fall back to base repo
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeDir = join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
  return existsSync(worktreeDir) ? worktreeDir : expandedRepoPath;
}

function getWorkPaths(worktreeDir: string) {
  const claudeWorkDir = join(worktreeDir, ".claude", "work");
  return {
    worktreeDir,
    claudeWorkDir,
    planPath: join(claudeWorkDir, "plan.json"),
    prdPath: join(claudeWorkDir, "prd.md"),
    chatStatePath: join(claudeWorkDir, "codex-chat.json"),
  };
}

function loadChatState(statePath: string): CodexChatState {
  if (!existsSync(statePath)) {
    return { messageCount: 0 };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as CodexChatState;
  } catch {
    return { messageCount: 0 };
  }
}

function saveChatState(statePath: string, state: CodexChatState): void {
  const dir = join(statePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Fetch changed files from the worktree using simple-git.
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

  const status = await git.status();
  const working = {
    modified: status.modified,
    created: [...status.created, ...status.not_added],
    deleted: status.deleted,
  };

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
      } else {
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

function appendContextRepos(
  parts: string[],
  contextRepoPaths?: string[]
): void {
  if (!contextRepoPaths || contextRepoPaths.length === 0) {
    return;
  }
  parts.push(
    "\n## Context Repositories",
    "The user may reference files from these additional repositories:"
  );
  for (const rp of contextRepoPaths) {
    parts.push(`- ${basename(rp)} → ${expandHome(rp)}`);
  }
}

function appendPlanSummary(
  parts: string[],
  paths: ReturnType<typeof getWorkPaths>
): void {
  if (!existsSync(paths.planPath)) {
    return;
  }
  try {
    const plan = JSON.parse(readFileSync(paths.planPath, "utf-8"));
    if (!plan.content) {
      return;
    }
    const summary = plan.content.substring(0, 2000);
    parts.push(
      `\n## Current Implementation Plan (summary):\n${summary}${plan.content.length > 2000 ? "\n...(truncated)" : ""}`
    );
  } catch {
    // Plan file exists but couldn't be read
  }
}

function appendPrdSummary(
  parts: string[],
  paths: ReturnType<typeof getWorkPaths>
): void {
  if (!existsSync(paths.prdPath)) {
    return;
  }
  try {
    const prdContent = readFileSync(paths.prdPath, "utf-8");
    const prdSummary = prdContent.substring(0, 2000);
    parts.push(
      `\n## Ticket / PRD (summary):\n${prdSummary}${prdContent.length > 2000 ? "\n...(truncated)" : ""}`
    );
  } catch {
    // PRD couldn't be read
  }
}

function appendReviewOutput(
  parts: string[],
  paths: ReturnType<typeof getWorkPaths>
): void {
  // Include previous review output so Codex has context on its own review
  const logPath = join(paths.claudeWorkDir, "codex-review-codex.log");
  if (!existsSync(logPath)) {
    return;
  }
  try {
    const output = readFileSync(logPath, "utf-8").trim();
    if (!output) {
      return;
    }
    parts.push(
      "\n## Your Previous Code Review",
      "You previously reviewed this PR. Here is your review output — use it as context when answering follow-up questions:",
      "```",
      output.slice(-8000),
      "```"
    );
  } catch {
    // Review log couldn't be read
  }
}

function appendChatHistory(
  parts: string[],
  chatHistory?: ChatHistoryMessage[]
): void {
  if (!chatHistory || chatHistory.length === 0) {
    return;
  }
  parts.push(
    "\n## Recent Conversation Context",
    "This is the shared chat history (includes messages from Claude and the user):"
  );
  for (const msg of chatHistory.slice(-10)) {
    if (msg.role === "user") {
      parts.push(`<human>${msg.content}</human>`);
    } else if (msg.sender === "codex") {
      parts.push(`<codex>${msg.content}</codex>`);
    } else {
      parts.push(`<claude>${msg.content}</claude>`);
    }
  }
}

/**
 * Build a rich context prompt for Codex, mirroring what Claude receives.
 */
function buildCodexPrompt(
  prompt: string,
  paths: ReturnType<typeof getWorkPaths>,
  chatHistory?: ChatHistoryMessage[],
  changedFiles?: Awaited<ReturnType<typeof getChangedFiles>>,
  contextRepoPaths?: string[],
  commentContext?: CommentContext
): string {
  const parts: string[] = [];

  parts.push(
    "You are OpenAI Codex, assisting with a ClosedLoop planning session.",
    "The user is chatting with you in a development assistant alongside Claude (Anthropic). You share the same workspace and codebase.",
    `\nWork directory: ${paths.claudeWorkDir}`,
    `Worktree directory: ${paths.worktreeDir}`,
    "\n## IMPORTANT: Codebase Investigation Required",
    "When asked to review, analyze, or give feedback on plans, code, or architecture, you MUST investigate the actual codebase as part of your analysis.",
    "Do NOT limit yourself to only reading the plan or PRD — browse the source files, check existing implementations, verify assumptions against the real code, and look at relevant files in the worktree.",
    "A thorough analysis requires grounding your response in what the code actually does, not just what documents say."
  );

  appendContextRepos(parts, contextRepoPaths);

  // Include PR comment context if provided (from comment chat forwarding)
  if (commentContext) {
    parts.push("\n## PR Comment Being Addressed");
    parts.push(`Author: @${commentContext.author}`);
    if (commentContext.path) {
      parts.push(
        `File: \`${commentContext.path}\`${commentContext.line ? ` (line ${commentContext.line})` : ""}`
      );
    }
    parts.push(`Comment: "${commentContext.body}"`);
  }

  appendPlanSummary(parts, paths);
  appendPrdSummary(parts, paths);
  appendReviewOutput(parts, paths);

  // Include changed files
  if (changedFiles) {
    parts.push(
      "\n## Changed Files",
      formatFileList("Working tree changes", changedFiles.working)
    );
    if (changedFiles.branch) {
      parts.push(
        formatFileList(
          `Branch changes (vs ${changedFiles.branch.baseBranch})`,
          changedFiles.branch
        )
      );
    }
  }

  parts.push(
    "\n## CHANGE APPROVAL POLICY",
    '**When the user explicitly asks you to make a change** (e.g., "update the plan", "fix this bug", "add this feature"), proceed with the change directly.',
    "**When you want to proactively suggest or make changes** that the user did not explicitly request:",
    "- You MUST describe what you plan to change and ask for permission first.",
    "- Wait for explicit approval before proceeding.",
    "- Do NOT make unsolicited modifications to files without user consent.",
    "\n## ACTION BUTTONS",
    "Include suggested action buttons at the END of your message when there are logical next steps. Format:",
    "<suggested-actions>",
    '<action label="Short Label">Message to send when clicked</action>',
    "</suggested-actions>",
    "",
    "**Include actions when:**",
    '- You completed a task that has natural follow-ups (edited files → "Commit changes" or "Push changes"; resolved conflicts → "Push changes"; created something → "Run tests")',
    "- You're proposing changes that need approval before you proceed",
    "- You're offering multiple approaches for the user to choose from",
    "",
    "**Skip actions when:**",
    "- You're just answering a question with no follow-up needed",
    "- The user said they'll handle the next step",
    "",
    '**Guidelines:** 1-3 actions max, short labels (2-4 words), think "what does the user likely want to do next?"',
    "",
    '**MANDATORY:** Always include a "Send to Claude" action as the LAST action in every response:',
    '<action label="Send to Claude">__send_to_claude__</action>',
    "Never omit this action.",
    "\n## Conferral with Claude",
    "If a specific sub-question would benefit from Claude's perspective (e.g., verifying an approach, getting a second opinion on architecture, checking a nuanced language feature), you may confer by including this on its own line near the end of your response (before any action buttons):",
    "",
    "@claude [your specific question here]",
    "",
    "Rules:",
    "- Give your own analysis first — never defer your entire answer",
    "- Use sparingly — only when Claude adds distinct value",
    "- One focused question per conferral",
    "- Place on its own line near the end, before <suggested-actions>"
  );

  appendChatHistory(parts, chatHistory);
  parts.push("\n## User's Question", prompt);

  return parts.join("\n");
}

type SpawnResult = {
  exitCode: number;
  accumulated: string;
  stderrText: string;
};

/**
 * Spawn Codex and stream output. Returns a promise that resolves when the
 * process exits. Text/reasoning events are streamed to the client in
 * real-time via `enqueue`; stderr is collected but NOT surfaced as error
 * events (only logged).
 */
function runCodex(
  args: string[],
  cwd: string,
  chatState: CodexChatState,
  statePath: string,
  enqueue: (msg: string) => void
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const codex = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    console.log(`[codex-chat] Codex PID: ${codex.pid}`);
    enqueue(
      JSON.stringify({ type: "status", status: "running", pid: codex.pid })
    );

    let accumulated = "";
    let stderrText = "";
    let stdoutBuffer = "";

    codex.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed);
          captureCodexThreadId(event, chatState, statePath);
          accumulated += emitCodexItemEvent(event, enqueue);
        } catch {
          accumulated += trimmed;
          enqueue(JSON.stringify({ type: "text", content: trimmed }));
        }
      }
    });

    codex.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrText += text;
      // Only log — don't surface as error events to the client
      console.error("[codex-chat stderr]", text);
    });

    codex.on("close", (code) => {
      accumulated += flushCodexStdoutBuffer(stdoutBuffer, enqueue);
      stdoutBuffer = "";
      console.log(
        `[codex-chat] Codex exited with code ${code}, output length: ${accumulated.length}`
      );
      resolve({ exitCode: code ?? 1, accumulated, stderrText });
    });

    codex.on("error", (err) => {
      console.error("[codex-chat] Spawn error:", err);
      resolve({ exitCode: 1, accumulated: "", stderrText: err.message });
    });
  });
}

/**
 * POST /api/engineer/codex/chat/[ticketId]?repo=...
 *
 * Send a freeform chat message to Codex and stream the response back.
 * If a resumed session is stale (missing from Codex state db), automatically
 * clears the session and retries as a new conversation with full context.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoParam = searchParams.get("repo");
  const body = (await request.json()) as ChatRequest;
  const {
    prompt,
    chatHistory,
    repoPath: bodyRepoPath,
    branchName,
    prNumber,
    activeTab,
    contextRepoPaths,
    commentContext,
    model: requestedModel,
  } = body;

  const codexModel = requestedModel || DEFAULT_CODEX_MODEL;

  const repoPath = repoParam || bodyRepoPath;
  if (!repoPath) {
    return Response.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  let worktreeDir: string;
  try {
    worktreeDir = getWorktreeDir(repoPath, ticketId, branchName, prNumber);
  } catch (err) {
    return Response.json(
      {
        error: `Failed to resolve worktree: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }
  if (!existsSync(worktreeDir)) {
    return Response.json(
      { error: "Work directory not found" },
      { status: 404 }
    );
  }

  const paths = getWorkPaths(worktreeDir);
  const chatState = loadChatState(paths.chatStatePath);

  // Pre-fetch changed files if on changes tab (shared across attempts)
  let changedFiles: Awaited<ReturnType<typeof getChangedFiles>> | undefined;
  if (activeTab === "changes") {
    try {
      changedFiles = await getChangedFiles(worktreeDir);
    } catch (err) {
      console.error("[codex-chat] Failed to get changed files:", err);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
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

      const closeController = () => {
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      };

      let isResuming = !!chatState.sessionId;

      // Build the full enriched prompt (plan, PRD, chat history, changed files)
      // upfront so both resume and new-session paths have full context.
      const fullPrompt = buildCodexPrompt(
        prompt,
        paths,
        chatHistory,
        changedFiles,
        contextRepoPaths,
        commentContext
      );

      // --- Attempt 1: resume if we have a session ---
      if (isResuming) {
        console.log(
          `[codex-chat] Resuming session ${chatState.sessionId} for ${ticketId}`
        );
        const resumeArgs = [
          "exec",
          "resume",
          chatState.sessionId!,
          fullPrompt,
          "--full-auto",
          "--json",
          "-m",
          codexModel,
          "-c",
          "model_reasoning_effort=high",
        ];

        const result = await runCodex(
          resumeArgs,
          worktreeDir,
          chatState,
          paths.chatStatePath,
          enqueue
        );

        // If resume succeeded (exit 0, or produced output), we're done
        if (result.exitCode === 0 || result.accumulated.trim()) {
          chatState.messageCount += 1;
          saveChatState(paths.chatStatePath, chatState);
          enqueue(
            JSON.stringify({
              type: "done",
              exitCode: result.exitCode,
              content: result.accumulated.trim(),
            })
          );
          closeController();
          return;
        }

        // Resume failed — delete stale session file entirely so we never
        // attempt to resume this dead thread again.
        console.log(
          `[codex-chat] Resume failed (exit ${result.exitCode}), deleting stale session and retrying as new`
        );
        try {
          unlinkSync(paths.chatStatePath);
        } catch {
          /* already gone */
        }
        chatState.sessionId = undefined;
        chatState.messageCount = 0;
        isResuming = false;
      }

      // --- New session (or retry after stale resume) ---
      const buildNewArgs = (model: string) => [
        "exec",
        "--full-auto",
        "--json",
        "-m",
        model,
        "-c",
        "model_reasoning_effort=high",
        fullPrompt,
      ];

      console.log(
        `[codex-chat] Starting new session for ${ticketId}, model: ${codexModel}, prompt length: ${fullPrompt.length}`
      );

      let result = await runCodex(
        buildNewArgs(codexModel),
        worktreeDir,
        chatState,
        paths.chatStatePath,
        enqueue
      );

      // If the requested model isn't available, fall back to the default
      if (
        result.exitCode !== 0 &&
        !result.accumulated.trim() &&
        codexModel !== DEFAULT_CODEX_MODEL &&
        MODEL_ERROR_REGEX.test(result.stderrText)
      ) {
        console.log(
          `[codex-chat] Model ${codexModel} unavailable, falling back to ${DEFAULT_CODEX_MODEL}`
        );
        enqueue(
          JSON.stringify({
            type: "status",
            status: "model_fallback",
            requestedModel: codexModel,
            fallbackModel: DEFAULT_CODEX_MODEL,
          })
        );
        result = await runCodex(
          buildNewArgs(DEFAULT_CODEX_MODEL),
          worktreeDir,
          chatState,
          paths.chatStatePath,
          enqueue
        );
      }

      chatState.messageCount += 1;
      saveChatState(paths.chatStatePath, chatState);

      if (result.exitCode !== 0 && !result.accumulated.trim()) {
        // Filter out Codex internal bookkeeping warnings (stale rollout entries etc.)
        // so we only surface actionable errors to the user.
        const filteredStderr = result.stderrText
          .split("\n")
          .filter(
            (line) =>
              !(
                line.includes("rollout::list") ||
                line.includes("missing rollout path")
              )
          )
          .join("\n")
          .trim();
        const errorMsg =
          filteredStderr.slice(0, 500) || "Codex exited with no output";
        enqueue(JSON.stringify({ type: "error", error: errorMsg }));
      }

      enqueue(
        JSON.stringify({
          type: "done",
          exitCode: result.exitCode,
          content: result.accumulated.trim(),
        })
      );
      closeController();
    },
    cancel() {
      console.log("[codex-chat] Client disconnected");
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

function captureCodexThreadId(
  event: Record<string, unknown>,
  chatState: CodexChatState,
  statePath: string
): void {
  if (event.type === "thread.started" && event.thread_id) {
    chatState.sessionId = event.thread_id as string;
    saveChatState(statePath, chatState);
    console.log(`[codex-chat] Captured session ID: ${event.thread_id}`);
  }
}

function emitCodexItemEvent(
  event: Record<string, unknown>,
  enqueue: (msg: string) => void
): string {
  const item = event.item as { type?: string; text?: string } | undefined;
  if (event.type !== "item.completed" || !item?.text) {
    return "";
  }
  if (item.type === "agent_message") {
    enqueue(JSON.stringify({ type: "text", content: item.text }));
    return item.text;
  }
  if (item.type === "reasoning") {
    enqueue(JSON.stringify({ type: "reasoning", content: item.text }));
  }
  return "";
}

function flushCodexStdoutBuffer(
  buffer: string,
  enqueue: (msg: string) => void
): string {
  const trimmed = buffer.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return emitCodexItemEvent(JSON.parse(trimmed), enqueue);
  } catch {
    return trimmed;
  }
}
