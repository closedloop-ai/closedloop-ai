/**
 * @file install-orchestrator.ts
 * @description Spawns install / uninstall subprocesses for catalog packs and
 * streams output to the renderer via Electron IPC. Every run is recorded in
 * `pack_install_runs` for audit. After a successful install/uninstall the
 * caller's onComplete hook fires so the pack scanner can rescan.
 *
 * Ported from the old sidecar's install-orchestrator.js + catalog-action-handler.js
 * into a single first-party Electron ESM module.
 *
 * Safeguards:
 *  - Hard timeout (default 10 min) — subprocess killed if it overruns
 *  - Concurrent-install guard: refuses if a run for the same pack is still
 *    in-flight (ended_at IS NULL)
 *  - ANSI escape codes stripped from stored tails (full output stays in the
 *    live IPC stream)
 *  - Security-hardened minimal env for child processes (no leaked tokens)
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import {
  type BinaryName,
  getShellPathSync,
  resolveExecutablesOnPathSync,
} from "../../server/shell-path.js";
import type { CatalogEntry } from "../../shared/agent-db-contract.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { stripAnsi } from "../diagnostics-helpers.js";
import { gatewayLog } from "../gateway-logger.js";
import {
  getCatalog,
  inFlightInstallRun,
  recordInstallRunEnd,
  recordInstallRunStart,
} from "./catalog-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TAIL_BYTES = 4096;

const TRUSTED_ACTION_HEADER = "x-agent-dashboard-trusted-action";
const TRUSTED_ACTION_VALUE = "catalog-mutate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallOutputChunk = {
  runId: number;
  type:
    | "start"
    | "stdout"
    | "stderr"
    | "error"
    | "post_install"
    | "copy_command"
    | "complete";
  data: unknown;
};

export type StreamRunOptions = {
  pack_id: string;
  harness: string;
  action: "install" | "uninstall";
  cwd?: string;
  getWindow: () => BrowserWindow | null;
  onComplete?: (result: { exit_code: number; killed: boolean }) => void;
  timeoutMs?: number;
};

export type StreamRunResult = {
  started: boolean;
  runId?: number;
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// Tail helpers (ANSI stripping uses the canonical stripAnsi from
// diagnostics-helpers, which also handles 8-bit CSI sequences)
// ---------------------------------------------------------------------------

function tailBytes(buffer: string): string | null {
  if (!buffer) {
    return null;
  }
  const stripped = stripAnsi(buffer);
  if (stripped.length <= TAIL_BYTES) {
    return stripped;
  }
  return `\u2026${stripped.slice(stripped.length - TAIL_BYTES)}`;
}

// ---------------------------------------------------------------------------
// IPC send helper (replaces SSE)
// ---------------------------------------------------------------------------

function sendIpc(
  getWindow: () => BrowserWindow | null,
  runId: number,
  type: InstallOutputChunk["type"],
  data: unknown
): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  const chunk: InstallOutputChunk = { runId, type, data };
  win.webContents.send("desktop:pack:install-output", chunk);
}

// ---------------------------------------------------------------------------
// Environment & CWD helpers
// ---------------------------------------------------------------------------

/**
 * Minimal env passed to child install processes.
 *
 * Only an allowlist of variables needed for sane CLI execution (PATH for
 * binary lookup, HOME / USER for ~/ expansion, LANG / TERM for proper
 * rendering, SHELL for `sh -c`) is passed through. Callers that already
 * resolved a shell PATH can pass `pathOverride` so command selection and child
 * execution use the same lookup path. A malicious or compromised catalog entry
 * cannot exfiltrate Closedloop tokens, PostHog keys, API keys, or shell
 * credentials.
 */
export function buildAllowedChildEnv(
  parentEnv: Record<string, string | undefined> = process.env,
  cwd: string | null = null,
  pathOverride: string | null = null
): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "HOMEBREW_REPOSITORY",
    "PYTHONUNBUFFERED",
  ];
  const out: Record<string, string> = {};
  const childPath =
    typeof pathOverride === "string" && pathOverride.length > 0
      ? pathOverride
      : parentEnv.PATH;
  for (const key of allowed) {
    const val = key === "PATH" ? childPath : parentEnv[key];
    if (typeof val === "string" && val.length > 0) {
      out[key] = val;
    }
  }
  if (!out.HOME) {
    out.HOME = homedir();
  }
  if (cwd) {
    out.INIT_CWD = cwd;
    out.PWD = cwd;
  }
  return out;
}

