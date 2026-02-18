import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { parseDebateStatus } from "@/lib/engineer/chat-utils";
import { expandHome, getWorktreeParentDir } from "@/lib/engineer/repos";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STALE_SESSION_REGEX =
  /state db missing|rollout.*missing|thread.*not found/i;

type DebateRequest = {
  claudeArgument: string;
  findingSummary: string;
  debateHistory: { sender: string; content: string }[];
  model: string;
  repoPath: string;
  reasoningEffort?: string;
};

type DebateState = {
  sessionId?: string;
  rounds: number;
};

function getWorktreeDir(repoPath: string, ticketId: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

function getDebateStatePath(worktreeDir: string): string {
  return join(worktreeDir, ".claude", "work", "codex-debate.json");
}

function loadDebateState(worktreeDir: string): DebateState {
  const statePath = getDebateStatePath(worktreeDir);
  if (!existsSync(statePath)) {
    return { rounds: 0 };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as DebateState;
  } catch {
    return { rounds: 0 };
  }
}

function saveDebateState(worktreeDir: string, state: DebateState): void {
  const statePath = getDebateStatePath(worktreeDir);
  const dir = join(statePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function buildCodexPrompt(
  findingSummary: string,
  claudeArgument: string,
  debateHistory: { sender: string; content: string }[],
  model: string
): string {
  const parts: string[] = [];

  parts.push(
    `You are OpenAI Codex (${model}), a code review AI. You are in a structured debate with Claude (Anthropic) about a code review finding.`,
    "",
    "## Purpose of this debate",
    "The goal is NOT to win — it is to arrive at the correct answer together. Two AI models examining the same issue from different angles are more likely to find the truth than either one alone. Update your position if Claude presents valid evidence. Concede clearly if you were wrong. Push back with specifics if you still believe you're right.",
    "",
    "## IMPORTANT: Codebase Investigation Required",
    "You MUST investigate the actual codebase as part of your analysis. Do NOT limit yourself to only the finding summary or debate history — browse the source files, check existing implementations, and verify claims against the real code. A thorough analysis requires grounding your arguments in what the code actually does.",
    "",
    "## The Finding Under Discussion",
    findingSummary
  );

  if (debateHistory.length > 0) {
    parts.push("", "## Debate So Far");
    for (const turn of debateHistory) {
      const label = turn.sender === "claude" ? "Claude" : "Codex (you)";
      parts.push("", `### ${label}:`, turn.content);
    }
  }

  parts.push(
    "",
    "## Claude's Latest Argument",
    claudeArgument,
    "",
    "Respond to Claude's argument. Cite specific code evidence. If Claude raises a valid point, acknowledge it and update your position. If you still disagree, explain exactly why with references to the code. Be direct and substantive. Address Claude by name.",
    "",
    "## DEBATE STATUS TRACKING",
    "At the END of your response, you MUST include a debate status block:",
    "",
    "<debate-status>",
    '{"pendingIssues": [{"id": "1", "summary": "Brief description of unresolved point"}],',
    ' "resolvedIssues": [{"id": "1", "summary": "Brief description", "resolution": "How it was resolved"}]}',
    "</debate-status>",
    "",
    "Rules:",
    "- Every issue discussed should appear in exactly one list",
    "- Move issues from pending to resolved as agreement is reached",
    "- When you fully agree with Claude on ALL points, pendingIssues must be empty []",
    "- Always include this block — never omit it",
    "",
    "## ACTION BUTTONS",
    "Do NOT include any suggested-actions or action buttons in your debate responses.",
    "The UI handles debate turn buttons automatically. Never include <suggested-actions> blocks."
  );

  return parts.join("\n");
}

/**
 * POST /api/codex/argue/[ticketId]?repo=...
 *
 * Send Claude's argument to Codex and stream the response back.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;
  const searchParams = request.nextUrl.searchParams;
  const repoParam = searchParams.get("repo");
  const body = (await request.json()) as DebateRequest;
  const {
    claudeArgument,
    findingSummary,
    debateHistory,
    model,
    repoPath: bodyRepoPath,
    reasoningEffort,
  } = body;

  const repoPath = repoParam || bodyRepoPath;
  if (!repoPath) {
    return Response.json(
      { error: "repo parameter is required" },
      { status: 400 }
    );
  }

  if (!(claudeArgument && findingSummary)) {
    return Response.json(
      { error: "claudeArgument and findingSummary are required" },
      { status: 400 }
    );
  }

  const worktreeDir = getWorktreeDir(repoPath, ticketId);
  if (!existsSync(worktreeDir)) {
    return Response.json(
      { error: "Work directory not found" },
      { status: 404 }
    );
  }

  const debateState = loadDebateState(worktreeDir);

  // Clear stale session when starting a fresh debate (opening argument only)
  if (debateState.sessionId && (!debateHistory || debateHistory.length <= 1)) {
    debateState.sessionId = undefined;
    debateState.rounds = 0;
    saveDebateState(worktreeDir, debateState);
  }

  const isResuming = !!debateState.sessionId;

  const prompt = isResuming
    ? claudeArgument
    : buildCodexPrompt(
        findingSummary,
        claudeArgument,
        debateHistory || [],
        model
      );

  // Build codex exec arguments with --json for structured JSONL output
  // Use danger-full-access sandbox so Codex can access network/DB for typechecks and tests
  const codexArgs: string[] = isResuming
    ? [
        "exec",
        "resume",
        debateState.sessionId!,
        prompt,
        "--full-auto",
        "--json",
        "-m",
        model,
      ]
    : ["exec", "--full-auto", "--json", "-m", model, prompt];

  if (reasoningEffort) {
    codexArgs.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }

  console.log(
    `[codex-argue] ${isResuming ? "Resuming" : "Starting"} debate for ${ticketId}`,
    {
      worktreeDir,
      model,
      sessionId: debateState.sessionId,
      promptLength: prompt.length,
    }
  );

  // Build fresh (non-resume) args for retry fallback when resume fails
  let freshArgs: string[] = codexArgs;
  if (isResuming) {
    const freshPrompt = buildCodexPrompt(
      findingSummary,
      claudeArgument,
      debateHistory || [],
      model
    );
    freshArgs = ["exec", "--full-auto", "--json", "-m", model, freshPrompt];
    if (reasoningEffort) {
      freshArgs.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
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

      /**
       * Spawn a codex process and wire its output to the stream.
       * If `canRetry` is true and the process fails with a stale-session
       * error, it clears the session and retries with fresh args.
       */
      const runCodex = (args: string[], canRetry: boolean) => {
        const codex = spawn("codex", args, {
          cwd: worktreeDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            FORCE_COLOR: "0",
          },
        });

        console.log(
          `[codex-argue] Codex PID: ${codex.pid}${canRetry ? "" : " (retry)"}`
        );

        enqueue(
          JSON.stringify({ type: "status", status: "running", pid: codex.pid })
        );

        let accumulated = "";
        let stdoutBuffer = "";
        let staleSession = false;

        codex.stdout?.on("data", (data: Buffer) => {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            accumulated = processCodexLine(
              trimmed,
              accumulated,
              enqueue,
              (id) => {
                debateState.sessionId = id;
                saveDebateState(worktreeDir, debateState);
                console.log(`[codex-argue] Captured session ID: ${id}`);
              }
            );
          }
        });

        codex.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          console.error("[codex-argue stderr]", text);
          // Detect stale session errors — don't forward to client if we can retry
          if (STALE_SESSION_REGEX.test(text)) {
            staleSession = true;
            if (canRetry) {
              return;
            }
          }
          enqueue(JSON.stringify({ type: "error", error: text }));
        });

        codex.on("close", (code) => {
          // Flush remaining buffered stdout
          accumulated = flushStdoutBuffer(stdoutBuffer, accumulated, enqueue);
          stdoutBuffer = "";

          console.log(
            `[codex-argue] Codex exited with code ${code}, output length: ${accumulated.length}`
          );

          // Stale session: clear state and retry with fresh args
          if (staleSession && canRetry && code !== 0) {
            console.log(
              "[codex-argue] Stale session detected, retrying with fresh exec"
            );
            debateState.sessionId = undefined;
            debateState.rounds = 0;
            saveDebateState(worktreeDir, debateState);
            runCodex(freshArgs, false);
            return;
          }

          debateState.rounds += 1;
          saveDebateState(worktreeDir, debateState);

          const { cleanContent, status: debateStatus } = parseDebateStatus(
            accumulated.trim()
          );

          enqueue(
            JSON.stringify({
              type: "done",
              exitCode: code,
              content: cleanContent,
              debateStatus,
            })
          );
          closeController();
        });

        codex.on("error", (err) => {
          console.error("[codex-argue] Spawn error:", err);
          enqueue(
            JSON.stringify({
              type: "error",
              error: `Failed to start Codex: ${err.message}`,
            })
          );
          closeController();
        });
      };

      runCodex(codexArgs, isResuming);
    },
    cancel() {
      console.log("[codex-argue] Client disconnected");
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

function processCodexLine(
  trimmed: string,
  accumulated: string,
  enqueue: (s: string) => void,
  onThreadStarted: (id: string) => void
): string {
  try {
    const event = JSON.parse(trimmed);
    if (event.type === "thread.started" && event.thread_id) {
      onThreadStarted(event.thread_id as string);
    }
    if (event.type === "item.completed" && event.item?.text) {
      const prefix = accumulated && !accumulated.endsWith("\n") ? "\n\n" : "";
      if (event.item.type === "agent_message") {
        enqueue(
          JSON.stringify({ type: "text", content: prefix + event.item.text })
        );
        return accumulated + prefix + event.item.text;
      }
      if (event.item.type === "reasoning") {
        enqueue(
          JSON.stringify({ type: "reasoning", content: event.item.text })
        );
      }
    }
  } catch {
    const prefix = accumulated && !accumulated.endsWith("\n") ? "\n\n" : "";
    enqueue(JSON.stringify({ type: "text", content: prefix + trimmed }));
    return accumulated + prefix + trimmed;
  }
  return accumulated;
}

function flushStdoutBuffer(
  buffer: string,
  accumulated: string,
  enqueue: (s: string) => void
): string {
  const remaining = buffer.trim();
  if (!remaining) {
    return accumulated;
  }
  try {
    const event = JSON.parse(remaining);
    if (event.type === "item.completed" && event.item?.text) {
      const prefix = accumulated && !accumulated.endsWith("\n") ? "\n\n" : "";
      if (event.item.type === "agent_message") {
        enqueue(
          JSON.stringify({ type: "text", content: prefix + event.item.text })
        );
        return accumulated + prefix + event.item.text;
      }
      if (event.item.type === "reasoning") {
        enqueue(
          JSON.stringify({ type: "reasoning", content: event.item.text })
        );
      }
    }
  } catch {
    const prefix =
      accumulated && !accumulated.endsWith("\n") && remaining ? "\n\n" : "";
    return accumulated + prefix + remaining;
  }
  return accumulated;
}
