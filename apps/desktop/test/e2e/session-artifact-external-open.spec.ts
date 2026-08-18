/**
 * ISS-4898 regression (wongk + codex review on PR #4275): a renderer-opened link
 * on the CONFIGURED web-app origin actually reaches the OS, driven through the
 * LAUNCHED Electron app's real window-open guard.
 *
 * The defect: the session-detail linked-artifact pills build their href on
 * `webAppOrigin` (a stage, preview, or localhost profile builds a stage URL),
 * but `DesktopWindow.installNavigationGuards` routed every renderer-opened link
 * through `isAllowedExternalUrl`, whose host set is the four PRODUCTION hosts.
 * So on any non-production profile the pill rendered live and every click was
 * silently denied in the main process — a control that looks actionable and does
 * nothing, which is exactly the failure this row exists to fix.
 *
 * What this spec drives is the COMPOSED path, which is where the bug lived and
 * which no unit test reaches: the persisted `webAppOrigin` in
 * `desktop-settings.json` → `SettingsStore.getWebAppOrigin()` →
 * `DesktopWindow`'s `resolveWebAppOrigin` option → `isAllowedRendererExternalUrl`
 * → `shell.openExternal`. `shell.openExternal` is spied in the MAIN process (the
 * real handler is invoked; only the OS hand-off is captured), so the assertion is
 * "the guard admitted it", not "an anchor has an href".
 *
 * SCOPE, stated honestly. This opens the URL the pill builds rather than
 * clicking the pill itself. The pill additionally requires an org slug from
 * `GET /desktop/identity`, and the desktop e2e profile launches with
 * `cloudConnectionEnabled: false` and signed out, so `useDesktopIdentity`
 * short-circuits to null and no pill renders at all. Reaching it needs a
 * registered compute target plus a first-party session — its own harness work,
 * tracked as a follow-up rather than smuggled in here. The href the pill would
 * build is pinned by `artifact-web-href.test.ts` and the row's render tests; the
 * guard that used to swallow it is pinned here.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktopApp, seedDesktopSettings } from "./helpers/desktop-app";

/** A non-production profile — the exact case the fixed host set rejected. */
const STAGE_ORIGIN = "https://app.closedloop-stage.ai";
/** The shape `buildArtifactWebHref` produces for a linked artifact. */
const STAGE_ARTIFACT_URL = `${STAGE_ORIGIN}/acme/issues/ISS-4898`;
/** A same-suffix host the configured origin must NOT admit. */
const NEIGHBOUR_ORIGIN_URL = "https://evil.closedloop-stage.ai/acme/issues/X";
/** Always admitted by the fixed production host set, on any profile. */
const PRODUCTION_DOCS_URL = "https://docs.closedloop.ai/getting-started";

test.describe("Renderer external-link guard on a configured origin (ISS-4898)", () => {
  test("admits the configured web-app origin, still denies its neighbours", async () => {
    test.setTimeout(120_000);

    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-4898-external-open-")
    );

    const { app, page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: () =>
        seedDesktopSettings(userDataDir, { webAppOrigin: STAGE_ORIGIN }),
      keepUserDataDir: true,
      userDataDir,
    });

    try {
      await installOpenExternalSpy(app);

      // The stage artifact URL: denied before the fix (not in the fixed host
      // set), admitted now because it is the exact configured origin.
      await requestExternalOpen(page, STAGE_ARTIFACT_URL);
      await expect
        .poll(() => openedUrls(app), { timeout: 10_000 })
        .toContain(STAGE_ARTIFACT_URL);

      // Configuring stage must not widen the gate to a sibling host. Prove it by
      // firing the neighbour and then a URL that IS admitted, and asserting the
      // admitted one landed while the neighbour never did — an ordered check, so
      // there is no fixed sleep proving a non-event.
      await requestExternalOpen(page, NEIGHBOUR_ORIGIN_URL);
      await requestExternalOpen(page, PRODUCTION_DOCS_URL);
      await expect
        .poll(() => openedUrls(app), { timeout: 10_000 })
        .toContain(PRODUCTION_DOCS_URL);
      expect(await openedUrls(app)).not.toContain(NEIGHBOUR_ORIGIN_URL);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * Replace `shell.openExternal` in the MAIN process with a recorder. The window
 * open handler and the allowlist are untouched — only the OS hand-off at the end
 * of the real path is captured.
 */
async function installOpenExternalSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (
      globalThis as unknown as { __openedExternalUrls: string[] }
    ).__openedExternalUrls = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

/** Every URL the main process handed to `shell.openExternal` so far. */
function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __openedExternalUrls?: string[] })
        .__openedExternalUrls ?? []
  );
}

/**
 * Ask the renderer to open `url` in a new window — the same request an
 * `<a target="_blank">` pill click produces, which `setWindowOpenHandler`
 * intercepts.
 */
function requestExternalOpen(page: Page, url: string): Promise<void> {
  return page.evaluate((target) => {
    window.open(target, "_blank", "noreferrer");
  }, url);
}
