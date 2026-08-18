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
 * ISS-5138 split this module by responsibility. What remains here is the
 * ORCHESTRATION shell — pre-flight gates, the audit row, spawning, and the IPC
 * output stream. Its two collaborators:
 *  - `install-child-env.ts` — the child process's execution context (env
 *    allowlist, cwd validation, harness-CLI detection on that env's PATH)
 *  - `install-command-resolver.ts` — turning a catalog entry plus a requested
 *    harness into the concrete command text to run
 *
 * Safeguards:
 *  - Hard timeout (default 10 min) — subprocess killed if it overruns
 *  - Concurrent-install guard: refuses if a run for the same pack is still
 *    in-flight — an open `pack_install_runs` row whose child this process is
 *    still holding (see `liveRunIds`)
 *  - ANSI escape codes stripped from stored tails (full output stays in the
 *    live IPC stream)
 *  - Security-hardened minimal env for child processes (no leaked tokens)
 */

import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { getShellPathSync } from "../../server/shell-path.js";
import type { CatalogEntry } from "../../shared/agent-db-contract.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
  type StreamRunResult,
} from "../../shared/install-run-contract.js";
import { redriveOnDbHostExit } from "../database/db-host/db-host-exit-redrive.js";
import { dropOnDbHostLifecycleError } from "../database/db-host/db-host-fire-and-forget.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { stripAnsi } from "../diagnostics/diagnostics-helpers.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { getCatalog, inFlightInstallRun } from "./catalog-store.js";
import {
  buildAllowedChildEnv,
  looksProjectRelative,
  resolveSpawnCwd,
} from "./install-child-env.js";
import {
  type InstallAction,
  resolveAutoCommand,
} from "./install-command-resolver.js";

// streamRun runs in the MAIN process, so it takes the proxied agentDatabase
// (NOT the raw `prisma`): clone-safe `prisma.client` reads plus the clone-safe
// pack-install-run writes, all of which forward to the db host (FEA-2252).
// DbHostAgentDatabase narrows `prisma` so `prisma.read`/`prisma.write` are a
// compile error here rather than a runtime DataCloneError.
type StreamRunDb = Pick<
  DbHostAgentDatabase,
  "prisma" | "recordPackInstallRunStart" | "recordPackInstallRunEnd"
>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const TAIL_BYTES = 4096;
/** Placeholder runId for error events sent before a DB row exists. */
const ERROR_RUN_ID = -1;
/** Grace period between SIGTERM and SIGKILL when a run overruns its timeout. */
const SIGKILL_GRACE_MS = 2000;

const TRUSTED_ACTION_HEADER = "x-agent-dashboard-trusted-action";
const TRUSTED_ACTION_VALUE = "catalog-mutate";

/**
 * Run ids this process spawned and has not yet seen exit.
 *
 * `pack_install_runs` cannot answer "is a run in flight" on its own. A row is
 * closed by ONE best-effort write in `child.on("close")`, and both a db-host
 * lifecycle event and an app shutdown can lose it — nothing ever reopens the
 * row afterwards. Treating every `ended_at IS NULL` row as a running process
 * therefore collapses "never observed to end" into "still running" and rejects
 * every later install/uninstall of that pack as `in_flight`, permanently.
 *
 * A run is in flight only while the process that spawned it still holds the
 * child, which is exactly what this set tracks. Bounded by construction: one
 * entry per spawn, deleted unconditionally on `close`, and the guard already
 * forbids a second concurrent run for the same pack.
 */
const liveRunIds = new Set<number>();

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
  action: InstallAction;
  cwd?: string;
  getWindow: () => BrowserWindow | null;
  onComplete?: (result: { exit_code: number; killed: boolean }) => void;
  timeoutMs?: number;
};

/**
 * The command text a run resolved to, or the reason it could not resolve. A
 * discriminated union so a caller cannot read `command` without having handled
 * the failure.
 */
