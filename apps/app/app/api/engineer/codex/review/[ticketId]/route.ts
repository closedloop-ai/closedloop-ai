import {
  type ChildProcess,
  execSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { NextRequest } from "next/server";
import { withMcpTools } from "@/lib/engineer/allowed-tools";
import {
  describeClaudeEvent,
  extractClaudeSessionId,
  extractClaudeText,
} from "@/lib/engineer/claude-stream-utils";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { ensureWorktree } from "@/lib/engineer/worktree";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max for long reviews

const PR_PREFIX_REGEX = /^pr-/;
const SAFE_REF_REGEX = /^[a-zA-Z0-9/_.-]+$/;
const CODEX_SESSION_ID_REGEX = /session id:\s*([0-9a-f-]{36})/i;
const MODEL_ERROR_REGEX =
  /model.*not.*(?:found|available|supported|exist)|unsupported.*model|invalid.*model|does not have access/i;
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

type ReviewRequest = {
  instructions?: string;
  model: string;
  reasoningEffort: string;
  reviewMode: "uncommitted" | "base";
  baseBranch?: string;
  repoPath: string;
  branchName?: string;
  provider?: "claude" | "codex";
  useBaseRepo?: boolean;
};

type ReviewState = {
  status: "running" | "completed" | "failed" | "stopped";
  pid?: number;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  provider: "claude" | "codex";
  sessionId?: string;
  reviewCommand?: string;
  config: {
    model: string;
    reasoningEffort: string;
    reviewMode: "uncommitted" | "base";
    baseBranch: string;
    instructions?: string;
  };
};

function getWorktreeDir(repoPath: string, ticketId: string): string {
  const expandedRepoPath = expandHome(repoPath);
  const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const repoName = basename(expandedRepoPath);
  const worktreeParentDir = getWorktreeParentDir();
  return join(worktreeParentDir, `${repoName}-${sanitizedTicket}`);
}

function getReviewPaths(worktreeDir: string, provider: string) {
  const workDir = join(worktreeDir, ".claude", "work");
  return {
    workDir,
    worktreeDir,
    statePath: join(workDir, `codex-review-${provider}.json`),
    logPath: join(workDir, `codex-review-${provider}.log`),
    pidPath: join(workDir, `codex-review-${provider}.pid`),
  };
}

async function writeReviewState(
  worktreeDir: string,
  provider: string,
  state: ReviewState
): Promise<void> {
  const { workDir, statePath } = getReviewPaths(worktreeDir, provider);
  await mkdir(workDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function appendReviewLog(
  worktreeDir: string,
  provider: string,
  content: string
): Promise<void> {
  const { workDir, logPath } = getReviewPaths(worktreeDir, provider);
  await mkdir(workDir, { recursive: true });
  await appendFile(logPath, content);
}

async function clearReviewLog(
  worktreeDir: string,
  provider: string
): Promise<void> {
  const { logPath } = getReviewPaths(worktreeDir, provider);
  if (existsSync(logPath)) {
    await writeFile(logPath, "");
  }
}

function spawnCodexReview(
  cwd: string,
  model: string,
  reasoningEffort: string,
  reviewMode: "uncommitted" | "base",
  baseBranch: string,
  _instructions?: string
): ChildProcess {
  const args: string[] = ["review"];

  if (reviewMode === "uncommitted") {
    args.push("--uncommitted");
  } else {
    args.push("--base", baseBranch);
  }

  args.push(
    "-c",
    `model=${model}`,
    "-c",
    `model_reasoning_effort=${reasoningEffort}`
  );

  // codex review doesn't allow [PROMPT] with --base/--uncommitted.
  // Verdict is extracted post-review via session resumption (review-verdict route).

  return spawn("codex", args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });
}

const REVIEW_SYSTEM_PROMPT = [
  "IMPORTANT: Before flagging any change, examine the surrounding context — commit messages, PR description, related changes in other files, and code comments — to understand WHY the change was made.",
  "Only report findings where the issue is clearly unintentional. Skip patterns that appear to be deliberate design decisions, intentional trade-offs, or conscious simplifications.",
  "If a change looks unusual but is consistent with the overall PR intent, do not flag it.",
  "At the very end of your review, include a ```json fenced code block containing ALL findings as a JSON array.",
  'Each element must have: {"severity": "critical"|"high"|"medium"|"low",',
  '"file": "full/repo-relative/path.ts", "line": <number or null>,',
  '"title": "one-line summary", "description": "detailed explanation",',
  '"suggestion": "suggested fix or null"}.',
  'Use FULL repository-relative file paths (e.g. "src/components/Button.tsx"), not abbreviated names.',
].join(" ");

function spawnClaudeReview(cwd: string, model: string): ChildProcess {
  return spawn(
    "claude",
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      model,
      "--allowedTools",
      withMcpTools("Bash,Read,Glob,Grep,Task,TodoWrite"),
      "--append-system-prompt",
      REVIEW_SYSTEM_PROMPT,
    ],
    {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      },
    }
  );
}

