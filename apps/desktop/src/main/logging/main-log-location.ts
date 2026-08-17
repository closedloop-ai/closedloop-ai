/**
 * @file main-log-location.ts
 * @description Resolves where the durable Desktop main log is written (ISS-4916).
 *
 * electron-log's default file transport resolves against Electron's `logs` path,
 * which on macOS is `~/Library/Logs/<appName>` — a location that does NOT follow
 * a redirected `userData` directory. So an Electron e2e run (launched with
 * `--user-data-dir=<temp dir>`) and a golden-mode launch both wrote their boot,
 * migration-replay, and teardown-cascade lines into the SAME production
 * `main.log` as the operator's real app, with nothing in the line to tell them
 * apart. That made real-app diagnosis actively misleading: e2e boots were read
 * as production crash-loops and a DB-ahead downgrade.
 *
 * The rule: a Desktop instance running against a NON-DEFAULT `userData`
 * directory keeps its log inside that directory, so a throwaway profile's log
 * dies with the throwaway profile. An instance on the default profile is left on
 * electron-log's own default so the production log path is unchanged.
 *
 * Kept free of `electron` imports so the decision is unit-testable without
 * booting Electron.
 */

import path from "node:path";

/** The subdirectory of a redirected `userData` that receives its main log. */
const REDIRECTED_LOG_DIR_NAME = "logs";

export type MainLogLocationInput = {
  /** `app.getPath("userData")` — already redirected by golden mode / CLI flag. */
  userDataPath: string;
  /** `app.getPath("appData")` — the parent of the DEFAULT userData directory. */
  appDataPath: string;
  /** `app.getName()` — the leaf of the default userData directory. */
  appName: string;
};

/**
 * The instance's profile kind, derived from whether `userData` still points at
 * the default profile. `redirected` covers every throwaway profile we launch
 * (Electron e2e temp dirs, golden mode) plus any operator-supplied
 * `--user-data-dir`.
 */
export const DesktopProfileKind = {
  Default: "default",
  Redirected: "redirected",
} as const;
export type DesktopProfileKind =
  (typeof DesktopProfileKind)[keyof typeof DesktopProfileKind];

/**
 * Whether this instance runs on the default profile. Compared on normalized
 * absolute paths so a trailing separator or a `.` segment does not read as a
 * redirect (and silently move the production log).
 */
export function resolveDesktopProfileKind(
  input: MainLogLocationInput
): DesktopProfileKind {
  const defaultUserDataPath = path.join(input.appDataPath, input.appName);
  return path.resolve(input.userDataPath) === path.resolve(defaultUserDataPath)
    ? DesktopProfileKind.Default
    : DesktopProfileKind.Redirected;
}

/**
 * The directory the durable main log belongs in, or `null` to leave
 * electron-log's default (production) resolution untouched.
 */
export function resolveMainLogDirectory(
  input: MainLogLocationInput
): string | null {
  if (resolveDesktopProfileKind(input) === DesktopProfileKind.Default) {
    return null;
  }
  return path.join(path.resolve(input.userDataPath), REDIRECTED_LOG_DIR_NAME);
}

export type DesktopBootIdentityInput = MainLogLocationInput & {
  /** `BUILD_APP_VERSION` — the version baked in at build time. */
  buildAppVersion: string;
  /** `BUILD_COMMIT_HASH` — the commit the running bundle was built from. */
  buildCommitHash: string;
  /** `process.versions.electron`. */
  electronVersion: string;
  /** The resolved durable main-log path for this instance. */
  logFilePath: string;
};

/**
 * The `Desktop boot starting …` line (ISS-4916).
 *
 * It deliberately does NOT report `app.getVersion()`: that value is
 * launch-mode-dependent (the dev-launch path reports the ELECTRON version,
 * `43.0.0`, because the launched app path's package.json carries no `version`),
 * so it identifies how the app was started rather than which code is running,
 * and it cannot be used to tell which build a log run came from. The baked
 * build identity can. The `profile` marker distinguishes a throwaway instance
 * from the operator's real one even when both lines end up side by side.
 */
export function formatDesktopBootLine(input: DesktopBootIdentityInput): string {
  const commit = input.buildCommitHash.slice(0, 7) || "unknown";
  const version = input.buildAppVersion || "unknown";
  return `Desktop boot starting version=${version} commit=${commit} electron=${input.electronVersion} profile=${resolveDesktopProfileKind(input)} log=${input.logFilePath}`;
}
