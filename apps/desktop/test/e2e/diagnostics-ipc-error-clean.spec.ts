/**
 * E2E regression (ISS-7599): a renderer catch that puts an Electron IPC
 * rejection on screen must not leak the internal channel name.
 *
 * The renderer component tests inject a pre-wrapped `Error` directly, so they
 * prove the rendering and nothing about the boundary — they cannot see whether
 * Electron really mints that wrapper on this path, and a fixture that invented
 * a shape Electron never sends would keep them green forever. This spec closes
 * that gap through the launched app: a real `ipcMain` handler rejects, Electron
 * wraps it, the real preload bridge (`invokeLiveDb` → `ipcRenderer.invoke`,
 * which deliberately does not transform a rejection) carries it, and the real
 * mounted `DiagnosticsView` catch renders it.
 *
 * Diagnostics is the cheapest representative site: one page-level error alert
 * fed by one `desktop:db:get-diagnostics` read, reachable by hash nav with no
 * Labs gate and no seeded corpus.
 *
 * WHAT IS SUBSTITUTED: only the handler's answer. The spec replaces the
 * registered `desktop:db:get-diagnostics` listener with one that throws, which
 * is the single input a spec cannot otherwise produce on demand — the real read
 * succeeds against the empty E2E profile. `removeHandler` first, because
 * `ipcMain.handle` on an already-registered channel throws "Attempted to
 * register a second handler" and would take the app down. Everything else is
 * the shipped path.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

/** The guarded channel `window.desktopApi.db.getDiagnostics` invokes. */
const DIAGNOSTICS_CHANNEL = "desktop:db:get-diagnostics";
/** The reason the substituted handler rejects with — the only text a user should read. */
const REJECTION_REASON = "ISS-7599 diagnostics read refused";
const DIAGNOSTICS_HEADING = "Diagnostics";
/** Electron's own wrapper phrasing, leaked verbatim by an untreated catch. */
const IPC_WRAPPER_PHRASE = "invoking remote method";

test.describe("Diagnostics IPC error text (ISS-7599)", () => {
  test("renders the reason without Electron's channel-name wrapper", async () => {
    const launched = await launchDesktopApp({
      userDataPrefix: "desktop-iss7599-ipc-error-",
    });
    const { app, page, pageErrors, cleanup } = launched;

    try {
      await app.evaluate(
        ({ ipcMain }, { channel, reason }) => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => {
            throw new Error(reason);
          });
        },
        { channel: DIAGNOSTICS_CHANNEL, reason: REJECTION_REASON }
      );

      // The load-bearing half. Read the RAW rejection the bridge hands the
      // renderer and prove Electron really does wrap it with the channel name
      // here — otherwise the "no leak" assertion below would pass against a
      // boundary that never had anything to leak, which is exactly the blind
      // spot the component tests have.
      const rawMessage = await page.evaluate(async () => {
        // Reached through `Reflect.get` rather than a `declare global`: the e2e
        // project already carries one for `window.desktopApi`, narrowed to
        // `getDesktopAuthState`, and a second declaration of the same property
        // with a different shape is a merge conflict (TS2717) rather than an
        // extension.
        // `window` is widened to `object` first so `Reflect.get` returns `any`
        // rather than the narrow declared member — no cast needed either way.
        const globalScope: object = window;
        const api: DiagnosticsBridgeProbe = Reflect.get(
          globalScope,
          "desktopApi"
        );
        try {
          await api.db.getDiagnostics();
          return "";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      });
      expect(rawMessage).toContain(IPC_WRAPPER_PHRASE);
      expect(rawMessage).toContain(DIAGNOSTICS_CHANNEL);
      expect(rawMessage).toContain(REJECTION_REASON);

      await gotoNav(page, "diagnostics");
      await expect(
        page.getByRole("heading", { name: DIAGNOSTICS_HEADING })
      ).toBeVisible({ timeout: 20_000 });

      // Located by the REASON, not by position: that substring survives the
      // mutation this spec guards (a leaking render shows the reason too, with
      // the wrapper in front of it), so the locator finds the same alert in
      // both the fixed and the broken build instead of silently matching
      // nothing and passing the negative assertions vacuously.
      const alert = page
        .getByRole("alert")
        .filter({ hasText: REJECTION_REASON });
      await expect(alert).toBeVisible({ timeout: 20_000 });

      // What the user must NOT be shown. Reverting `diagnostics-view.tsx` to
      // the raw `err.message` renders `rawMessage` verbatim and fails both.
      const alertText = (await alert.innerText()).trim();
      expect(alertText).not.toContain(IPC_WRAPPER_PHRASE);
      expect(alertText).not.toContain(DIAGNOSTICS_CHANNEL);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

/** The one bridge member this spec calls directly, typed at the call site. */
type DiagnosticsBridgeProbe = {
  db: { getDiagnostics: () => Promise<unknown> };
};
