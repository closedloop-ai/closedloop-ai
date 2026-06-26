import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createClaudeCodeShellEnvProvider } from "../server/otel/claude-code-env.js";
import { resolveBinaryFromLoginShell } from "../server/shell-path.js";
import { gatewayLog } from "./gateway-logger.js";
import {
  getOtlpReceiverState,
  toClaudeCodeOtelReceiverStatus,
} from "./otlp-receiver-state.js";

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
const HARNESS_TIMEOUT_MS = 120_000;
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
  Promise<string>
>();

async function runHarnessOnce(
  harness: CoachingHarness,
  input: string
): Promise<string> {
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

  return new Promise<string>((resolve, reject) => {
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

    // Guarantee the process is torn down even if it hangs awaiting input/tools.
    const killTimer = setTimeout(() => {
      gatewayLog.warn(
        LOG_TAG,
        `${harness}: no response after ${HARNESS_TIMEOUT_MS}ms — terminating`
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    }, HARNESS_TIMEOUT_MS);

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
        reject(error);
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
          resolve(stdout);
        });
        return;
      }
      settle(() => {
        gatewayLog.error(
          LOG_TAG,
          `${harness}: exited code ${code} signal ${signal ?? "none"} in ${ms}ms — ${stderr.slice(0, 300)}`
        );
        reject(
          new Error(
            `${harness} exited with code ${code} signal ${signal ?? "none"}: ${stderr.slice(0, 500)}`
          )
        );
      });
    });

    // Close stdin right after sending the prompt so the harness never blocks
    // waiting for an interactive reply — this is a one-shot, non-interactive run.
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** Run the rendered coaching prompt through `claude -p`; return raw stdout. */
export function generateCoachingTips(prompt: string): Promise<string> {
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
 * Hand a user-reviewed draft to the chosen harness and ask it to install the
 * artifact properly (correct location/format) — the harness knows the
 * conventions; we only orchestrate it.
 */
export function installCoachingArtifact(
  draft: string,
  harness: unknown = "claude"
): Promise<string> {
  // Reject any harness the renderer didn't legitimately offer — never spawn an
  // arbitrary binary (e.g. "bash") with the draft as input.
  if (!isCoachingHarness(harness)) {
    return Promise.reject(
      new Error(`unsupported coaching harness: ${String(harness)}`)
    );
  }
  const instruction = [
    "You are installing a coaching artifact into this project for the user.",
    "Create it properly using the correct conventions for its type (skill,",
    "workflow, or prompt) — correct location, file format, and any wiring.",
    "Confirm what you created and where. Do not make unrelated changes.",
    "",
    "--- ARTIFACT ---",
    draft,
  ].join("\n");
  return runHarnessOnce(harness, instruction);
}

function hashCoachingPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
