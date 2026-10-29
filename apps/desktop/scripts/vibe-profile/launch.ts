import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import {
  resolveElectronBinary,
  type VibeProfileOrigins,
  vibeProfileLaunchEnv,
} from "./launch-env";
import {
  DESKTOP_APP_DIR,
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "./profile-layout";

export type VibeLaunchCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
};

/** How the launched command ended: Node's `exit` event `(code, signal)` pair. */
export type VibeLaunchExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type VibeLaunchDeps = {
  /** Runs the command to completion and resolves with how it ended. */
  readonly run: (launch: VibeLaunchCommand) => Promise<VibeLaunchExit>;
  /** The Electron binary's path, or null when it is not installed. */
  readonly electronBinary: () => string | null;
  readonly baseEnv: NodeJS.ProcessEnv;
};

/**
 * Opens the real Desktop app on a signed-in vibe profile: the dev launcher
 * with the browser bridge (`pnpm run dev:browser`, scripts/dev-launch.mjs),
 * the profile's `--user-data-dir` after `--` and `launch-env`'s environment,
 * the way `vibe up` starts its bridge (.claude/skills/control/scripts/vibe/up.ts).
 * The window is the bridge host, and the launcher prints the
 * `Desktop browser URL: ...` line a vibe session opens as a browser tab
 * (ISS-12182). The dev launcher builds what it needs itself (`build:deps`,
 * `build:main:dev`, a Vite renderer), so no packaged build is required; only
 * the Electron binary is.
 *
 * Stopping Desktop with SIGTERM or SIGINT, the way the vibe skill stops it, is
 * a clean stop and resolves with `stoppedBy`; any other non-zero exit, or a
 * crash signal, is a failure.
 */
export async function launchVibeProfile(
  profileDir: string,
  origins: VibeProfileOrigins,
  deps: VibeLaunchDeps,
  log: (message: string) => void
): Promise<{ exitCode: number; stoppedBy?: VibeStopSignal }> {
  if (!existsSync(vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Session))) {
    throw new Error(
      `${profileDir} is not signed in; run vibe:profile sign-in with the same origins first`
    );
  }
  if (deps.electronBinary() === null) {
    throw new Error(
      "the Electron binary is not installed; run `pnpm --filter desktop verify:electron-binary`"
    );
  }
  const launch = vibeProfileLaunchCommand(profileDir, origins, deps.baseEnv);
  log(`launching Desktop against ${origins.apiOrigin}`);
  const exit = await deps.run(launch);
  const exitCode = vibeLaunchExitCode(exit);
  const stoppedBy = vibeLaunchStopSignal(exit);
  if (stoppedBy !== null) {
    log(`Desktop stopped by ${stoppedBy}`);
    return { exitCode, stoppedBy };
  }
  if (exitCode !== 0) {
    throw new Error(`Desktop exited with code ${exitCode}`);
  }
  return { exitCode };
}

export function vibeProfileLaunchCommand(
  profileDir: string,
  origins: VibeProfileOrigins,
  baseEnv: NodeJS.ProcessEnv
): VibeLaunchCommand {
  const launch = vibeProfileLaunchEnv(profileDir, origins);
  return {
    command: "pnpm",
    args: ["run", "dev:browser", "--", ...launch.args],
    cwd: DESKTOP_APP_DIR,
    env: { ...baseEnv, ...launch.env },
  };
}

/**
 * The child's stdout goes to this process's stderr: the CLI's stdout carries
 * only its one result object.
 */
export const defaultVibeLaunchDeps: VibeLaunchDeps = {
  run: (launch) =>
    new Promise((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["inherit", STDERR_FD, "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    }),
  electronBinary: () => {
    const binary = resolveElectronBinary();
    return existsSync(binary) ? binary : null;
  },
  baseEnv: process.env,
};

const STDERR_FD = 2;

/** The signals the vibe skill stops Desktop with. */
export const VibeStopSignal = {
  Sigint: "SIGINT",
  Sigterm: "SIGTERM",
} as const;
export type VibeStopSignal =
  (typeof VibeStopSignal)[keyof typeof VibeStopSignal];

const SIGNAL_EXIT_CODE_BASE = 128;
const GENERIC_FAILURE_EXIT_CODE = 1;

/**
 * The stop signal behind `exit`, or null. The signal reaches this process two
 * ways: as the `signal` of a `pnpm` child it killed outright, or as the POSIX
 * `128 + n` status the dev launcher exits with when Electron dies by it
 * (`resolveLauncherExitCode` in `scripts/dev-launch-exit.mjs`), which `pnpm`
 * passes on as its own exit code.
 */
export function vibeLaunchStopSignal(
  exit: VibeLaunchExit
): VibeStopSignal | null {
  for (const signal of Object.values(VibeStopSignal)) {
    if (
      exit.signal === signal ||
      exit.code === SIGNAL_EXIT_CODE_BASE + os.constants.signals[signal]
    ) {
      return signal;
    }
  }
  return null;
}

function vibeLaunchExitCode(exit: VibeLaunchExit): number {
  if (exit.signal !== null) {
    const signalNumber = os.constants.signals[exit.signal];
    return signalNumber === undefined
      ? GENERIC_FAILURE_EXIT_CODE
      : SIGNAL_EXIT_CODE_BASE + signalNumber;
  }
  return exit.code ?? GENERIC_FAILURE_EXIT_CODE;
}