/**
 * Heuristic for catalog commands that operate on the current directory and
 * must NOT be run without an explicit, validated project cwd. Only matches
 * unambiguous "writes to cwd" signals:
 *   --directory .   (npx-style)
 *   --directory=.   (gnu-arg-style)
 *    -C .           (make / git -C style)
 */
const PROJECT_RELATIVE_HINTS = ["--directory .", "--directory=.", " -C ."];

export function looksProjectRelative(command: string): boolean {
  if (typeof command !== "string") {
    return false;
  }
  return PROJECT_RELATIVE_HINTS.some((hint) => command.includes(hint));
}

/**
 * Validate and resolve a requested CWD for subprocess spawning.
 * Throws with `.code = "EBADCWD"` on invalid input.
 */
export function resolveSpawnCwd(
  requestedCwd: string | undefined | null
): string | null {
  if (typeof requestedCwd !== "string" || requestedCwd.trim().length === 0) {
    return null;
  }

  const trimmed = requestedCwd.trim();
  if (!path.isAbsolute(trimmed)) {
    const err = new Error("cwd must be an absolute path") as Error & {
      code: string;
    };
    err.code = "EBADCWD";
    throw err;
  }

  const abs = path.resolve(trimmed);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch {
    const err = new Error(`cwd does not exist: ${abs}`) as Error & {
      code: string;
    };
    err.code = "EBADCWD";
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`not a directory: ${abs}`) as Error & {
      code: string;
    };
    err.code = "EBADCWD";
    throw err;
  }
  if (abs === "/" || abs === path.parse(abs).root) {
    const err = new Error("refusing to spawn at filesystem root") as Error & {
      code: string;
    };
    err.code = "EBADCWD";
    throw err;
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Harness detection
// ---------------------------------------------------------------------------

const HARNESS_CLI_BINARIES: Record<string, BinaryName> = {
  claude: "claude",
  codex: "codex",
};

/**
 * Probe whether a harness CLI is installed on PATH. Used by `single_install`
 * packs so we install only for the harnesses the user actually has. Reads
 * `childEnv.PATH` so detection stays consistent with install subprocess lookup.
 * Best-effort and short-timeout — never blocks long.
 */
export function isHarnessInstalled(
  harness: string,
  childEnv: Record<string, string | undefined> = buildAllowedChildEnv(
    process.env,
    null,
    getShellPathSync()
  )
): boolean {
  const bin = HARNESS_CLI_BINARIES[harness];
  if (!bin) {
    return false;
  }
  try {
    return resolveExecutablesOnPathSync(bin, childEnv.PATH ?? "").length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command selection for single_install packs
// ---------------------------------------------------------------------------

/**
 * Join independent cleanup commands so each runs regardless of whether
 * prior ones fail, but the aggregate exit code reflects any failure.
 */
export function joinIndependentCleanupCommands(commands: string[]): string {
  const failureVar = "__closedloop_uninstall_failed";
  return [
    `${failureVar}=0`,
    ...commands.map(
      (command) => `if ! ( ${command} ); then ${failureVar}=1; fi`
    ),
    `exit $${failureVar}`,
  ].join("; ");
}

/**
 * For `single_install` packs (gstack), pick the command to run for install
 * or uninstall.
 *
 * INSTALL — pick the SUPERSET command. By convention the codex install
 * command is a superset of the claude install command. Running it once
 * installs for all detected CLIs.
 *
 * UNINSTALL — run all uninstall commands independently but aggregate
 * failures. Runs for ALL listed harnesses (not just CLIs on PATH) because
 * on-disk artifacts may outlive the CLI install.
 *
 * Returns { command, registerHarnesses }.
 */
export function pickSingleInstallCommand(
  entry: CatalogEntry,
  action: "install" | "uninstall",
  childEnv: Record<string, string | undefined> = buildAllowedChildEnv(
    process.env,
    null,
    getShellPathSync()
  )
): { command: string | null; registerHarnesses: string[] } {
  const cmdMap =
    action === "uninstall" ? entry.uninstallCommands : entry.installCommands;
  const harnesses = Array.isArray(entry.harnesses) ? entry.harnesses : [];

  if (action === "uninstall") {
    // Run ALL listed harnesses' uninstall commands independently.
    const cmds = harnesses
      .map((h) => cmdMap?.[h])
      .filter((c): c is string => Boolean(c));
    if (cmds.length === 0) {
      return { command: null, registerHarnesses: [] };
    }
    return {
      command: joinIndependentCleanupCommands(cmds),
      registerHarnesses: harnesses,
    };
  }

  // Install path — only consider harnesses whose CLI is actually present.
  const installed = harnesses.filter((h) => isHarnessInstalled(h, childEnv));
  if (installed.length === 0) {
    return { command: null, registerHarnesses: [] };
  }
  // Prefer codex command when codex is present (superset convention).
  const codexFirst = ["codex", "claude"];
  for (const h of codexFirst) {
    if (installed.includes(h) && cmdMap?.[h]) {
      return { command: cmdMap[h], registerHarnesses: installed };
    }
  }
  // Last resort: any command for any installed harness.
  for (const h of installed) {
    if (cmdMap?.[h]) {
      return { command: cmdMap[h], registerHarnesses: installed };
    }
  }
  return { command: null, registerHarnesses: [] };
}

// ---------------------------------------------------------------------------
// Origin / trusted-action validation (ported from catalog-action-handler.js)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core: streamRun
// ---------------------------------------------------------------------------

/**
 * Run an install (or uninstall) command for a catalog pack and stream output
 * to the renderer via Electron IPC.
 *
 * @param prisma   — the single DesktopPrisma client (catalog-store reads/writes)
 * @param opts     — see StreamRunOptions
 * @returns A result indicating whether the run was started or rejected
 */
export async function streamRun(
  prisma: DesktopPrisma,
  opts: StreamRunOptions
): Promise<StreamRunResult> {
  const { pack_id, harness, action, getWindow, onComplete } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestedCwd = typeof opts.cwd === "string" ? opts.cwd.trim() : "";

  // Placeholder runId for error events sent before a DB row exists
  const errorRunId = -1;

  const entry = await getCatalog(prisma, pack_id);
  if (!entry) {
    sendIpc(getWindow, errorRunId, "error", {
      message: `pack_id not in catalog: ${pack_id}`,
    });
    sendIpc(getWindow, errorRunId, "complete", {
      exit_code: -1,
      reason: "not_found",
    });
    return {
      started: false,
      error: {
        code: "ENOTFOUND",
        message: `pack_id not in catalog: ${pack_id}`,
      },
    };
  }

  const childPath = getShellPathSync();

  // For `single_install` packs, the catalog UI sends harness="auto" and we
  // pick the command that covers all installed CLIs in one run.
  let command: string | null | undefined;
  // resolvedHarnesses tracks which CLIs this run covers (used by callers for
  // pack scanner registration after successful install).
  let _resolvedHarnesses: string[] = [harness];

  if (entry.singleInstall && harness === "auto") {
    const picked = pickSingleInstallCommand(
      entry,
      action,
      buildAllowedChildEnv(process.env, null, childPath)
    );
    command = picked.command;
    _resolvedHarnesses = picked.registerHarnesses;
    if (!command) {
      const noCommandMessage =
        action === "uninstall"
          ? `pack '${pack_id}' is single_install but no uninstall commands are configured for any listed harness.`
          : `pack '${pack_id}' is single_install but no supported CLI is on PATH. ` +
            "Install Claude Code or Codex first, then try again.";
      sendIpc(getWindow, errorRunId, "error", { message: noCommandMessage });
      sendIpc(getWindow, errorRunId, "complete", {
        exit_code: -1,
        reason: action === "uninstall" ? "no_command" : "no_cli_detected",
      });
      return {
        started: false,
        error: {
          code: action === "uninstall" ? "ENOCOMMAND" : "ENOCLI",
          message: noCommandMessage,
        },
      };
    }
  } else {
    const commandMap =
      action === "uninstall" ? entry.uninstallCommands : entry.installCommands;
    command = commandMap?.[harness];
    if (!command) {
      const msg = `no ${action} command for harness '${harness}' on pack '${pack_id}'`;
      sendIpc(getWindow, errorRunId, "error", { message: msg });
      sendIpc(getWindow, errorRunId, "complete", {
        exit_code: -1,
        reason: "no_command",
      });
      return { started: false, error: { code: "ENOCOMMAND", message: msg } };
    }
  }

  // Validate CWD
  let resolvedCwd: string | null = null;
  try {
    resolvedCwd = resolveSpawnCwd(requestedCwd);
  } catch (error: unknown) {
    const errObj = error as Error & { code?: string };
    const code = errObj.code ?? "EBADCWD";
    const message = errObj.message ?? "invalid cwd";
    sendIpc(getWindow, errorRunId, "error", { code, message });
    sendIpc(getWindow, errorRunId, "complete", {
      exit_code: -1,
      reason: "invalid_cwd",
    });
    return { started: false, error: { code, message } };
  }

  // Concurrency guard
  const inFlight = await inFlightInstallRun(prisma, pack_id);
  if (inFlight) {
    const msg = `another run for ${pack_id} is already in-flight (started ${inFlight.started_at})`;
    sendIpc(getWindow, errorRunId, "error", {
      message: msg,
      in_flight_run_id: inFlight.id,
    });
    sendIpc(getWindow, errorRunId, "complete", {
      exit_code: -1,
      reason: "in_flight",
    });
    return { started: false, error: { code: "EINFLIGHT", message: msg } };
  }

  // Project-scoped guard
  const requiresProjectCwd =
    entry.projectScoped || looksProjectRelative(command);
  if (requiresProjectCwd && !resolvedCwd) {
    sendIpc(getWindow, errorRunId, "copy_command", {
      pack_id,
      command,
      reason: entry.projectScoped ? "project_scoped" : "looks_project_relative",
    });
    const msg =
      `pack '${pack_id}' is project-scoped (command operates on cwd). ` +
      "Provide an explicit `cwd` for the install — otherwise it would " +
      `run in the app's launch directory, not your project.`;
    sendIpc(getWindow, errorRunId, "error", { message: msg });
    sendIpc(getWindow, errorRunId, "complete", {
      exit_code: -1,
      reason: "cwd_required",
    });
    return { started: false, error: { code: "ECWDREQUIRED", message: msg } };
  }

  // Record the run and start streaming
  const runId = await recordInstallRunStart(prisma, {
    pack_id,
    harness,
    action,
    command,
  });
  sendIpc(getWindow, runId, "start", {
    run_id: runId,
    command,
    cwd: resolvedCwd,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let killed = false;

  const spawnOpts: {
    stdio: ["ignore", "pipe", "pipe"];
    env: Record<string, string>;
    cwd?: string;
  } = {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildAllowedChildEnv(process.env, resolvedCwd, childPath),
  };
  if (resolvedCwd) {
    spawnOpts.cwd = resolvedCwd;
  }

  const child = spawn("sh", ["-c", command], spawnOpts);

  const timer = setTimeout(() => {
    killed = true;
    sendIpc(
      getWindow,
      runId,
      "stderr",
      `[install-orchestrator] timeout after ${timeoutMs}ms — killing\n`
    );
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2000);
    } catch {
      /* already dead */
    }
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    stdoutBuf += s;
    sendIpc(getWindow, runId, "stdout", s);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    stderrBuf += s;
    sendIpc(getWindow, runId, "stderr", s);
  });

  child.on("error", (err: Error) => {
    sendIpc(
      getWindow,
      runId,
      "stderr",
      `[install-orchestrator] spawn error: ${err.message}\n`
    );
  });

  child.on("close", (code: number | null, signal: string | null) => {
    clearTimeout(timer);
    const exitCode = code ?? -1;
    void recordInstallRunEnd(prisma, runId, {
      exit_code: killed ? -1 : exitCode,
      stdout_tail: tailBytes(stdoutBuf),
      stderr_tail: tailBytes(stderrBuf),
    });

    // On successful install: surface the pack's post_install block before the
    // complete event so the client can render a "next steps" screen.
    if (
      !killed &&
      exitCode === 0 &&
      action === "install" &&
      entry.postInstall
    ) {
      sendIpc(getWindow, runId, "post_install", entry.postInstall);
    }

    sendIpc(getWindow, runId, "complete", {
      exit_code: killed ? -1 : exitCode,
      reason: killed ? "timeout" : signal ? `signal:${signal}` : "exit",
      run_id: runId,
    });

    if (typeof onComplete === "function") {
      try {
        onComplete({ exit_code: exitCode, killed });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        gatewayLog.warn(
          "[install-orchestrator] onComplete callback failed:",
          msg
        );
      }
    }
  });

  return { started: true, runId };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { TRUSTED_ACTION_HEADER, TRUSTED_ACTION_VALUE };

// Test-only internals (mirrors the old _internals export for unit tests)
export const _internals = {
  buildAllowedChildEnv,
  looksProjectRelative,
  resolveSpawnCwd,
  stripAnsi,
  tailBytes,
  isHarnessInstalled,
  joinIndependentCleanupCommands,
  pickSingleInstallCommand,
  sendIpc,
};
