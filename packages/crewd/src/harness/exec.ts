/** Low-level child-process runner shared by every harness driver. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RunOpts, RunResult } from "./types.js";

const TAIL_BYTES = 4096;
const DEFAULT_KILL_AFTER_MS = 120_000;

/**
 * Inline a prompt + attached files into a single stdin payload, matching the
 * legacy bash: prompt, then each file under a `--- FILE: <path> ---` banner.
 * Used by claude/codex which have no `--file` flag.
 */
export function inlineStdin(prompt: string, files: string[] = []): string {
  let out = `${prompt}\n\n`;
  for (const f of files) {
    let body = "";
    try {
      body = readFileSync(f, "utf8");
    } catch {
      body = `(could not read ${f})`;
    }
    out += `\n\n--- FILE: ${f} ---\n${body}`;
  }
  return out;
}

export type SpawnSpec = {
  command: string;
  args: string[];
  /** Text piped to the child's stdin. */
  stdin: string;
};

/**
 * Run a command with a stdin payload, streaming output to `onOutput`, enforcing
 * a wall-clock timeout with SIGTERM→(killAfter)→SIGKILL escalation. Never throws
 * for a nonzero exit; reports it in the result.
 */
export function runProcess(spec: SpawnSpec, opts: RunOpts): Promise<RunResult> {
  const start = Date.now();
  const killAfter = opts.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  let tail = "";
  let timedOut = false;
  let hardKillTimer: NodeJS.Timeout | undefined;
  let softKillTimer: NodeJS.Timeout | undefined;

  const capture = (buf: Buffer | string) => {
    const s = typeof buf === "string" ? buf : buf.toString("utf8");
    opts.onOutput?.(s);
    tail = (tail + s).slice(-TAIL_BYTES);
  };

  return new Promise<RunResult>((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (res: Omit<RunResult, "durationMs" | "outputTail">) => {
      if (softKillTimer) {
        clearTimeout(softKillTimer);
      }
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ...res, durationMs: Date.now() - start, outputTail: tail });
    };

    const onAbort = () => {
      timedOut = false;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("error", (err) => {
      capture(`\n[crewd] spawn error: ${err.message}\n`);
      finish({ ok: false, exitCode: null, signal: null, timedOut: false });
    });

    child.on("close", (code, signal) => {
      const ok = code === 0 && !timedOut;
      finish({ ok, exitCode: code, signal: signal ?? null, timedOut });
    });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      softKillTimer = setTimeout(() => {
        timedOut = true;
        capture(`\n[crewd] timeout after ${opts.timeoutMs}ms — SIGTERM\n`);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        hardKillTimer = setTimeout(() => {
          capture(
            `\n[crewd] still alive ${killAfter}ms after SIGTERM — SIGKILL\n`
          );
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, killAfter);
      }, opts.timeoutMs);
    }

    // Feed stdin. A child that exits (or closes stdin) before we finish writing
    // makes the pipe emit an 'error' (EPIPE); unhandled, that error crashes the
    // daemon. Swallow the broken-pipe error and guard the write/end — the run's
    // outcome is still reported via the 'close'/'error' handlers above.
    child.stdin.on("error", () => {
      /* broken pipe — the child went away before consuming stdin */
    });
    try {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    } catch {
      /* stdin already destroyed — nothing to feed */
    }
  });
}

/** Is a binary resolvable on PATH? (best-effort, non-throwing) */
export function onPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe =
      process.platform === "win32"
        ? spawn("where", [command])
        : spawn("/bin/sh", ["-c", `command -v ${command}`]);
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}
