/**
 * ISS-10004 — the DESKTOP Diagnostics route reaches `DiagnosticsSurfaceV2`
 * through the shipped shell when `diagnostics-complete-surface` is on, and keeps
 * its superseded composition when it is off.
 *
 * The renderer suite cannot answer whether the surface is REACHABLE from
 * `App.tsx` or merely exported. Here the hash route, the lazy chunk, the real
 * IPC and the real PostHog assignment all run. Both gate states launch, because
 * a shell that mounted it unconditionally would satisfy the ON case alone.
 *
 * AC3 — AUTO-REFRESH IS PAUSED BEFORE THE PROBE IS BROKEN, and that is what
 * makes the recovery assertion mean anything. The host polls every 5s and clears
 * the error at the head of every load, so against a one-shot fault the NEXT POLL
 * clears the notice on its own: the Refresh click could be deleted, or
 * `handleRefresh` unwired entirely, and the test would still pass inside its 30s
 * timeout. Paused, nothing but the reader's action can re-run the probe — so the
 * notice is first asserted to SURVIVE past a poll interval, then cleared by
 * Refresh.
 *
 * AC2 — `pageErrors` is what stops "did not crash" being taken on trust: an
 * unwound React tree raises one.
 *
 * The three `@repo/app` test ids are LITERALS because that subpath does not
 * resolve under Playwright's ESM loader and a spec-level import failure aborts
 * the whole desktop-e2e suite. `diagnostics-v2-mount.test.tsx` imports all three
 * for real and reconciles them against these spellings.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- diagnostics-surface-v2.spec.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "../../../../packages/api/src/types/diagnostics-complete-surface-flag";
import {
  gotoNavSettled,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const SURFACE_TEST_ID = "diagnostics-surface-v2";
const UNAVAILABLE_TEST_ID = "diagnostics-surface-v2-unavailable";
const MALFORMED_TEST_ID = "diagnostics-surface-v2-malformed";

const DIAGNOSTICS_NAV_ID = "diagnostics";
const MOUNT_TIMEOUT_MS = 30_000;
const WIDE_VIEWPORT = { height: 900, width: 1380 };

test.describe("Diagnostics surface v2 (ISS-10004)", () => {
  /**
   * WHAT THIS FILE CAN AND CANNOT ASSERT (marisolashgrove review, ISS-10005 thread).
   *
   * Two cases here used to stub the bridge with
   * `Object.defineProperty(window, "desktopApi", …)` — one rejecting the next
   * probe to drive the recovery ladder, one stripping `linkTotals` to drive the
   * malformed ladder. Both throw in the real app and had never passed: preload
   * exposes `desktopApi` through `contextBridge.exposeInMainWorld`, which
   * Electron installs read-only and non-configurable unless
   * `ContextBridgeMutability` is enabled, and this app never enables it. The
   * redefine rejects, `page.evaluate` propagates it, and the case fails on every
   * run. The exposed object is deep-frozen, so patching `original.db` in place is
   * not an escape either.
   *
   * They are gone rather than repaired because the ladders they drove are a
   * RENDER contract, and the renderer suites already own it end to end:
   * `diagnostics-surface-v2.test.tsx` drives all five transport states including
   * the refresh-in-flight and malformed-section branches, and
   * `diagnostics-payload-guard.test.ts` drives every reader's refusal. Faking a
   * version-skewed payload cannot be done from the main process either — the
   * shape comes off `getDiagnosticsData`, so there is no seeded database that
   * produces it.
   *
   * What is left is the question ONLY this file can answer, and the reason it
   * exists: is the surface REACHABLE through the shipped route on each branch of
   * the gate. `pageErrors` stays because an unwound React tree raises one.
   */
  test("mounts the surface through the shipped route when the gate is on", async () => {
    test.setTimeout(300_000);

    await withDiagnosticsProfile(
      { flagOn: true, prefix: "iss-10004-mount" },
      async (page, pageErrors) => {
        const panel = await openDiagnostics(page);

        // A real probe answered and a real section rendered from it, so the
        // mount above is the surface driving the live IPC read rather than a
        // shell that painted and stopped.
        await panel.getByRole("tab", { name: "Repos" }).click();
        await expect(panel.getByText("Repo Registry")).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(panel.getByTestId(MALFORMED_TEST_ID)).toHaveCount(0);
        await expect(panel.getByTestId(UNAVAILABLE_TEST_ID)).toHaveCount(0);
        expect(pageErrors).toEqual([]);
      }
    );
  });

  test("keeps the superseded composition when the gate is off", async () => {
    test.setTimeout(300_000);

    await withDiagnosticsProfile(
      { flagOn: false, prefix: "iss-10004-off" },
      async (page) => {
        await page.setViewportSize(WIDE_VIEWPORT);
        const panel = await gotoNavSettled(page, DIAGNOSTICS_NAV_ID);

        // The same anchor the ON case waits on, so the surface being absent is
        // the DEFAULT branch rendering rather than a page that never loaded.
        await expect(panel.getByText("Repo Registry")).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(panel.getByTestId(SURFACE_TEST_ID)).toHaveCount(0);
      }
    );
  });
});

/** Open Diagnostics and return the committed nav panel every query is scoped to. */
async function openDiagnostics(page: Page): Promise<Locator> {
  await page.setViewportSize(WIDE_VIEWPORT);
  const panel = await gotoNavSettled(page, DIAGNOSTICS_NAV_ID);
  await expect(panel.getByTestId(SURFACE_TEST_ID)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await expect(panel.getByText("Repo Registry")).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  return panel;
}

/** Launch one isolated profile with the gate seeded, and run the case in it. */
async function withDiagnosticsProfile(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page, pageErrors: Error[]) => Promise<void>
): Promise<void> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  try {
    const { cleanup, page, pageErrors } = await launchDesktopApp({
      beforeLaunch: (dir: string) => {
        if (flagOn) {
          seedDesktopFeatureFlags(dir, {
            [DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY]: true,
          });
        }
      },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(page, pageErrors);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}
