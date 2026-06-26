/**
 * E2E regression: a branch's "Updated" reflects the session's real activity
 * time, NOT the time the desktop last scanned the transcript (FEA-2022).
 *
 * The historical importer stamps each `session_artifact_links.observed_at` with
 * wall-clock scan time. The Branches list previously derived a branch's
 * `updatedAt` straight from that column, so a branch last worked weeks ago
 * showed "just now" the moment the app re-imported it. The fix derives the
 * branch's `updatedAt` from the linked sessions' real activity timestamps
 * (started/ended), which the parser takes from the transcript turns.
 *
 * We seed a single session whose transcript turns are dated ~35 days in the
 * past, then assert the Branches row shows that past date — not a fresh
 * relative label.
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

// Dated well over a week before any plausible run date so the relative-time
// formatter renders an absolute locale date (which always contains the year)
// rather than a "just now" / "Nm ago" / "Nh ago" / "Nd ago" label.
const PAST_TURN_TIMESTAMP = "2026-05-15T12:00:00.000Z";
const PAST_YEAR = "2026";
const SEEDED_BRANCH = "barry/updatedat-regression";
const SEEDED_SLUG = "branch-updatedat-e2e";
const FRESH_LABEL_RE = /just now|\b\d+m ago\b|\b\d+h ago\b/;

test.describe("Branch updatedAt (FEA-2022)", () => {
  test("branch Updated reflects session activity time, not scan time", async () => {
    test.setTimeout(90_000);
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-updatedat-claude-")
    );
    seedClaudeTranscripts(
      claudeHome,
      [
        {
          sessionId: "branch-updatedat-e2e-session",
          slug: SEEDED_SLUG,
          gitBranch: SEEDED_BRANCH,
          timestamp: PAST_TURN_TIMESTAMP,
        },
      ],
      "branch-updatedat-project"
    );

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-branch-updatedat-e2e-",
      env: { CLAUDE_HOME: claudeHome },
    });

    try {
      await gotoNav(page, "branches");
      // The full-width Branches view shows its title only in the Topbar
      // breadcrumb (no in-body <h1>); assert that to confirm the route mounted.
      // Scoped to <header> so it can't match the sidebar nav button.
      await expect(
        page.locator("header").getByText("Branches", { exact: true })
      ).toBeVisible({ timeout: 30_000 });

      // The seeded activity is ~35-40 days old, but the Branches list defaults
      // to a 7-day time window — widen it to "All time" so the seeded branch is
      // in range (this test asserts the Updated value, not the window itself).
      // `:visible` scopes to the Branches toolbar: keep-alive views (e.g. the
      // Sessions view) stay mounted-but-hidden and also render this control.
      await page.locator('[aria-label="All time"]:visible').click();

      // The seeded branch lands once the boot-time import finishes. Anchor on
      // the Branches table's detail link so branch text shown in linked session
      // rows cannot make the grid-row locator ambiguous.
      const branchLink = page
        .locator('a[href^="#/branches/"]')
        .filter({ hasText: SEEDED_BRANCH });
      const branchRow = page.locator("div.grid.h-11").filter({
        has: branchLink,
      });
      await expect(branchRow).toBeVisible({ timeout: 20_000 });

      // The row's lone `text-muted-foreground text-xs` span is its "Updated"
      // cell. It must show the past activity date (a locale date string carries
      // the year) — NOT a fresh scan-time label like "just now" / "Nm ago".
      // Chips in the row (Status, Linked Sessions) also carry `text-xs`; the
      // Updated label is the plain span with no `data-slot`.
      const updatedLabel = branchRow.locator(
        "span.text-muted-foreground.text-xs:not([data-slot])"
      );
      await expect(updatedLabel).toHaveText(new RegExp(PAST_YEAR), {
        timeout: 20_000,
      });
      await expect(updatedLabel).not.toHaveText(FRESH_LABEL_RE);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      fs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});
