// @ts-check
/**
 * ISS-4474 — dev-launcher exit containment.
 *
 * The db-host `utilityProcess` recurrently bounces mid-backfill (OOM / native
 * crash / a terminal disconnect delivering a signal). The DbHostClient
 * supervisor already contains that bounce in-process: it catches the child's
 * `exit`, backs off, and re-forks (see db-host-client.ts). But the same event
 * that kills the db-host (e.g. a SIGHUP when the controlling TTY goes away under
 * `just desktop-dev`) can also reach the Electron *main* process, which then
 * exits BY SIGNAL.
 *
 * The launcher used to handle that by re-raising the child's signal on ITSELF
 * (`process.kill(process.pid, signal)`). Re-raising a fatal signal makes the
 * launcher terminate by that signal, which propagates up to the `just` recipe as
 * a fatal termination (`terminated by signal 1`, with the observed TTY I/O
 * error) — so a contained db-host bounce still cascaded into a fatal
 * `desktop-dev` crash.
 *
 * Instead, when a spawned child exits, the launcher should exit CLEANLY with a
 * conventional numeric status. A normal non-zero exit is a plain recipe failure
 * the shell reports without re-raising a fatal signal on the terminal, so the
 * bounce stays contained. `resolveLauncherExitCode` derives that status:
 *   - child exited by signal  → 128 + signal number (POSIX convention), so the
 *     original cause is still legible in the exit code without re-raising it;
 *   - child exited by code     → that code (defaulting to 0).
 */

import os from "node:os";

/**
 * POSIX signal name → number, for the `128 + n` exit-code convention. Sourced
 * from `os.constants.signals` so it stays complete and platform-correct — the
 * native crash modes the db-host actually dies to (SIGTRAP, SIGSEGV, SIGABRT;
 * see db-host-client.ts) resolve to their real numbers instead of collapsing to
 * a generic `1`, keeping `128 + n` legible for those crashes. A small POSIX
 * fallback covers any signal name absent from `os.constants.signals`; anything
 * still unknown falls back to a generic non-zero code so we never re-raise and
 * never exit 0 on a signal death.
 *
 * @type {Readonly<Record<string, number>>}
 */
const SIGNAL_NUMBERS = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15,
  ...os.constants.signals,
});

/** Generic non-zero status for a signal we don't have a number for. */
const GENERIC_SIGNAL_EXIT_CODE = 1;

/**
 * Derive the launcher's own exit code from a spawned child's exit `(code,
 * signal)`. Never re-raises the signal — a signal death maps to `128 + n` (a
 * normal non-zero exit the recipe reports without a fatal-signal cascade), a
 * clean exit maps to the child's code (default 0).
 *
 * @param {number | null | undefined} code
 * @param {NodeJS.Signals | string | null | undefined} signal
 * @returns {number}
 */
export function resolveLauncherExitCode(code, signal) {
  if (signal) {
    const signalNumber = SIGNAL_NUMBERS[signal];
    return signalNumber ? 128 + signalNumber : GENERIC_SIGNAL_EXIT_CODE;
  }
  return code ?? 0;
}

/**
 * Handle the launcher's Electron-main child exiting. Runs cleanup, then exits
 * the launcher with the conventional status from `resolveLauncherExitCode` —
 * NEVER re-raising a fatal signal on ourselves (see the module header). Extracted
 * so the production exit path is unit-testable without booting Electron; the real
 * `cleanup`/`exit` side effects are injected.
 *
 * @param {number | null | undefined} code
 * @param {NodeJS.Signals | string | null | undefined} signal
 * @param {{ cleanup: () => Promise<void> | void; exit: (status: number) => void }} io
 * @returns {Promise<void>}
 */
export async function handleElectronExit(code, signal, io) {
  await io.cleanup();
  io.exit(resolveLauncherExitCode(code, signal));
}

/**
 * Handle a build-step child exiting. A signal death or a non-zero code exits the
 * launcher with the conventional status (`exit`); a clean `code === 0` calls
 * `resolve()` so the step sequence continues. Never re-raises a fatal signal.
 * Extracted so the build-step exit path is unit-testable without spawning a real
 * child; `exit`/`resolve` are injected.
 *
 * @param {number | null | undefined} code
 * @param {NodeJS.Signals | string | null | undefined} signal
 * @param {{ exit: (status: number) => void; resolve: () => void }} io
 * @returns {void}
 */
export function handleBuildStepExit(code, signal, io) {
  if (signal) {
    io.exit(resolveLauncherExitCode(code, signal));
    return;
  }
  if (code === 0) {
    io.resolve();
    return;
  }
  io.exit(code ?? 1);
}
