/**
 * Desktop E2E for PRD-601 LIST-013: a local single-PR branch with no stored LOC
 * renders Unavailable rather than a fabricated zero. The seeded PR row carries
 * only `closed_at`; the local store derives no merged state from it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import {
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// A distinctive, non-default branch name (default branches — main/master/… — are
// hidden by the Branches PR read). The `closed_at` instant is a stable past date; the
// test widens the window to "All time" so this is in range regardless of clock.
const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2159-median-pr-size-e2e",
  sessionId: "median-pr-size-e2e-session",
  prNumber: 2159,
  closedAt: "2026-05-15T12:00:00.000Z",
} as const;

// The card value must be a plain integer string (e.g. "0"), not a placeholder.
const NUMERIC_CARD_VALUE = /^\d+$/;

// The muted no-data glyph MetricCard renders for a genuine no-data metric (a
// nullish `value`) since FEA-4236 — mirrors the component's `valueUnavailableLabel`
// default, now exported as `METRIC_CARD_NO_DATA_LABEL` in metric-card.tsx. Kept as
// a local literal because specs cannot import the component module.
const METRIC_CARD_UNAVAILABLE_LABEL = "No data";

// Mirrors `BRANCH_UNAVAILABLE_LABEL` in packages/app; a `@repo/app` import would
// abort the whole e2e suite under the spec loader (test/AGENTS.md → Import hazard).
const BRANCH_UNAVAILABLE_LABEL = "Unavailable";

test.describe("Branches Median PR size card (FEA-2949)", () => {
  test("single-PR branch with no stored LOC renders Unavailable, not 0", async () => {
    test.setTimeout(180_000);

    // An EMPTY CLAUDE_HOME so the importer ingests nothing — the corpus is
    // exactly the one branch we seed.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-median-pr-size-claude-")
    );
    // ISS-7697: `launchDesktopApp` inherits `process.env`, so pinning only
    // CLAUDE_HOME leaves Cursor, Copilot and OpenCode resolving under
    // `os.homedir()` — the operator's REAL local sessions would join the corpus
    // this card's metric is computed over, and "the importer ingests nothing"
    // above would simply be untrue.
    const harnessHomesRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-median-pr-size-homes-")
    );
    // A user-data dir we own across BOTH launches (seed between them).
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-median-pr-size-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: {
          ...isolatedHarnessHomes(harnessHomesRoot),
          // …except Claude's, which IS the (empty) corpus under test.
          CLAUDE_HOME: claudeHome,
        },
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      // Seed the single-PR branch with no stored LOC while the app is DOWN.
      await seedClosedAtOnlySinglePrBranch(userDataDir, SEED);

      // Launch 2 — the app reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        userDataDir,
        keepUserDataDir: true,
        env: {
          ...isolatedHarnessHomes(harnessHomesRoot),
          // …except Claude's, which IS the (empty) corpus under test.
          CLAUDE_HOME: claudeHome,
        },
      });

      try {
        await gotoNav(page, "branches");
        // Confirm the Branches route mounted (title lives only in the Topbar
        // breadcrumb); scoped to <header> so it can't match the sidebar nav.
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // Widen to "All time" so the seeded (past-dated) branch is in range and
        // the analytics cards reflect the whole corpus — the same control the
        // table uses.
        await widenToAllTime(page);

        // The specific "Median PR size" card. MetricCard renders the label in a
        // `[data-slot="card-description"]` and the value in
        // `[data-slot="card-title"]` inside one `[data-slot="card"]`, so scope by
        // the label, then read the value. Scope to `:visible` cards: the Sessions
        // bar owns its OWN "Median PR size" card (FEA-3574 dual-home), and the
        // default Sessions view stays mounted-but-hidden under keep-alive, so a
        // page-wide `[data-slot="card"]` match would collide with that hidden
        // sibling. `:visible` keeps this on the active Branches surface (the same
        // reason the date-range control above is scoped `:visible`).
        const medianCard = page
          .locator('[data-slot="card"]:visible')
          .filter({ hasText: "Median PR size" });
        await expect(medianCard).toBeVisible({ timeout: 30_000 });
        const medianValue = medianCard.locator('[data-slot="card-title"]');

        // The local store holds no LOC, so the figure is unknown rather than
        // zero. LIST-013 requires Unavailable.
        await expect(medianValue).toHaveText(METRIC_CARD_UNAVAILABLE_LABEL, {
          timeout: 30_000,
        });
        await expect(medianValue).not.toHaveText("0");
        // Belt-and-suspenders: the value is unavailable, not a number.
        await expect(medianValue).not.toHaveText(NUMERIC_CARD_VALUE);

        // ISS-12594: the PR has no stored LOC and Desktop stores no cloud
        // GitHub data, so the row's Changes cell shows the shared unavailable
        // word instead of a fabricated +0/−0.
        const branchRow = page
          .locator("tr:visible, [role='row']:visible")
          .filter({ hasText: SEED.branchName })
          .first();
        await expect(branchRow).toBeVisible({ timeout: 30_000 });
        // Scoped to the Changes cell, never the row: lastActivity, repo,
        // priority, tags and project render the same unavailable word, so a
        // row-wide match still passes with Changes back at +0/−0. The role is
        // `gridcell` because GridTableV2 body cells carry GRID_NAV_CELL_ROLE;
        // `role="cell"` is the v1 GridTable and matches nothing on this surface.
        const changesCell = branchRow.locator(
          '[role="gridcell"][data-column-id="changes"]'
        );
        // Proves the locator resolved, so the assertion under it cannot pass
        // vacuously on a selector that matched no cell at all.
        await expect(changesCell).toBeVisible({ timeout: 30_000 });
        await expect(
          changesCell.getByText(BRANCH_UNAVAILABLE_LABEL, { exact: true })
        ).toBeVisible();

        // Screenshot into Playwright's per-test output dir (portable across
        // machines/CI; CI uploads test-results-e2e/ on failure). Not a hardcoded
        // absolute path, which would break on other runners.
        await page.screenshot({
          path: test.info().outputPath("median-card-e2e.png"),
          fullPage: true,
        });

        // No uncaught renderer errors (a blanked chunk would also fail the above).
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    }
  });
});