function setupProcessLifecycle(
  childProcess: ChildProcess,
  worktreeDir: string,
  initialState: ReviewState,
  pidPath: string,
  sessionIdHolder: { value: string | null },
  onModelError?: () => void
) {
  const provider = initialState.provider;
  let stderrText = "";

  if (provider === "claude") {
    // For Claude, extract text from stream-json events before writing to log.
    // Raw events are JSON metadata — only the extracted text is human-readable.
    let logBuffer = "";
    childProcess.stdout?.on("data", async (data: Buffer) => {
      logBuffer += data.toString();
      const lines = logBuffer.split("\n");
      logBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        await processClaudeLogLine(
          trimmed,
          worktreeDir,
          provider,
          sessionIdHolder
        );
      }
    });
  } else {
    // Buffer the first ~2KB of Codex stdout to capture the session ID from its startup banner.
    // Once found (or buffer limit hit), stop scanning but keep appending to the review log.
    let startupBuffer = "";
    let sessionIdCaptured = false;

    childProcess.stdout?.on("data", async (data: Buffer) => {
      const text = data.toString();

      // Parse session ID synchronously BEFORE any await so that
      // createCodexStream's listener (which reads sessionIdHolder.value
      // in the same event-loop tick) sees the captured value.
      if (!sessionIdCaptured) {
        startupBuffer += text;
        const match = CODEX_SESSION_ID_REGEX.exec(startupBuffer);
        if (match) {
          sessionIdHolder.value = match[1];
          sessionIdCaptured = true;
          startupBuffer = "";
          console.log(`[codex-review] Codex session ID captured: ${match[1]}`);
        } else if (startupBuffer.length > 2048) {
          // Stop scanning after 2KB — session ID should appear in the first few lines
          sessionIdCaptured = true;
          startupBuffer = "";
        }
      }

      await appendReviewLog(worktreeDir, provider, text);
    });
  }

  childProcess.stderr?.on("data", async (data: Buffer) => {
    const text = data.toString();
    stderrText += text;
    await appendReviewLog(worktreeDir, provider, text);
  });

  childProcess.on("close", async (code) => {
    console.log(
      `[codex-review] Process closed with code ${code} (provider: ${provider})`
    );

    // Model unavailable: re-spawn with default model instead of writing failure
    if (code !== 0 && onModelError && MODEL_ERROR_REGEX.test(stderrText)) {
      console.log(
        `[codex-review] Model error detected, triggering fallback to ${DEFAULT_CODEX_MODEL}`
      );
      onModelError();
      return;
    }

    const finalState: ReviewState = {
      ...initialState,
      status: code === 0 ? "completed" : "failed",
      completedAt: new Date().toISOString(),
      exitCode: code ?? 1,
      sessionId: sessionIdHolder.value ?? initialState.sessionId,
    };
    await writeReviewState(worktreeDir, provider, finalState);
    if (existsSync(pidPath)) {
      await unlink(pidPath).catch(() => {});
    }

    // Persist Codex session ID to codex-chat.json so the chat route can resume it
    if (provider === "codex" && sessionIdHolder.value) {
      const chatStatePath = join(
        worktreeDir,
        ".claude",
        "work",
        "codex-chat.json"
      );
      await mkdir(join(worktreeDir, ".claude", "work"), { recursive: true });
      await writeFile(
        chatStatePath,
        JSON.stringify(
          { sessionId: sessionIdHolder.value, messageCount: 0 },
          null,
          2
        )
      );
      console.log(
        `[codex-review] Wrote codex-chat.json with session ${sessionIdHolder.value}`
      );
    }
  });

  childProcess.on("error", async (err) => {
    console.error("[codex-review] Process error:", err);
    const errorState: ReviewState = {
      ...initialState,
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: 1,
    };
    await writeReviewState(worktreeDir, provider, errorState);
  });

  childProcess.unref();
}

