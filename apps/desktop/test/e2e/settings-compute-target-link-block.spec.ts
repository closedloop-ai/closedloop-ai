/**
 * ISS-11426 — the relink recovery alert, through the LAUNCHED app.
 *
 * WHY THIS EXISTS (whitlockk review on #8062). Every other suite for this affordance
 * mounts the renderer in isolation: the alert's own test renders the component,
 * and the tab test renders `DesktopAppPanel` under jsdom with a stubbed
 * `window.desktopApi`. Neither crosses the real `desktop:get-runtime-status`
 * IPC, and neither goes through the real preload bridge — so the whole path
 * from the main process's block to a user-clickable action could be broken with all of them
 * green. `apps/desktop/AGENTS.md` requires this for a renderer UI surface, and
 * this is the only test that exercises it.
 *
 * WHAT IS SUBSTITUTED, and it is one input. The block itself, because latching
 * it for real needs an authenticated socket and a cloud that codes a 403, which
 * no launch stands up (`compute-target-link-block-preload.cjs`). Everything
 * around it is shipped code: the field's place on the runtime-status payload,
 * the real IPC channel and preload bridge, the renderer's Zod projection, the
 * 1s poll subscription that replaced the mount snapshot. No feature flag is
 * seeded: the alert is ungated per the operator ruling "ISS-11426 - this should
 * not be behind a FF" (2026-10-05).
 *
 * WHAT THIS DOES NOT COVER, stated so the next reader does not take it as the
 * coverage record. The alert's ACTION is withheld unless a signed-in identity
 * resolves an org slug and a configured web origin, which this UNAUTHENTICATED
 * launch has neither of — so the href is pinned by
 * `compute-target-link-block-alert.test.tsx` and not here. The negative case
 * below is the control that makes the positive one an assertion about the
 * payload rather than about render timing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { SettingsPanelId } from "../../../../packages/api/src/types/settings-panel.ts";
import { COMPUTE_TARGET_LINK_BLOCK_TITLE } from "../../src/renderer/components/settings/compute-target-link-block-copy";
import { launchDesktopApp, openSettingsPanel } from "./helpers/desktop-app";

const DESKTOP_APP_PANEL_RE = /Desktop App/i;

const BLOCK = {
  refusedComputeTargetId: "target-1",
  refusedBatchCount: 5131,
  firstRefusedAt: "2026-09-26T17:00:00.000Z",
};

test("Settings → Desktop App shows the relink alert and a working action when the cloud refuses this machine", async () => {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-link-block-claude-home-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-link-block-codex-home-")
  );
  let cleanupApp: (() => Promise<void>) | undefined;
  try {
    const { cleanup, page } = await launchDesktopApp({
      computeTargetLinkBlock: BLOCK,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataPrefix: "desktop-link-block-e2e-",
    });
    cleanupApp = cleanup;

    await openSettingsPanel(page, { panel: SettingsPanelId.DesktopApp });

    await expect(page.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    if (cleanupApp) {
      await cleanupApp();
    }
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

test("Settings → Desktop App shows no relink alert when nothing is blocked", async () => {
  // The control for the case above: same launch, no block on
  // the payload. Without it, a positive that rendered for any other reason —
  // or a negative that was only ever a race — would be indistinguishable.
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-link-block-clear-claude-home-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-link-block-clear-codex-home-")
  );
  let cleanupApp: (() => Promise<void>) | undefined;
  try {
    const { cleanup, page } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataPrefix: "desktop-link-block-clear-e2e-",
    });
    cleanupApp = cleanup;

    const shell = await openSettingsPanel(page, {
      panel: SettingsPanelId.DesktopApp,
    });

    // Wait for the panel body itself, so the absence below is read AFTER the
    // surface that would carry the alert has rendered.
    await expect(shell.getByText(DESKTOP_APP_PANEL_RE).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(COMPUTE_TARGET_LINK_BLOCK_TITLE)).toHaveCount(
      0
    );
  } finally {
    if (cleanupApp) {
      await cleanupApp();
    }
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});
