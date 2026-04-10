import {
  type ChildProcess,
  execSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
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
  DEFAULT_CODEX_MODEL,
  MODEL_ERROR_REGEX,
} from "@/lib/engineer/codex-models";
import { getCodexChatStatePath } from "@/lib/engineer/codex-state";
import { CODEX_SESSION_ID_REGEX } from "@/lib/engineer/process-utils";
import {
  expandHome,
  getWorktreeParentDir,
  isRepoAllowed,
} from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";
import { ensureWorktree } from "@/lib/engineer/worktree";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max for long reviews

const PR_PREFIX_REGEX = /^pr-/;
const SAFE_REF_REGEX = /^[a-zA-Z0-9/_.-]+$/;

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
  const workDir = join(worktreeDir, ".closedloop-ai", "work");
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
  "If you initially suspect an issue but upon further analysis determine it is not actually a problem, omit it from the findings entirely. Only include confirmed issues.",
].join(" ");

async function spawnClaudeReview(
  cwd: string,
  model: string
): Promise<ChildProcess> {
  const shellPath = await getShellPath();
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
        PATH: shellPath,
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
  onModelError?: () => void,
  onProcessClose?: (exitCode: number, errorMessage?: string) => void
) {
  const provider = initialState.provider;
  let stderrText = "";

  // Codex prints its session ID banner to stdout in older versions but to
  // stderr in newer versions (>= 0.118). Scan both channels with one shared
  // 2KB buffer until found. Set BEFORE any await so createCodexStream sees
  // the value in the same event-loop tick.
  let codexStartupBuffer = "";
  let codexSessionIdCaptured = false;
  const tryCaptureCodexSessionId = (text: string): void => {
    if (codexSessionIdCaptured) {
      return;
    }
    codexStartupBuffer += text;
    const match = CODEX_SESSION_ID_REGEX.exec(codexStartupBuffer);
    if (match) {
      sessionIdHolder.value = match[1];
      codexSessionIdCaptured = true;
      codexStartupBuffer = "";
      console.log(`[codex-review] Codex session ID captured: ${match[1]}`);
    } else if (codexStartupBuffer.length > 2048) {
      codexSessionIdCaptured = true;
      codexStartupBuffer = "";
    }
  };

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
    childProcess.stdout?.on("data", async (data: Buffer) => {
      const text = data.toString();
      tryCaptureCodexSessionId(text);
      await appendReviewLog(worktreeDir, provider, text);
    });
  }

  childProcess.stderr?.on("data", async (data: Buffer) => {
    const text = data.toString();
    if (provider === "codex") {
      tryCaptureCodexSessionId(text);
    }
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

    // Bridge code-review skill findings to review-findings-claude.json
    if (provider === "claude" && code === 0) {
      await bridgeSkillFindings(
        worktreeDir,
        initialState.config.model,
        initialState.startedAt
      ).catch((err) =>
        console.warn("[codex-review] bridgeSkillFindings failed:", err)
      );
    }

    // Persist Codex session ID to codex-chat-review.json so the chat route can resume it
    if (provider === "codex" && sessionIdHolder.value) {
      const workDir = join(worktreeDir, ".closedloop-ai", "work");
      const chatStatePath = getCodexChatStatePath(workDir, "review");
      await mkdir(workDir, { recursive: true });
      await writeFile(
        chatStatePath,
        JSON.stringify(
          { sessionId: sessionIdHolder.value, messageCount: 0 },
          null,
          2
        )
      );
      console.log(
        `[codex-review] Wrote ${chatStatePath} with session ${sessionIdHolder.value}`
      );
    }

    // Notify stream after state file is written (Claude path only)
    onProcessClose?.(code ?? 1);
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
    if (existsSync(pidPath)) {
      await unlink(pidPath).catch(() => {});
    }
    // Notify stream after state file is written (Claude path only)
    onProcessClose?.(1, err.message);
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

      // Emit sessionId event once when setupProcessLifecycle has captured it.
      // The banner can arrive on stdout (older codex) or stderr (>= 0.118),
      // so check from both listeners.
      const maybeEmitSessionId = (): void => {
        if (!sessionIdEmitted && sessionIdHolder.value) {
          sessionIdEmitted = true;
          sendEvent({ type: "sessionId", sessionId: sessionIdHolder.value });
        }
      };

      childProcess.stdout?.on("data", (data: Buffer) => {
        console.log(`[codex-stream] stdout data: ${data.length} bytes`);
        maybeEmitSessionId();
        sendEvent({ type: "output", content: data.toString() });
      });

      childProcess.stderr?.on("data", (data: Buffer) => {
        console.log(`[codex-stream] stderr data: ${data.length} bytes`);
        maybeEmitSessionId();
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

type ClaudeStreamControls = {
  sendDone: (exitCode: number) => void;
  sendError: (exitCode: number, errorMessage: string) => void;
};

function createClaudeStream(
  childProcess: ChildProcess,
  sessionIdHolder?: { value: string | null },
  reviewCommand?: string
): { stream: ReadableStream; controls: ClaudeStreamControls } {
  const encoder = new TextEncoder();
  let sendDoneRef: ((exitCode: number) => void) | null = null;
  let sendErrorRef: ((exitCode: number, msg: string) => void) | null = null;
  let pendingDone: { exitCode: number; errorMessage?: string } | null = null;
  let terminalSent = false;

  const controls: ClaudeStreamControls = {
    sendDone: (code: number) => {
      if (terminalSent) {
        return;
      }
      if (sendDoneRef) {
        sendDoneRef(code);
      } else {
        pendingDone = { exitCode: code };
      }
    },
    sendError: (code: number, errorMessage: string) => {
      if (terminalSent) {
        return;
      }
      if (sendErrorRef) {
        sendErrorRef(code, errorMessage);
      } else {
        pendingDone = { exitCode: code, errorMessage };
      }
    },
  };

  const stream = new ReadableStream({
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
        terminal?: boolean;
        error?: string;
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

      // Flush remaining stdout buffer and emit a terminal frame
      const flushBufferAndSendTerminal = (exitCode: number) => {
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
          buffer = "";
        }
        sendEvent({ type: "done", exitCode });
        closeController();
      };

      // Wire up the refs for lifecycle-driven terminal events
      sendDoneRef = (exitCode: number) => {
        if (terminalSent) {
          return;
        }
        terminalSent = true;
        flushBufferAndSendTerminal(exitCode);
      };

      sendErrorRef = (exitCode: number, errorMessage: string) => {
        if (terminalSent) {
          return;
        }
        terminalSent = true;
        sendEvent({
          type: "error",
          terminal: true,
          error: errorMessage,
        });
        closeController();
      };

      // Flush any buffered terminal signal from lifecycle firing before start()
      if (pendingDone !== null) {
        if (pendingDone.errorMessage) {
          sendErrorRef(pendingDone.exitCode, pendingDone.errorMessage);
        } else {
          sendDoneRef(pendingDone.exitCode);
        }
      }

      // No close/error listeners here -- terminal events are driven by
      // setupProcessLifecycle via onProcessClose after state file is written.
    },
    cancel() {
      console.log(
        "[codex-review] Client disconnected, review continues in background"
      );
    },
  });

  return { stream, controls };
}

/**
 * Try spawning Claude with /code-review:start skill first.
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
  provider: string,
  rawBaseBranch: string
): Promise<{ process: ChildProcess; command: string }> {
  const first = await spawnClaudeReview(cwd, model);
  // The skill's resolve-scope prepends origin/ to --base internally,
  // so pass the raw branch name (not the remote ref).
  first.stdin?.write(`/code-review:start --base ${rawBaseBranch}`);
  first.stdin?.end();
  console.log(
    `[codex-review] Trying /code-review:start --base ${rawBaseBranch} (pid: ${first.pid})`
  );

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
    console.log("[codex-review] /code-review:start is producing output");
    // Put consumed probe data back in reverse order so stream consumers see it
    for (const chunk of probeChunks.reverse()) {
      first.stdout?.unshift(chunk);
    }
    return { process: first, command: "/code-review:start" };
  }

  console.log(
    `[codex-review] /code-review:start exited (code: ${result.code}) without producing review content, falling back to /review ${prNum}`
  );
  await clearReviewLog(stateDir, provider);

  const fallback = await spawnClaudeReview(cwd, model);
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
  const { pidPath, statePath: readStatePath } = getReviewPaths(
    worktreeDir,
    provider
  );
  if (await checkForRunningReview(readStatePath)) {
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

  // Use the remote tracking ref so the diff matches what GitHub sees, even if
  // the local base branch is stale. ensureWorktree already calls fetchOrigin.
  const remoteBaseBranch = baseBranch.startsWith("origin/")
    ? baseBranch
    : `origin/${baseBranch}`;

  console.log(`[codex-review] Starting ${provider} review for ${ticketId}`, {
    model,
    reviewMode: effectiveReviewMode,
    worktreeDir,
    reviewCwd,
    useBaseRepo,
    baseBranch: remoteBaseBranch,
  });

  // Clear previous log and stale findings
  await clearReviewLog(worktreeDir, provider);
  const { workDir: clearWorkDir } = getReviewPaths(worktreeDir, provider);
  await unlink(join(clearWorkDir, `review-findings-${provider}.json`)).catch(
    () => {}
  );

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
      provider,
      baseBranch
    );
    childProcess = resolved.process;
    reviewCommand = resolved.command;
  } else {
    childProcess = spawnCodexReview(
      reviewCwd,
      model,
      reasoningEffort,
      effectiveReviewMode,
      remoteBaseBranch,
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
  //
  // Uses synchronous writes (writeFileSync) so the status endpoint immediately
  // sees "running" with the new PID — prevents the poller from catching a gap
  // between the original process exiting and the fallback state being written.
  const { statePath: reviewStatePath, logPath: reviewLogPath } = getReviewPaths(
    worktreeDir,
    provider
  );
  const modelFallbackHandler =
    provider === "codex" && model !== DEFAULT_CODEX_MODEL
      ? () => {
          console.log(
            `[codex-review] Re-spawning review with fallback model ${DEFAULT_CODEX_MODEL}`
          );
          // Synchronous writes to close the race window with the status poller
          // and ensure the log is clean before the fallback process starts writing
          mkdirSync(join(worktreeDir, ".closedloop-ai", "work"), {
            recursive: true,
          });
          writeFileSync(
            reviewLogPath,
            `[Model ${model} unavailable — fell back to ${DEFAULT_CODEX_MODEL}]\n\n`
          );
          const fallbackProcess = spawnCodexReview(
            reviewCwd,
            DEFAULT_CODEX_MODEL,
            reasoningEffort,
            effectiveReviewMode,
            remoteBaseBranch,
            instructions
          );
          const fallbackState: ReviewState = {
            ...initialState,
            pid: fallbackProcess.pid,
            config: { ...initialState.config, model: DEFAULT_CODEX_MODEL },
          };
          writeFileSync(
            reviewStatePath,
            JSON.stringify(fallbackState, null, 2)
          );
          if (fallbackProcess.pid) {
            writeFileSync(pidPath, String(fallbackProcess.pid));
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
        }
      : undefined;

  // Create the Claude stream + controls before lifecycle setup so onProcessClose
  // can route terminal events through the stream after the state file is written.
  let claudeStream: ReadableStream | undefined;
  let claudeControls: ClaudeStreamControls | undefined;
  if (provider === "claude") {
    const result = createClaudeStream(
      childProcess,
      sessionIdHolder,
      reviewCommand
    );
    claudeStream = result.stream;
    claudeControls = result.controls;
  }

  // Build the onProcessClose callback for Claude -- captures controls ref
  const onProcessClose:
    | ((exitCode: number, errorMessage?: string) => void)
    | undefined = claudeControls
    ? (exitCode, errorMessage) => {
        if (errorMessage) {
          claudeControls!.sendError(exitCode, errorMessage);
        } else {
          claudeControls!.sendDone(exitCode);
        }
      }
    : undefined;

  // Set up lifecycle handlers (log capture, state updates on close/error)
  setupProcessLifecycle(
    childProcess,
    worktreeDir,
    initialState,
    pidPath,
    sessionIdHolder,
    modelFallbackHandler,
    onProcessClose
  );

  // Create the appropriate streaming response
  const stream =
    claudeStream ?? createCodexStream(childProcess, sessionIdHolder);

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

type SkillFinding = {
  file?: string;
  line?: number;
  severity?: string;
  issue?: string;
  explanation?: string;
  recommendation?: string;
  priority?: number;
};

function skillSeverityToLevel(
  severity: string
): "critical" | "warning" | "info" {
  const upper = severity.toUpperCase();
  if (upper === "CRITICAL" || upper === "HIGH") {
    return "critical";
  }
  if (upper === "MEDIUM") {
    return "warning";
  }
  return "info";
}

function skillPriorityToLabel(priority: number): string {
  return `P${priority}`;
}

/**
 * Bridge code-review skill findings to review-findings-claude.json so the
 * UI can display them. The skill writes validated findings to
 * .closedloop-ai/code-review/cr-{id}/validate_output.json but the UI reads
 * from .closedloop-ai/work/review-findings-claude.json.
 */
async function bridgeSkillFindings(
  worktreeDir: string,
  model: string,
  startedAt: string
): Promise<void> {
  const runStartMs = new Date(startedAt).getTime();
  const codeReviewDir = join(worktreeDir, ".closedloop-ai", "code-review");
  if (!existsSync(codeReviewDir)) {
    return;
  }

  // Find the most recent cr-* directory with a validate_output.json
  let entries: string[];
  try {
    entries = await readdir(codeReviewDir);
  } catch {
    return;
  }

  const crDirs = entries.filter((e) => e.startsWith("cr-"));
  if (crDirs.length === 0) {
    return;
  }

  // Pick the most recently modified cr-* directory whose validate_output.json
  // was written during or after the current review run. This prevents importing
  // stale findings from a previous run.
  let bestDir: string | null = null;
  let bestMtime = 0;
  for (const dir of crDirs) {
    const validatePath = join(codeReviewDir, dir, "validate_output.json");
    if (!existsSync(validatePath)) {
      continue;
    }
    try {
      const stats = await stat(validatePath);
      if (stats.mtimeMs < runStartMs) {
        continue;
      }
      if (stats.mtimeMs > bestMtime) {
        bestMtime = stats.mtimeMs;
        bestDir = dir;
      }
    } catch {
      // skip inaccessible entries
    }
  }

  if (!bestDir) {
    return;
  }

  const validatePath = join(codeReviewDir, bestDir, "validate_output.json");
  try {
    const raw = await readFile(validatePath, "utf-8");
    const data = JSON.parse(raw) as { validated?: SkillFinding[] };
    const validated = data.validated;
    if (!Array.isArray(validated) || validated.length === 0) {
      // Write empty findings to overwrite any stale file from a prior review
      const emptyWorkDir = join(worktreeDir, ".closedloop-ai", "work");
      await mkdir(emptyWorkDir, { recursive: true });
      const emptyOutPath = join(emptyWorkDir, "review-findings-claude.json");
      await writeFile(
        emptyOutPath,
        JSON.stringify({ provider: "claude", model, findings: [] }, null, 2)
      );
      return;
    }

    const findings = validated.map((f) => {
      const severity = skillSeverityToLevel(f.severity ?? "LOW");
      const priority = f.priority
        ? skillPriorityToLabel(f.priority)
        : undefined;
      // Strip leading [P*] tag from issue title if present
      const issueClean = (f.issue ?? "").replace(/^\[P\d\]\s*/, "");
      const message = f.explanation
        ? `${issueClean}\n${f.explanation}`
        : issueClean;
      return {
        severity,
        priority,
        file: f.file,
        line: f.line,
        message,
        suggestion: f.recommendation,
        commented: false,
      };
    });

    const findingsFile = {
      provider: "claude",
      model,
      findings,
    };

    const workDir = join(worktreeDir, ".closedloop-ai", "work");
    await mkdir(workDir, { recursive: true });
    const outPath = join(workDir, "review-findings-claude.json");
    await writeFile(outPath, JSON.stringify(findingsFile, null, 2));
    console.log(
      `[codex-review] Bridged ${findings.length} skill findings from ${bestDir} to review-findings-claude.json`
    );
  } catch (err) {
    console.warn("[codex-review] Failed to bridge skill findings:", err);
  }
}