function createCodexStream(
  childProcess: ChildProcess,
  sessionIdHolder: { value: string | null }
): ReadableStream {
  const encoder = new TextEncoder();
  let eventCount = 0;
  return new ReadableStream({
    start(controller) {
      let controllerClosed = false;
      let sessionIdEmitted = false;
      console.log(
        `[codex-stream] ReadableStream started for pid ${childProcess.pid}`
      );

      const closeController = () => {
        if (controllerClosed) {
          return;
        }
        controllerClosed = true;
        controller.close();
      };

      const sendEvent = (data: {
        type: string;
        content?: string;
        exitCode?: number;
        sessionId?: string;
      }) => {
        if (controllerClosed) {
          return;
        }
        eventCount++;
        console.log(
          `[codex-stream] sendEvent #${eventCount}: type=${data.type}, content length=${data.content?.length ?? 0}`
        );
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
        } catch (err) {
          console.log("[codex-stream] enqueue failed:", err);
        }
      };

      childProcess.stdout?.on("data", (data: Buffer) => {
        console.log(`[codex-stream] stdout data: ${data.length} bytes`);
        // Emit sessionId event once when setupProcessLifecycle has captured it
        if (!sessionIdEmitted && sessionIdHolder.value) {
          sessionIdEmitted = true;
          sendEvent({ type: "sessionId", sessionId: sessionIdHolder.value });
        }
        sendEvent({ type: "output", content: data.toString() });
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        console.log(`[codex-stream] stderr data: ${data.length} bytes`);
        sendEvent({ type: "output", content: data.toString() });
      });

      childProcess.on("close", (code) => {
        console.log(
          `[codex-stream] process closed with code ${code}, total events: ${eventCount}`
        );
        sendEvent({ type: "done", exitCode: code ?? 1 });
        closeController();
      });

      childProcess.on("error", (err) => {
        console.log("[codex-stream] process error:", err.message);
        sendEvent({ type: "error", content: err.message });
        closeController();
      });
    },
    cancel() {
      console.log(
        `[codex-stream] Client disconnected after ${eventCount} events, review continues in background`
      );
    },
  });
}

function createClaudeStream(
  childProcess: ChildProcess,
  sessionIdHolder?: { value: string | null },
  reviewCommand?: string
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      let buffer = "";
      let controllerClosed = false;

      const closeController = () => {
        if (controllerClosed) {
          return;
        }
        controllerClosed = true;
        controller.close();
      };

      const sendEvent = (data: {
        type: string;
        content?: string;
        exitCode?: number;
        sessionId?: string;
        reviewCommand?: string;
        contextPercent?: number;
      }) => {
        if (controllerClosed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
        } catch {
          // Stream may be closed
        }
      };

      // Emit review command as first event
      if (reviewCommand) {
        sendEvent({ type: "reviewCommand", reviewCommand });
      }

      // Track whether we've started the kill timer after a result event
      let resultKillTimerSet = false;

      childProcess.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const isResult = processClaudeStreamLine(
            trimmed,
            sessionIdHolder,
            sendEvent
          );

          // Start kill timer once we see a result event (Claude CLI may hang)
          if (isResult && !resultKillTimerSet) {
            resultKillTimerSet = true;
            const killTimer = setTimeout(() => {
              console.warn("[codex-review] Kill timeout after result: SIGTERM");
              try {
                childProcess.kill("SIGTERM");
              } catch {}
              setTimeout(() => {
                try {
                  childProcess.kill("SIGKILL");
                } catch {}
              }, 5000);
            }, 30_000);
            childProcess.once("close", () => clearTimeout(killTimer));
          }
        }
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        console.log(
          `[codex-review] Claude stderr: ${data.toString().trim().slice(0, 300)}`
        );
      });

      childProcess.on("close", (code) => {
        console.log(
          `[codex-review] Claude process closed with code ${code}, buffer remaining: ${buffer.length} chars`
        );
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim());

            const sid = extractClaudeSessionId(event);
            if (sid && sessionIdHolder) {
              sessionIdHolder.value = sid;
              sendEvent({ type: "sessionId", sessionId: sid });
            }

            const text = extractClaudeText(event);
            if (text) {
              sendEvent({ type: "output", content: text });
            }
          } catch {
            sendEvent({ type: "output", content: `${buffer.trim()}\n` });
          }
        }
        sendEvent({ type: "done", exitCode: code ?? 1 });
        closeController();
      });

      childProcess.on("error", (err) => {
        sendEvent({ type: "error", content: err.message });
        closeController();
      });
    },
    cancel() {
      console.log(
        "[codex-review] Client disconnected, review continues in background"
      );
    },
  });
}

