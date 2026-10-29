/**
 * E2E test: automatic historical import crosses the real Electron utility
 * process boundary and renders in the Sessions page.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNavSettled,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const SEEDED_SESSION_ID = "utility-worker-e2e-session";
const SEEDED_SLUG = "utility-worker-e2e";

test.describe("Historical import utility worker", () => {
  test("imports a seeded Claude transcript through the built app", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-history-worker-claude-")
    );
    seedClaudeTranscripts(
      claudeHome,
      [
        {
          sessionId: SEEDED_SESSION_ID,
          slug: SEEDED_SLUG,
          userText: "Seeded transcript for utility worker E2E.",
          assistantText: "Imported through the historical utility worker.",
        },
      ],
      "utility-worker-project"
    );

    // `launchDesktopApp` inherits `process.env`, so overriding only CLAUDE_HOME
    // leaves Codex, Cursor, Copilot, and OpenCode resolving to the operator's
    // real stores — foreign rows in the very Sessions population this asserts
    // against, read off a real machine during a test run.
    const harnessHomesRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-history-worker-homes-")
    );
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-history-worker-e2e-",
      env: {
        ...isolatedHarnessHomes(harnessHomesRoot),
        // …except Claude's, which IS the seeded corpus under test.
        CLAUDE_HOME: claudeHome,
      },
    });

    try {
      // Make the parked Dashboard duplicate deterministic before leaving it.
      const dashboardPanel = await gotoNavSettled(page, "dashboard");
      await expect(
        dashboardPanel.getByRole("link", {
          name: `utility-worker-project (${SEEDED_SLUG})`,
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 });
      const sessionsPanel = await gotoNavSettled(page, "sessions");
      // The seed timestamp is intentionally fixed for deterministic fixtures;
      // keep this import smoke test independent of the Sessions default window.
      await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

      // The Sessions view shows its title only in the Topbar breadcrumb (no
      // in-body <h1>), so assert the imported row directly: the seeded slug
      // crossing the utility-process boundary and rendering is this spec's
      // whole point. Dashboard stays mounted with a hidden copy of this link,
      // so only the committed Sessions panel may answer the assertion.
      await expect(
        sessionsPanel.getByRole("link", {
          name: `utility-worker-project (${SEEDED_SLUG})`,
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    }
  });
});
