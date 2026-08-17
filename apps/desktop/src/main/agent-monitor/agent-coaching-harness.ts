import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createClaudeCodeShellEnvProvider } from "../../server/otel/claude-code-env.js";
import { resolveBinaryFromLoginShell } from "../../server/shell-path.js";
import type { CoachingHarnessResult } from "../../shared/coaching-pack-contract.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  getOtlpReceiverState,
  toClaudeCodeOtelReceiverStatus,
} from "../telemetry/otlp-receiver-state.js";
import { installCoachingSkillArtifact } from "./agent-coaching-skill-install.js";

/**
 * Which Apply path resolves a coaching recommendation (FEA-3687 #4). Mirrors
 * the renderer's `AgentCoachingApplyKind` — kept as a runtime-validated string
 * literal here (the IPC value is untrusted). `create-new-file` installs a single
 * new skill `.md` deterministically; `edit-existing` runs the LLM-driven,
 * reviewable harness edit across existing `.claude/*` files.
 */
export type CoachingApplyKind = "create-new-file" | "edit-existing";
const DEFAULT_APPLY_KIND: CoachingApplyKind = "create-new-file";

function resolveApplyKind(value: unknown): CoachingApplyKind {
  return value === "edit-existing" || value === "create-new-file"
    ? value
    : DEFAULT_APPLY_KIND;
}

/** `~/.claude/skills` (honoring the `CLAUDE_HOME` override), where a new skill lands. */
function resolveClaudeSkillsDir(): string {
  const home = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, "skills");
}

const LOG_TAG = "agent-coaching";

/**
 * Coaching generation and "install this artifact" both run through the user's
 * LOCAL agent harness — no cloud. Generation always uses `claude -p`; install
 * uses whichever harness the user picks (defaulting to claude), reusing the same
 * one-shot spawn. The binary is resolved from the login shell PATH so it matches
 * how the Engineer feature locates CLIs.
 */
const COACHING_HARNESSES = ["claude", "codex", "opencode"] as const;
export type CoachingHarness = (typeof COACHING_HARNESSES)[number];

/**
 * Validate a renderer-supplied harness BEFORE it reaches `spawn`. The TypeScript
 * annotation is erased at runtime, so without this a malicious/buggy renderer
 * could pass e.g. `"bash"` and have us execute the draft as a shell command.
 */
function isCoachingHarness(value: unknown): value is CoachingHarness {
  return (
    typeof value === "string" &&
    (COACHING_HARNESSES as readonly string[]).includes(value)
  );
}

const MAX_OUTPUT_BYTES = 1_000_000;
// Hard backstop for a process that never produces output at all.
//
// `claude -p` BUFFERS its whole answer and only writes stdout once it finishes —
// it is not streaming without `--output-format stream-json`. So a real coaching
// generation (large grounded prompt, high-reasoning intent) can legitimately run
// for minutes before ANY stdout appears, and the old 120s backstop killed it
// mid-generation (SIGTERM → non-zero exit → rejected promise → "Error occurred
// in handler"). Give it a realistic ceiling; it stays overridable for slower
// machines/models. This is only the backstop — the process still exits promptly
// on its own the instant it finishes.
const DEFAULT_HARNESS_TIMEOUT_MS = 300_000;
// Read lazily per-run (not once at module load) so an env override applied after
// import — e.g. in tests, or set by the app at runtime — actually takes effect.
function resolveHarnessTimeoutMs(): number {
  return (
    Number(process.env.CLOSEDLOOP_COACHING_HARNESS_TIMEOUT_MS) ||
    DEFAULT_HARNESS_TIMEOUT_MS
  );
}

// Re-export the shared contract type from its canonical home so callers of the
// harness (IPC handler, tests) can import it alongside the functions below.
export type { CoachingHarnessResult } from "../../shared/coaching-pack-contract.js";