/**
 * Try spawning Claude with /code-review:review skill first.
 * If the process exits without producing real model output (only system/init/result
 * events), fall back to /review <prNum>.
 *
 * Claude CLI always emits system/init events before processing input, so we parse
 * the stream-json events and only declare "working" when we see actual model
 * activity (assistant, content_block_delta, user events).
 */
async function resolveClaudeReviewProcess(
  cwd: string,
  model: string,
  prNum: string,
  stateDir: string,
  provider: string
): Promise<{ process: ChildProcess; command: string }> {
  const first = spawnClaudeReview(cwd, model);
  first.stdin?.write("/code-review:review");
  first.stdin?.end();
  console.log(`[codex-review] Trying /code-review:review (pid: ${first.pid})`);

  type ProbeResult = { type: "working" } | { type: "exited"; code: number };

  // Collect all stdout chunks during probe so we can put them back for consumers
  const probeChunks: Buffer[] = [];

  const result = await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let probeBuf = "";
    const settle = (r: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      first.stdout?.removeListener("data", onData);
      resolve(r);
    };

    // Safety timeout: if 60s pass with no real output and no exit, assume it's working
    const timer = setTimeout(() => settle({ type: "working" }), 60_000);

    // Ignore system/init/result events (CLI initialization + empty completion).
    // Only treat real model activity as "working".
    const INIT_EVENTS = new Set(["system", "init", "result"]);

    const onData = (chunk: Buffer) => {
      probeChunks.push(chunk);
      probeBuf += chunk.toString();
      const lines = probeBuf.split("\n");
      probeBuf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed);
          if (!INIT_EVENTS.has(event.type)) {
            settle({ type: "working" });
            return;
          }
        } catch {
          // Non-JSON output = real content
          settle({ type: "working" });
          return;
        }
      }
    };

    first.stdout?.on("data", onData);

    // If process exits before producing real output, fall back
    first.on("close", (code) => {
      settle({ type: "exited", code: code ?? 1 });
    });
  });

  if (result.type === "working") {
    console.log("[codex-review] /code-review:review is producing output");
    // Put consumed probe data back in reverse order so stream consumers see it
    for (const chunk of probeChunks.reverse()) {
      first.stdout?.unshift(chunk);
    }
    return { process: first, command: "/code-review:review" };
  }

  console.log(
    `[codex-review] /code-review:review exited (code: ${result.code}) without producing review content, falling back to /review ${prNum}`
  );
  await clearReviewLog(stateDir, provider);

  const fallback = spawnClaudeReview(cwd, model);
  fallback.stdin?.write(`/review ${prNum}`);
  fallback.stdin?.end();
  console.log(`[codex-review] Fallback /review spawned (pid: ${fallback.pid})`);
  return { process: fallback, command: "/review" };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  const { ticketId } = await params;

  let body: ReviewRequest;
  try {
    body = (await request.json()) as ReviewRequest;
  } catch {
    return Response.json(
      { error: "Invalid or empty JSON body" },
      { status: 400 }
    );
  }

  const {
    instructions,
    model,
    reasoningEffort,
    reviewMode,
    baseBranch = "main",
    repoPath,
    branchName,
    provider = "codex",
    useBaseRepo = false,
  } = body;

  if (!repoPath) {
    return Response.json({ error: "repoPath is required" }, { status: 400 });
  }

  if (!isRepoAllowed(repoPath)) {
    return Response.json(
      { error: `Repository not allowed: ${repoPath}` },
      { status: 403 }
    );
  }

  // Derive the ticket-specific worktree path (consistent with status/stop routes)
  const worktreeDir = getWorktreeDir(repoPath, ticketId);
  const expandedRepoPath = expandHome(repoPath);

  // reviewCwd is where the review process runs; worktreeDir is always used for state files
  const reviewCwd = useBaseRepo ? expandedRepoPath : worktreeDir;

  const worktreeError = setupWorktreeForReview(
    expandedRepoPath,
    worktreeDir,
    branchName,
    useBaseRepo
  );
  if (worktreeError) {
    return worktreeError;
  }

  // Check if a review is already running for this provider
  const { statePath, pidPath } = getReviewPaths(worktreeDir, provider);
  if (await checkForRunningReview(statePath)) {
    return Response.json(
      {
        error:
          "A review is already running. Stop it first or wait for completion.",
      },
      { status: 409 }
    );
  }

  // For codex reviews, detect merged PRs where HEAD is already in main's history.
  // In that case, `codex review --base main` produces an empty diff.
  // Fix: apply the GitHub PR diff as uncommitted changes and use --uncommitted mode.
  const effectiveReviewMode = resolveEffectiveReviewMode(
    worktreeDir,
    baseBranch,
    ticketId,
    reviewMode,
    useBaseRepo,
    provider
  );

  console.log(`[codex-review] Starting ${provider} review for ${ticketId}`, {
    model,
    reviewMode: effectiveReviewMode,
    worktreeDir,
    reviewCwd,
    useBaseRepo,
  });

  // Clear previous log
  await clearReviewLog(worktreeDir, provider);

  // Spawn the appropriate process
  let childProcess: ChildProcess;
  let reviewCommand: string | undefined;

  if (provider === "claude") {
    const prNum = ticketId.replace(PR_PREFIX_REGEX, "");
    const resolved = await resolveClaudeReviewProcess(
      reviewCwd,
      model,
      prNum,
      worktreeDir,
      provider
    );
    childProcess = resolved.process;
    reviewCommand = resolved.command;
  } else {
    childProcess = spawnCodexReview(
      reviewCwd,
      model,
      reasoningEffort,
      effectiveReviewMode,
      baseBranch,
      instructions
    );
  }

  const pid = childProcess.pid;

  if (reviewCommand) {
    console.log(
      `[codex-review] Starting claude review for ${ticketId} using ${reviewCommand}`
    );
  }

  // Write initial state (track effective review mode for merged PR detection)
  const initialState: ReviewState = {
    status: "running",
    pid,
    startedAt: new Date().toISOString(),
    provider,
    reviewCommand,
    config: {
      model,
      reasoningEffort,
      reviewMode,
      baseBranch,
      instructions,
    },
  };
  await writeReviewState(worktreeDir, provider, initialState);

  // Write PID file
  if (pid) {
    await writeFile(pidPath, String(pid));
  }

  // Session ID holder — populated by stream handlers, saved by setupProcessLifecycle.
  // Universal: Claude extracts from stream-json events, Codex parses from startup banner.
  const sessionIdHolder: { value: string | null } = { value: null };

  // Model fallback: if the requested model is unavailable, re-spawn with the default.
  // Only applies to Codex reviews with a non-default model.
  const modelFallbackHandler =
    provider === "codex" && model !== DEFAULT_CODEX_MODEL
      ? () => {
          console.log(
            `[codex-review] Re-spawning review with fallback model ${DEFAULT_CODEX_MODEL}`
          );
          clearReviewLog(worktreeDir, provider).then(() => {
            const fallbackProcess = spawnCodexReview(
              reviewCwd,
              DEFAULT_CODEX_MODEL,
              reasoningEffort,
              effectiveReviewMode,
              baseBranch,
              instructions
            );
            const fallbackState: ReviewState = {
              ...initialState,
              pid: fallbackProcess.pid,
              config: { ...initialState.config, model: DEFAULT_CODEX_MODEL },
            };
            writeReviewState(worktreeDir, provider, fallbackState);
            if (fallbackProcess.pid) {
              writeFile(pidPath, String(fallbackProcess.pid));
            }
            const fallbackSessionId: { value: string | null } = { value: null };
            // No further model fallback — pass undefined to prevent infinite retry
            setupProcessLifecycle(
              fallbackProcess,
              worktreeDir,
              fallbackState,
              pidPath,
              fallbackSessionId
            );
            appendReviewLog(
              worktreeDir,
              provider,
              `\n[Model ${model} unavailable — fell back to ${DEFAULT_CODEX_MODEL}]\n\n`
            );
          });
        }
      : undefined;

  // Set up lifecycle handlers (log capture, state updates on close/error)
  setupProcessLifecycle(
    childProcess,
    worktreeDir,
    initialState,
    pidPath,
    sessionIdHolder,
    modelFallbackHandler
  );

  // Create the appropriate streaming response
  const stream =
    provider === "claude"
      ? createClaudeStream(childProcess, sessionIdHolder, reviewCommand)
      : createCodexStream(childProcess, sessionIdHolder);

  console.log(
    `[codex-review] Returning streaming response for ${provider}, pid ${pid}`
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Review-PID": String(pid || ""),
    },
  });
}

