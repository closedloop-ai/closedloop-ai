import { type ChildProcess, spawn } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import type { ElectronLauncher } from "../e2e/helpers/desktop-app.js";

type LaunchOptions = Parameters<ElectronLauncher>[0];

/**
 * A launcher that genuinely spawns a long-lived Node child and whose first
 * window resolves, so the whole of a production launcher runs (seeding and
 * teardown included) without a real Electron build. Every child goes into
 * `spawned` for the caller's `afterAll` to kill; `onLaunch` sees the options
 * the production launcher handed to Electron.
 */
export function succeedingElectronLauncher(
  spawned: ChildProcess[],
  onLaunch?: (options: LaunchOptions) => void
): ElectronLauncher {
  return async (options) => {
    onLaunch?.(options);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      }
    );
    spawned.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return {
      close: async () => {},
      process: () => child,
      firstWindow: async () =>
        ({
          evaluate: async () => undefined,
          on: () => {},
          waitForLoadState: async () => {},
        }) as unknown as Page,
    } as ElectronApplication;
  };
}
