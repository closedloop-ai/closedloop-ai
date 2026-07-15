/**
 * E2E flow (FEA-2939): the Desktop Insights view requires a manual "Load
 * insights" click before it populates, and no spec exercised that gate.
 *
 * `#/insights` ("Agent Monitoring") mounts a deliberately bounded surface: to
 * keep large local histories from blocking the renderer, it starts behind a gate
 * card and only mounts the paged session table once the user clicks "Load
 * insights" (see insights-view.tsx / desktop-insights-bounded-view.tsx). The
 * all-views smoke test asserts the shell renders, but nothing drove the load
 * interaction or verified the populated view shows real, numeric data.
 *
 * This spec seeds sessions straight into the SQLite store (the same DB-direct
 * path the Branches specs use — no importer WAL race), boots the app, clicks
 * "Load insights", and asserts the bounded table populates: the seeded rows
 * appear and the numeric "from-to of total" count footer reflects the corpus.
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
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEEDED: SessionListSeed[] = [
  { sessionId: "fea-2939-insights-alpha", name: "fea-2939 insights alpha" },
  { sessionId: "fea-2939-insights-bravo", name: "fea-2939 insights bravo" },
];

// The count footer renders "<from>-<to> of <total>". Seeding two sessions makes
// this deterministic ("1-2 of 2") and, crucially, non-zero — proving the load
// populated real data rather than rendering the "0-0 of 0" empty footer.
const POPULATED_COUNT_FOOTER = "1-2 of 2";

test.describe("Insights load-and-verify (FEA-2939)", () => {
  test("Load insights click populates the bounded session table", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-insights-load-claude-")
    );
    // Isolate CODEX_HOME too: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // inflating the seeded count footer this spec pins to "1-2 of 2".
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-insights-load-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-insights-load-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — the real Insights source reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "insights");

        // The view mounts behind the "Load insights" gate: the page title is
        // present, but the session table is not until the button is clicked.
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Agent Monitoring",
          })
        ).toBeVisible({ timeout: 30_000 });
        const loadButton = page.getByRole("button", { name: "Load insights" });
        await expect(loadButton).toBeVisible({ timeout: 15_000 });

        // Manual load — the interaction under test.
        await loadButton.click();

        // The bounded view mounted (lazy chunk resolved past "Loading insights...").
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: "Recent session activity",
          })
        ).toBeVisible({ timeout: 30_000 });

        // Populated, not the "No synced sessions found." empty state: the numeric
        // count footer reflects the seeded corpus. (The footer is the robust
        // populated-data signal; the table's name cell is `truncate min-w-0` and
        // collapses to zero width in this bounded Card, so its text can read as
        // hidden even though the row is present.)
        await expect(page.getByText(POPULATED_COUNT_FOOTER)).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByText("No synced sessions found.")).toHaveCount(
          0
        );

        // Each seeded session populated the table as a row linking to its detail.
        // (The responsive table renders a desktop + mobile copy per row, so assert
        // the link is attached rather than pinning an exact count.)
        for (const session of SEEDED) {
          await expect(
            page.locator(`a[href="#/sessions/${session.sessionId}"]`).first()
          ).toBeAttached();
        }

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
