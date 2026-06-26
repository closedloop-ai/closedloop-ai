/**
 * E2E deep flow: Sessions — the primary user surface.
 *
 * Seeds real Claude transcripts into a temp CLAUDE_HOME, lets the app's
 * historical importer ingest them across the utility-process boundary, then
 * exercises the list → detail → back navigation the way a user would:
 *   1. the seeded sessions appear in the Sessions list,
 *   2. clicking a row opens the session detail (shared detail view), and
 *   3. "Back to Sessions" returns to the list.
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
import { type SeedSession, seedClaudeTranscripts } from "./helpers/seed";

const BACK_TO_SESSIONS = /Back to Sessions/i;

const SEEDED: SeedSession[] = [
  { sessionId: "sessions-e2e-alpha", slug: "sessions-e2e-alpha" },
  { sessionId: "sessions-e2e-bravo", slug: "sessions-e2e-bravo" },
  { sessionId: "sessions-e2e-charlie", slug: "sessions-e2e-charlie" },
];

test.describe("Sessions flow", () => {
  test("seeded sessions list, open detail, and navigate back", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-sessions-claude-")
    );
    seedClaudeTranscripts(claudeHome, SEEDED);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-sessions-e2e-",
      env: { CLAUDE_HOME: claudeHome },
    });

    try {
      await gotoNav(page, "sessions");

      // The Sessions view is a full-width, table-led page: its title shows only
      // in the Topbar breadcrumb, with no in-body <h1>. Assert the seeded rows
      // themselves. The importer crosses the utility-process boundary, so give
      // it room. The slug renders inside a larger row label (e.g. "e2e-project
      // (sessions-e2e-alpha)"), so match it as a substring.
      for (const session of SEEDED) {
        await expect(page.getByText(session.slug).first()).toBeVisible({
          timeout: 25_000,
        });
      }

      // Open the first session's detail by clicking its row. The shared list
      // renders each row as a link to desktopSessionDetailHashHref; clicking
      // the slug text inside it triggers the hash navigation.
      await page.getByText(SEEDED[0].slug).first().click();

      // The desktop detail wrapper renders a stable "Back to Sessions" link
      // regardless of the session's data — a reliable "detail mounted" signal.
      const backLink = page.getByRole("link", { name: BACK_TO_SESSIONS });
      await expect(backLink).toBeVisible({ timeout: 15_000 });

      // Back returns to the list. The slug also appears in the detail title, so
      // confirm we actually left the detail view: the detail-only "Back to
      // Sessions" link must be gone, and the list rows visible again.
      await backLink.click();
      await expect(backLink).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText(SEEDED[0].slug).first()).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
