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
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
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

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-history-worker-e2e-",
      env: { CLAUDE_HOME: claudeHome },
    });

    try {
      await gotoNav(page, "sessions");

      // The Sessions view shows its title only in the Topbar breadcrumb (no
      // in-body <h1>), so assert the imported row directly: the seeded slug
      // crossing the utility-process boundary and rendering is this spec's
      // whole point.
      await expect(page.getByText(SEEDED_SLUG).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