function setupWorktreeForReview(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string | undefined,
  useBaseRepo: boolean
): Response | null {
  if (useBaseRepo) {
    return null;
  }
  const hasGit = existsSync(join(worktreeDir, ".git"));
  if (!(hasGit || branchName)) {
    return Response.json(
      { error: "No git worktree found and no branchName provided" },
      { status: 400 }
    );
  }
  try {
    ensureWorktree(expandedRepoPath, worktreeDir, branchName);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Failed to set up worktree: ${msg}` },
      { status: 500 }
    );
  }
}

async function checkForRunningReview(statePath: string): Promise<boolean> {
  if (!existsSync(statePath)) {
    return false;
  }
  try {
    const existingState: ReviewState = JSON.parse(
      await readFile(statePath, "utf-8")
    );
    if (existingState.status !== "running" || !existingState.pid) {
      return false;
    }
    try {
      process.kill(existingState.pid, 0);
      return true;
    } catch {
      console.log(
        `[codex-review] Cleaning up stale review state (pid ${existingState.pid} is dead)`
      );
    }
  } catch {
    // State file corrupted, continue
  }
  return false;
}

function resolveEffectiveReviewMode(
  worktreeDir: string,
  baseBranch: string,
  ticketId: string,
  reviewMode: "uncommitted" | "base",
  useBaseRepo: boolean,
  provider: "claude" | "codex"
): "uncommitted" | "base" {
  if (useBaseRepo || provider !== "codex" || reviewMode !== "base") {
    return reviewMode;
  }
  try {
    if (!SAFE_REF_REGEX.test(baseBranch)) {
      throw new Error(`Invalid branch name: ${baseBranch}`);
    }
    const headSha = execSync("git rev-parse HEAD", {
      cwd: worktreeDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const mergeBaseResult = spawnSync(
      "git",
      ["merge-base", "HEAD", `origin/${baseBranch}`],
      { cwd: worktreeDir, encoding: "utf-8", timeout: 10_000 }
    );
    const mergeBase = (mergeBaseResult.stdout as string).trim();
    if (mergeBase !== headSha) {
      return reviewMode;
    }
    return applyMergedPrDiff(worktreeDir, ticketId);
  } catch (err) {
    console.warn(
      "[codex-review] Merged PR detection failed, falling back to --base:",
      err
    );
  }
  return reviewMode;
}

function applyMergedPrDiff(
  worktreeDir: string,
  ticketId: string
): "uncommitted" | "base" {
  const prNum = ticketId.replace(PR_PREFIX_REGEX, "");
  if (!/^\d+$/.test(prNum)) {
    throw new Error(`Invalid PR ticket ID: ${ticketId}`);
  }
  console.log(
    "[codex-review] Merged PR detected. Applying gh pr diff for codex."
  );

  const diffResult = spawnSync("gh", ["pr", "diff", prNum], {
    cwd: worktreeDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  const diff = (diffResult.stdout as string) ?? "";

  if (!diff.trim()) {
    console.log(
      "[codex-review] gh pr diff returned empty — PR may have no changes"
    );
    return "base";
  }

  const mergeOidResult = spawnSync(
    "gh",
    ["pr", "view", prNum, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"],
    { cwd: worktreeDir, encoding: "utf-8", timeout: 30_000 }
  );
  const mergeOid = (mergeOidResult.stdout as string).trim();
  if (mergeOid) {
    const baseCommitResult = spawnSync("git", ["rev-parse", `${mergeOid}^1`], {
      cwd: worktreeDir,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const baseCommit = (baseCommitResult.stdout as string).trim();
    if (!baseCommit || baseCommitResult.status !== 0) {
      console.warn(
        "[codex-review] Failed to resolve base commit for merged PR"
      );
      return "base";
    }
    const checkoutResult = spawnSync(
      "git",
      ["checkout", "--detach", baseCommit],
      {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: 10_000,
      }
    );
    if (checkoutResult.status !== 0) {
      console.warn(
        "[codex-review] Failed to checkout base commit:",
        baseCommit
      );
      return "base";
    }
  }

  const patchPath = join(worktreeDir, ".pr-review-diff.patch");
  writeFileSync(patchPath, diff);
  try {
    execSync(`git apply "${patchPath}"`, { cwd: worktreeDir, stdio: "pipe" });
  } finally {
    unlinkSync(patchPath);
  }
  console.log("[codex-review] PR diff applied as uncommitted changes");
  return "uncommitted";
}

async function processClaudeLogLine(
  trimmed: string,
  worktreeDir: string,
  provider: "claude" | "codex",
  sessionIdHolder: { value: string | null }
): Promise<void> {
  try {
    const event = JSON.parse(trimmed);
    const sid = extractClaudeSessionId(event);
    if (sid) {
      sessionIdHolder.value = sid;
    }
    const text = extractClaudeText(event);
    if (text) {
      await appendReviewLog(worktreeDir, provider, text);
    }
  } catch {
    // Non-JSON line — write as-is
    await appendReviewLog(worktreeDir, provider, `${trimmed}\n`);
  }
}

function processClaudeStreamLine(
  trimmed: string,
  sessionIdHolder: { value: string | null } | undefined,
  sendEvent: (data: {
    type: string;
    content?: string;
    exitCode?: number;
    sessionId?: string;
    reviewCommand?: string;
    contextPercent?: number;
  }) => void
): boolean {
  try {
    const event = JSON.parse(trimmed);
    const sid = extractClaudeSessionId(event);
    if (sid && sessionIdHolder) {
      sessionIdHolder.value = sid;
      console.log(`[codex-review] Claude session ID captured: ${sid}`);
      sendEvent({ type: "sessionId", sessionId: sid });
    }

    // Detect context limit / error results (e.g. "Prompt is too long")
    if (event.type === "result" && event.is_error) {
      const errorText =
        typeof event.result === "string"
          ? event.result
          : "Claude encountered an error";
      console.warn(`[codex-review] Claude result error: ${errorText}`);
      sendEvent({ type: "error", content: errorText });
      return true;
    }

    if (event.type === "result") {
      if (event.subtype === "success" && event.usage) {
        const total =
          (event.usage.input_tokens ?? 0) +
          (event.usage.output_tokens ?? 0) +
          (event.usage.cache_creation_input_tokens ?? 0) +
          (event.usage.cache_read_input_tokens ?? 0);
        const contextWindow = event.context_window ?? 200_000;
        const percent =
          contextWindow > 0 ? Math.round((total * 100) / contextWindow) : 0;
        sendEvent({ type: "usage", contextPercent: percent });
      }
      return true;
    }

    const text = extractClaudeText(event);
    if (text) {
      console.log(
        `[codex-review] Claude text extracted (${text.length} chars), event type: ${event.type}`
      );
      sendEvent({ type: "output", content: text });
    } else {
      const detail = describeClaudeEvent(event);
      console.log(`[codex-review] Claude event: ${detail} (no review text)`);
    }
  } catch {
    // Not JSON, pass raw output
    console.log(
      `[codex-review] Claude non-JSON stdout: ${trimmed.slice(0, 200)}`
    );
    sendEvent({ type: "output", content: `${trimmed}\n` });
  }
  return false;
}
