/**
 * ISS-6002 regression, through the launched app: the Dashboard must not read a
 * pre-readiness zero as an empty install.
 *
 * The shipped bug was an ORDERING bug between two independent main-process
 * answers, and the renderer suite cannot reach it — those tests inject the
 * readiness hook and the session read as separate mocks, so they never exercise
 * the IPC → source-gate sequencing that produced it. Here the whole chain is
 * real: the `ipcMain` handlers, the preload bridge, the readiness probe and its
 * 500ms self-poll, the read gate, the react-query session poll, and the mounted
 * Dashboard. Only the SOURCE is held down (see
 * `helpers/local-session-source-gate-preload.cjs`), because the window it holds
 * open is a boot race that closes on its own within seconds.
 *
 * The discriminator is `aria-valuenow="100"` on the insights progress bar: it
 * says every dashboard read — including the session read — has RESOLVED. That is
 * the exact moment the shipped code decided, and it decided "No agent sessions
 * yet". The fixed code keeps the loading treatment until the source proves it can
 * serve rows, then resolves.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { releaseLocalSessionSource } from "./helpers/local-session-source-gate";

const EMPTY_STATE_TEXT = "No agent sessions yet";
const COMPUTING_INSIGHTS_TEXT = "Computing insights…";
const ANALYZING_LOCALLY_TEXT = /Analyzing locally/;
const ZERO_SESSIONS_TEXT = /0 sessions/;
const READ_TIMEOUT_MS = 30_000;

test.describe("Dashboard pre-readiness zero (ISS-6002)", () => {
  test("holds the loading treatment until the local source can serve rows", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss6002-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss6002-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        localSessionSourceGate: true,
        userDataPrefix: "desktop-iss6002-e2e-",
      });
      cleanup = launched.cleanup;
      const { app, page, pageErrors } = launched;

      await gotoNav(page, "dashboard");
      await expect(
        page.getByRole("heading", { level: 1, name: "Welcome to Closedloop" })
      ).toBeVisible({ timeout: READ_TIMEOUT_MS });

      // Every dashboard read has resolved — the session read among them, with
      // its honest, useless `{ total: 0 }`. This is the decision point.
      await expect(page.getByText(COMPUTING_INSIGHTS_TEXT)).toBeVisible({
        timeout: READ_TIMEOUT_MS,
      });
      await expect(
        page.getByRole("progressbar", { name: "Insights progress" })
      ).toHaveAttribute("aria-valuenow", "100", { timeout: READ_TIMEOUT_MS });

      // The regression: the shipped build rendered the empty state here, and the
      // header announced "Analyzing locally · 0 sessions" beside it.
      await expect(page.getByText(EMPTY_STATE_TEXT)).toHaveCount(0);
      await expect(page.getByText(ZERO_SESSIONS_TEXT)).toHaveCount(0);
      await expect(page.getByText(ANALYZING_LOCALLY_TEXT)).toBeVisible();

      // The source comes up. The count is now worth something — and on this
      // deliberately empty profile it is a real zero, so the page resolves to
      // the empty state instead of holding the skeleton forever.
      const heldProbes = await releaseLocalSessionSource(app);
      expect(heldProbes).toBeGreaterThan(0);

      await expect(page.getByText(EMPTY_STATE_TEXT)).toBeVisible({
        timeout: READ_TIMEOUT_MS,
      });
      await expect(page.getByText(COMPUTING_INSIGHTS_TEXT)).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await cleanup?.();
      } finally {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        fs.rmSync(codexHome, { recursive: true, force: true });
      }
    }
  });
});
