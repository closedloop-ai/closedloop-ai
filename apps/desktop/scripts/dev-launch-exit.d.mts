/**
 * Type declarations for `dev-launch-exit.mjs` (ISS-4474 — dev-launcher exit
 * containment). The launcher is plain ESM JavaScript, so this sidecar is what
 * lets the typechecked `test/` project consume it without `allowJs`. Keep the
 * signatures in step with the `@ts-check` JSDoc on the implementation.
 */

/**
 * Derive the launcher's own exit code from a spawned child's exit
 * `(code, signal)`. Never re-raises the signal — a signal death maps to
 * `128 + n`, a clean exit maps to the child's code (default 0).
 */
export function resolveLauncherExitCode(
  code: number | null | undefined,
  signal: NodeJS.Signals | string | null | undefined
): number;

/**
 * Handle the launcher's Electron-main child exiting: run `cleanup`, then `exit`
 * with the conventional status from {@link resolveLauncherExitCode}.
 */
export function handleElectronExit(
  code: number | null | undefined,
  signal: NodeJS.Signals | string | null | undefined,
  io: {
    cleanup: () => Promise<void> | void;
    exit: (status: number) => void;
    timeoutMs?: number;
  }
): Promise<void>;

/**
 * Handle a build-step child exiting: a signal death or a non-zero code exits the
 * launcher with the conventional status; a clean `code === 0` calls `resolve()`.
 */
export function handleBuildStepExit(
  code: number | null | undefined,
  signal: NodeJS.Signals | string | null | undefined,
  io: {
    exit: (status: number) => void;
    resolve: () => void;
  }
): void;

/** How long the launcher waits for its servers to close before exiting anyway (ISS-12135). */
export const CLEANUP_TIMEOUT_MS: number;

/**
 * The launcher's signal handler: forward the signal to Electron, close the
 * servers within `timeoutMs`, then exit 0 whether or not they closed. A repeat
 * signal while it is closing exits at once.
 */
export function createSignalShutdown(io: {
  forward: (signal: NodeJS.Signals) => void;
  cleanup: () => Promise<void> | void;
  exit: (status: number) => void;
  timeoutMs?: number;
}): (signal: NodeJS.Signals) => Promise<void>;