type RunCommandResolution =
  | {
      /** The script to spawn: one command, or the joined multi-step form. */
      command: string;
      /**
       * The individual commands behind `command`. For a joined multi-harness
       * run these are the steps; for every other path it is the single command.
       * The project-scoped guard surfaces THESE to the user, never the joined
       * aggregate, which would be an unusable paste.
       */
      commands: string[];
      /**
       * The concrete harnesses this run covers. Recorded on the audit row so
       * `pack_install_runs.harness` says what was actually installed rather
       * than the `"auto"` sentinel the caller asked for.
       */
      harnesses: string[];
      failure?: undefined;
    }
  | {
      command?: undefined;
      commands?: undefined;
      harnesses?: undefined;
      failure: { code: StreamRunErrorCode; message: string; reason: string };
    };

/** A pre-flight rejection: the closed error code plus its IPC `complete` reason. */
type RunFailure = {
  code: StreamRunErrorCode;
  message: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// Core: streamRun
// ---------------------------------------------------------------------------

/**
 * Run an install (or uninstall) command for a catalog pack and stream output
 * to the renderer via Electron IPC.
 *
 * @param db    the agentDatabase facade (catalog-store reads via `db.prisma`;
 *              install-run writes via the clone-safe `recordPackInstallRun*`
 *              methods, which execute in the db host)
 * @param opts  see StreamRunOptions
 * @returns A result indicating whether the run was started or rejected
 */
export async function streamRun(
  db: StreamRunDb,
  opts: StreamRunOptions
): Promise<StreamRunResult> {
  const { pack_id, harness, action, getWindow } = opts;
  const requestedCwd = typeof opts.cwd === "string" ? opts.cwd.trim() : "";

  const entry = await getCatalog(db.prisma, pack_id);
  if (!entry) {
    return failRun(getWindow, {
      code: StreamRunErrorCode.NotFound,
      message: `pack_id not in catalog: ${pack_id}`,
      reason: "not_found",
    });
  }

  const childPath = getShellPathSync();

  const resolved = resolveRunCommand(
    entry,
    pack_id,
    harness,
    action,
    childPath
  );
  if (resolved.failure) {
    return failRun(getWindow, resolved.failure);
  }
  const { command, commands: resolvedCommands, harnesses } = resolved;

  // Validate CWD
  let resolvedCwd: string | null = null;
  try {
    resolvedCwd = resolveSpawnCwd(requestedCwd);
  } catch (error: unknown) {
    const errObj = error as Error & { code?: string };
    // resolveSpawnCwd only ever throws `.code = "EBADCWD"`; anything else is
    // still a bad-cwd class of failure at this boundary.
    const code = StreamRunErrorCode.BadCwd;
    const message = errObj.message ?? "invalid cwd";
    return failRun(
      getWindow,
      { code, message, reason: "invalid_cwd" },
      { code }
    );
  }

  // Concurrency guard. An open row only blocks while THIS process still holds
  // the child — see `liveRunIds` for why the row alone cannot be trusted.
  const inFlight = await inFlightInstallRun(db.prisma, pack_id);
  if (inFlight && liveRunIds.has(inFlight.id)) {
    return failRun(
      getWindow,
      {
        code: StreamRunErrorCode.InFlight,
        message: `another run for ${pack_id} is already in-flight (started ${inFlight.started_at})`,
        reason: "in_flight",
      },
      { in_flight_run_id: inFlight.id }
    );
  }
  if (inFlight) {
    // Not fabricating an end for it: `ended_at IS NULL` is the truth — this run
    // was never observed to finish. Only the INFERENCE that it is still running
    // is wrong, and it is the one thing corrected here.
    gatewayLog.warn(
      "[install-orchestrator]",
      `pack install run ${inFlight.id} (${pack_id}, started ${inFlight.started_at}) has no recorded end and is not running in this process; not treating it as in-flight`
    );
  }

  // Project-scoped guard
  const requiresProjectCwd =
    entry.projectScoped || looksProjectRelative(command);
  if (requiresProjectCwd && !resolvedCwd) {
    sendIpc(getWindow, ERROR_RUN_ID, "copy_command", {
      pack_id,
      // The runnable step(s), not the `if ! ( … ); then …` aggregate.
      command: resolvedCommands.join("\n"),
      commands: resolvedCommands,
      reason: entry.projectScoped ? "project_scoped" : "looks_project_relative",
    });
    return failRun(getWindow, {
      code: StreamRunErrorCode.CwdRequired,
      message:
        `pack '${pack_id}' is project-scoped (command operates on cwd). ` +
        "Provide an explicit `cwd` for the install — otherwise it would " +
        "run in the app's launch directory, not your project.",
      reason: "cwd_required",
    });
  }

  // Record the run and start streaming
  const runId = await db.recordPackInstallRunStart({
    pack_id,
    // ISS-5027: the resolved harness(es), so the audit row is actionable. The
    // sentinel would have said `"auto"` for a run that covered claude+codex.
    harness: harnesses.join(","),
    action,
    command,
  });
  sendIpc(getWindow, runId, "start", {
    run_id: runId,
    command,
    cwd: resolvedCwd,
  });

  spawnAndStream(db, {
    command,
    cwd: resolvedCwd,
    entry,
    opts,
    runId,
    shellPath: childPath,
  });

  return { started: true, runId };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { TRUSTED_ACTION_HEADER, TRUSTED_ACTION_VALUE };

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
  return `…${stripped.slice(stripped.length - TAIL_BYTES)}`;
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
  const chunk: InstallOutputChunk = { runId, type, data };
  sendToRendererWindow(getWindow(), "desktop:pack:install-output", chunk);
}

/**
 * Emit the `error` + `complete` pair every pre-flight rejection sends, and hand
 * back the matching rejected {@link StreamRunResult}.
 *
 * `errorExtra` carries the few rejection-specific fields (the bad-cwd `code`,
 * the in-flight run id). `message` is spread last so an extra field can never
 * clobber it.
 */
function failRun(
  getWindow: () => BrowserWindow | null,
  failure: RunFailure,
  errorExtra?: Record<string, unknown>
): StreamRunResult {
  const { code, message, reason } = failure;
  sendIpc(getWindow, ERROR_RUN_ID, "error", { ...errorExtra, message });
  sendIpc(getWindow, ERROR_RUN_ID, "complete", { exit_code: -1, reason });
  return { started: false, error: { code, message } };
}

/**
 * Resolve the requested harness to runnable command text.
 *
 * ISS-5027: `harness === "auto"` means "main resolves the concrete harness(es)",
 * and EVERY caller without an explicit user choice sends it — the renderer
 * install action, the opt-in banner, and the distribution auto-installer. It
 * used to be honored only for `single_install` packs, so any other pack fell
 * through to a command-map lookup keyed by the sentinel and failed with
 * `no install command for harness 'auto'`, i.e. the whole class of pack was
 * unreachable through the distribution path.
 */
function resolveRunCommand(
  entry: CatalogEntry,
  packId: string,
  harness: string,
  action: InstallAction,
  shellPath: string
): RunCommandResolution {
  if (harness === HARNESS_AUTO) {
    return resolveAutoRunCommand(entry, packId, action, shellPath);
  }

  const commandMap =
    action === "uninstall" ? entry.uninstallCommands : entry.installCommands;
  // `typeof === "string"`, not a bare truthiness check (ISS-5248). Of the three
  // command gates this is the one an EXTERNALLY-supplied `harness` reaches —
  // cloud → relay → the local gateway's member-pack install — so a name like
  // "constructor" is attacker-adjacent input. `stringRecordOrNull` builds the
  // map null-prototype, which is the real fix; this is the instance-level
  // backstop so the spawn path does not rely on that alone.
  const command = commandMap?.[harness];
  if (typeof command !== "string" || command.length === 0) {
    return {
      failure: {
        code: StreamRunErrorCode.NoCommand,
        message: `no ${action} command for harness '${harness}' on pack '${packId}'`,
        reason: "no_command",
      },
    };
  }
  return { command, commands: [command], harnesses: [harness] };
}

/** The `HARNESS_AUTO` branch of {@link resolveRunCommand}. */
function resolveAutoRunCommand(
  entry: CatalogEntry,
  packId: string,
  action: InstallAction,
  shellPath: string
): RunCommandResolution {
  const picked = resolveAutoCommand(
    entry,
    packId,
    action,
    buildAllowedChildEnv(process.env, null, shellPath)
  );
  if (picked.unavailable) {
    const { code, message } = picked.unavailable;
    return {
      failure: {
        code,
        message,
        reason:
          code === StreamRunErrorCode.NoCli ? "no_cli_detected" : "no_command",
      },
    };
  }
  return {
    command: picked.command,
    commands: picked.commands,
    harnesses: picked.registerHarnesses,
  };
}

/**
 * Spawn the resolved command, stream its output to the renderer, enforce the
 * hard timeout, and close out the audit row when the child exits.
 */
function spawnAndStream(
  db: StreamRunDb,
  params: {
    command: string;
    cwd: string | null;
    entry: CatalogEntry;
    opts: StreamRunOptions;
    runId: number;
    shellPath: string;
  }
): void {
  const { command, cwd, entry, opts, runId, shellPath } = params;
  const { action, getWindow, onComplete } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stdoutBuf = "";
  let stderrBuf = "";
  let killed = false;

  const spawnOpts: {
    stdio: ["ignore", "pipe", "pipe"];
    env: Record<string, string>;
    cwd?: string;
  } = {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildAllowedChildEnv(process.env, cwd, shellPath),
  };
  if (cwd) {
    spawnOpts.cwd = cwd;
  }

  const child = spawn("sh", ["-c", command], spawnOpts);
  liveRunIds.add(runId);

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
      }, SIGKILL_GRACE_MS);
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
    liveRunIds.delete(runId);
    const exitCode = code ?? -1;
    const guardOptions = {
      label: `pack install run ${runId} end`,
      log: (message: string) =>
        gatewayLog.warn("[install-orchestrator]", message),
    };
    // ISS-6164: a `child.on("close")` handler has no error path, so an
    // unguarded `void` here let a db-host bounce reach
    // handleUnhandledRejection — which exits the app.
    //
    // Re-drive before dropping: this completion is an idempotent `updateMany`
    // on one row, so replaying it against the replacement host is safe, and it
    // is the only write that ever closes the run out. Dropping it outright
    // would leave `ended_at` null for good. `dropOnDbHostLifecycleError` stays
    // as the outer guard for the exits the re-drive deliberately does not
    // replay (a shutdown, an exit with no replacement scheduled) and for an
    // exhausted attempt bound.
    dropOnDbHostLifecycleError(
      redriveOnDbHostExit(
        () =>
          db.recordPackInstallRunEnd(runId, {
            exit_code: killed ? -1 : exitCode,
            stdout_tail: tailBytes(stdoutBuf),
            stderr_tail: tailBytes(stderrBuf),
          }),
        guardOptions
      ),
      guardOptions
    );

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
      reason: completionReason(killed, signal),
      run_id: runId,
    });

    runOnComplete(onComplete, { exit_code: exitCode, killed });
  });
}

/** How a finished run is reported: timed out, signalled, or a plain exit. */
function completionReason(killed: boolean, signal: string | null): string {
  if (killed) {
    return "timeout";
  }
  if (signal) {
    return `signal:${signal}`;
  }
  return "exit";
}

/** The caller's rescan hook — best-effort; a throwing hook must not escape. */
function runOnComplete(
  onComplete: StreamRunOptions["onComplete"],
  result: { exit_code: number; killed: boolean }
): void {
  if (typeof onComplete !== "function") {
    return;
  }
  try {
    onComplete(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("[install-orchestrator] onComplete callback failed:", msg);
  }
}