// Once the harness has finished writing its answer (stdout EOF), give it this
// long to exit on its own; if it lingers we SIGTERM it so the session it opened
// (via the user's SessionStart hook) gets its matching Stop and closes out.
const EXIT_AFTER_OUTPUT_MS = 4000;
const KILL_GRACE_MS = 2000;
// Per-harness headless/print invocation. Prompt is delivered on stdin, which we
// close immediately so the harness never blocks waiting for more input. Hooks
// stay enabled so the spawn is tracked as a normal session that opens and (once
// it exits below) closes.
const HARNESS_ARGS: Record<CoachingHarness, string[]> = {
  claude: ["-p"],
  codex: ["exec", "-"],
  opencode: ["run", "-"],
};
const getCoachingClaudeCodeShellEnv = createClaudeCodeShellEnvProvider({
  getReceiverStatus: () =>
    toClaudeCodeOtelReceiverStatus(getOtlpReceiverState()),
  diagnostics: gatewayLog,
});

const activeGenerateCoachingTipsByPromptHash = new Map<
  string,
  Promise<CoachingHarnessResult>
>();

async function runHarnessOnce(
  harness: CoachingHarness,
  input: string
): Promise<CoachingHarnessResult> {
  // Resolve env + binary asynchronously — the sync resolver runs a login shell
  // on the main process and would freeze the UI during generation (worse with
  // the multi-round startup fill).
  const env = await getCoachingClaudeCodeShellEnv();
  const { path, source } = await resolveBinaryFromLoginShell(harness);
  const startedAt = Date.now();
  gatewayLog.info(
    LOG_TAG,
    `${harness}: launching (${path}, resolved via ${source}, ${input.length}-char prompt)`
  );
  if (source === "fallback") {
    gatewayLog.warn(
      LOG_TAG,
      `${harness}: binary not found on PATH — spawn will likely fail (ENOENT)`
    );
  }

  const timeoutMs = resolveHarnessTimeoutMs();
  return new Promise<CoachingHarnessResult>((resolve) => {
    const child = spawn(path, HARNESS_ARGS[harness], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // `child.killed` only reflects that a signal was *sent*, not that the process
    // exited — so SIGKILL fallbacks must gate on the real `close` event instead.
    let closed = false;
    let exitTimer: NodeJS.Timeout | null = null;
    // True when we terminated the harness ourselves AFTER it produced output —
    // that's a success (we have the tip), not a failure.
    let exitedAfterOutput = false;
    // True when the hard backstop fired with NO output — the `close` that follows
    // is our SIGTERM, so we report it as a structured timeout, not a spawn crash.
    let timedOut = false;

    // Guarantee the process is torn down even if it hangs awaiting input/tools.
    const killTimer = setTimeout(() => {
      timedOut = true;
      gatewayLog.warn(
        LOG_TAG,
        `${harness}: no response after ${timeoutMs}ms — terminating`
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      if (exitTimer) {
        clearTimeout(exitTimer);
      }
      action();
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    // The harness has finished writing its answer — we have the tip. Let it exit
    // on its own briefly (so it fires its own Stop hook and closes the session);
    // if it lingers, terminate it so the session doesn't stay open.
    child.stdout?.on("end", () => {
      if (settled || exitTimer) {
        return;
      }
      exitTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        exitedAfterOutput = true;
        gatewayLog.info(
          LOG_TAG,
          `${harness}: tip received; ending the session`
        );
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!closed) {
            child.kill("SIGKILL");
          }
        }, KILL_GRACE_MS);
      }, EXIT_AFTER_OUTPUT_MS);
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() => {
        gatewayLog.error(LOG_TAG, `${harness}: spawn error — ${error.message}`);
        resolve({
          ok: false,
          reason: "spawn_failed",
          message: `${harness} failed to start: ${error.message}`,
        });
      });
    });
    child.on("close", (code, signal) => {
      closed = true;
      const ms = Date.now() - startedAt;
      // Success if it exited cleanly, OR if we terminated it after it already
      // produced output (we have the tip; the non-zero/signal exit is ours).
      if (code === 0 || exitedAfterOutput) {
        settle(() => {
          gatewayLog.info(
            LOG_TAG,
            `${harness}: done in ${ms}ms (${stdout.length} chars of output, signal ${signal ?? "none"})`
          );
          resolve({ ok: true, output: stdout });
        });
        return;
      }
      // The backstop fired with no output — a structured timeout, not a crash.
      if (timedOut) {
        settle(() => {
          gatewayLog.warn(
            LOG_TAG,
            `${harness}: produced no output within ${timeoutMs}ms (exited code ${code} signal ${signal ?? "none"} in ${ms}ms)`
          );
          resolve({
            ok: false,
            reason: "timeout",
            message: `${harness} produced no output within ${timeoutMs}ms`,
          });
        });
        return;
      }
      settle(() => {
        gatewayLog.error(
          LOG_TAG,
          `${harness}: exited code ${code} signal ${signal ?? "none"} in ${ms}ms — ${stderr.slice(0, 300)}`
        );
        resolve({
          ok: false,
          reason: "nonzero_exit",
          message: `${harness} exited with code ${code} signal ${signal ?? "none"}: ${stderr.slice(0, 500)}`,
        });
      });
    });

    // Close stdin right after sending the prompt so the harness never blocks
    // waiting for an interactive reply — this is a one-shot, non-interactive run.
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/**
 * Run the rendered coaching prompt through `claude -p`. Resolves to a structured
 * result — never rejects for an operational failure — so the IPC handler can hand
 * the renderer a clean outcome instead of throwing an unhandled handler error.
 */
export function generateCoachingTips(
  prompt: string
): Promise<CoachingHarnessResult> {
  const promptHash = hashCoachingPrompt(prompt);
  const activeGenerateCoachingTips =
    activeGenerateCoachingTipsByPromptHash.get(promptHash);
  if (activeGenerateCoachingTips) {
    gatewayLog.info(
      LOG_TAG,
      "claude: joining in-flight coaching generation for matching prompt"
    );
    return activeGenerateCoachingTips;
  }
  const pending = runHarnessOnce("claude", prompt).finally(() => {
    if (activeGenerateCoachingTipsByPromptHash.get(promptHash) === pending) {
      activeGenerateCoachingTipsByPromptHash.delete(promptHash);
    }
  });
  activeGenerateCoachingTipsByPromptHash.set(promptHash, pending);
  return pending;
}

/**
 * Install a user-reviewed coaching draft, dispatched by recommendation kind
 * (FEA-3687 #3/#4):
 *
 * - `create-new-file` (default): the artifact IS a single new skill and its
 *   content is already the reviewed draft — install it DETERMINISTICALLY as a
 *   valid `~/.claude/skills/<slug>/SKILL.md` (correct location + frontmatter),
 *   and confirm the created path. No harness spawn, no "install this properly"
 *   guessing, so a valid `.md` reliably lands in the right place.
 * - `edit-existing`: the fix must change EXISTING `.claude/*` files (an
 *   LLM-driven, multi-file edit that needs reasoning over the current files) —
 *   this still runs through the chosen harness, which is instructed to make a
 *   reviewable, scoped edit and confirm what it changed.
 *
 * `harness` is only consulted for the `edit-existing` path and is validated
 * before any spawn so an untrusted renderer can never run an arbitrary binary.
 */
export function installCoachingArtifact(
  draft: string,
  harness: unknown = "claude",
  kind: unknown = DEFAULT_APPLY_KIND
): Promise<CoachingHarnessResult> {
  const applyKind = resolveApplyKind(kind);
  if (applyKind === "create-new-file") {
    // Deterministic — no harness. The draft already contains the full skill
    // content the user reviewed; write it to the right place with frontmatter.
    return Promise.resolve(
      installCoachingSkillArtifact(draft, resolveClaudeSkillsDir())
    );
  }
  // edit-existing: reason over the user's existing `.claude/*` files.
  // Reject any harness the renderer didn't legitimately offer — never spawn an
  // arbitrary binary (e.g. "bash") with the draft as input.
  if (!isCoachingHarness(harness)) {
    return Promise.resolve({
      ok: false,
      reason: "spawn_failed",
      message: `unsupported coaching harness: ${String(harness)}`,
    });
  }
  const instruction = [
    "You are applying a coaching recommendation that edits this project's",
    "EXISTING .claude/* files (skills, agents, commands, or workflows) for the",
    "user. Make the smallest reviewable change that implements the",
    "recommendation below, editing the relevant existing files in place — do NOT",
    "just drop a new file, and do NOT make unrelated changes. Show a concise diff",
    "of what you changed and confirm the files touched.",
    "",
    "--- RECOMMENDATION ---",
    draft,
  ].join("\n");
  return runHarnessOnce(harness, instruction);
}

function hashCoachingPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
