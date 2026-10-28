/**
 * ISS-12135: what every harness Electron launch passes through before the
 * spawn. A launch from a checkout whose build is missing or does not load
 * fails here as a test error; left to Electron it becomes a native modal on
 * the machine's screen. A launch of the Desktop app is also kept off screen
 * unless the caller opted into a visible window.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { _electron } from "@playwright/test";
import {
  assertMainBundleLaunchable,
  missingEntryMessage,
} from "../../../scripts/main-bundle-launch-preflight-lib.mjs";
import { E2E_NO_REVEAL_ARG } from "../../../src/main/lifecycle/window-reveal-suppression.js";

export type ElectronLaunchOptions = NonNullable<
  Parameters<typeof _electron.launch>[0]
>;

/** The built Desktop main process every Desktop launcher points Electron at. */
export const DESKTOP_MAIN_BUNDLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../dist/main/index.js"
);

/**
 * Declares that a Desktop launch is meant to be on screen. The app ignores it;
 * it exists so {@link preflightElectronLaunch} can tell a deliberate reveal
 * from a launch that forgot {@link E2E_NO_REVEAL_ARG}.
 */
export const E2E_REVEAL_WINDOW_OPT_IN_ARG = "--e2e-reveal-window";

/** Electron switches that consume the following argument. */
const SWITCHES_WITH_VALUE = new Set(["-r", "--require"]);

/**
 * Check the launch can come up, then return the options to spawn with.
 *
 * Throws before any process exists when the app entry is missing, or when the
 * entry is the Desktop main bundle and an import it reaches does not resolve.
 * A Desktop launch carrying neither {@link E2E_NO_REVEAL_ARG} nor
 * {@link E2E_REVEAL_WINDOW_OPT_IN_ARG} gets {@link E2E_NO_REVEAL_ARG} appended,
 * after the entry, where app-level arguments belong.
 *
 * `desktopMainBundle` is overridden only by tests, which have no build.
 */
export function preflightElectronLaunch(
  options: ElectronLaunchOptions,
  desktopMainBundle: string = DESKTOP_MAIN_BUNDLE
): ElectronLaunchOptions {
  const args = options.args ?? [];
  const entry = appEntryArg(args);
  if (entry === undefined) {
    throw new Error(
      `desktop launch preflight: no app entry in Electron args ${JSON.stringify(args)}, so Electron was not started (it would open its default app).`
    );
  }
  const entryPath = path.resolve(options.cwd ?? process.cwd(), entry);
  if (entryPath !== desktopMainBundle) {
    if (!fs.existsSync(entryPath)) {
      throw new Error(missingEntryMessage(entryPath));
    }
    return options;
  }
  assertMainBundleLaunchable(entryPath);
  if (
    args.includes(E2E_NO_REVEAL_ARG) ||
    args.includes(E2E_REVEAL_WINDOW_OPT_IN_ARG)
  ) {
    return options;
  }
  return { ...options, args: [...args, E2E_NO_REVEAL_ARG] };
}

/** The first argument that is neither a switch nor a switch's value. */
function appEntryArg(args: readonly string[]): string | undefined {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
    } else if (SWITCHES_WITH_VALUE.has(arg)) {
      skipNext = true;
    } else if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return;
}
