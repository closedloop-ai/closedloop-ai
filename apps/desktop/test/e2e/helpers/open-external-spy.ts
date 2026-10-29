import type { ElectronApplication } from "@playwright/test";
import { z } from "zod";
import { evaluateElectronSynchronously } from "./evaluate-electron-synchronously.js";

/**
 * Replace `shell.openExternal` in the MAIN process with a recorder. The window
 * open handler (`src/main/window.ts`) and the allowlist it consults are
 * untouched — only the OS hand-off at the end of the real path is captured, so
 * an assertion over {@link openedUrls} reads "the guard admitted it", not "an
 * anchor has an href".
 *
 * Extracted from `session-artifact-external-open.spec.ts` (ISS-4898) when
 * ISS-11397 needed the same recorder for the onboarding legal links.
 */
export async function installOpenExternalSpy(
  app: ElectronApplication
): Promise<void> {
  await evaluateElectronSynchronously(
    app,
    ({ shell }) => {
      const opened: string[] = [];
      (
        globalThis as unknown as { __openedExternalUrls: string[] }
      ).__openedExternalUrls = opened;
      shell.openExternal = (url: string) => {
        opened.push(url);
        return Promise.resolve();
      };
    },
    undefined,
    z.undefined()
  );
}

/** Every URL the main process handed to `shell.openExternal` so far. */
export function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __openedExternalUrls?: string[] })
        .__openedExternalUrls ?? []
  );
}
