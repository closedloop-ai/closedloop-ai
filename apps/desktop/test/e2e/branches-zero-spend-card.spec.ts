/**
 * Launched-Desktop proof for PRD-601 LIST-014: a zero-valued legacy usage row
 * without qualifying Build/Review/Rework activity evidence cannot prove a
 * canonical zero AI-spend result, so the card stays Unavailable rather than
 * fabricating $0 or claiming an empty cohort.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/web",
  branchName: "iss-4737-priced-to-zero-e2e",
  sessionId: "iss-4737-zero-spend-e2e-session",
} as const;

// Card labels, pinned as literals. They are `CARDS` entries in
// `packages/app/branches/components/branches-summary-cards.tsx`, not exported
// symbols — and a desktop e2e spec must not import main-process or workspace TS
// subpaths anyway (an extension-less `@repo/*` import aborts the WHOLE Electron
// suite at load time, before any test runs).
const SPEND_CARD_LABEL = "AI spend";
const ACTIVE_BRANCHES_CARD_LABEL = "Active branches";

// MetricCard's `valueUnavailableLabel` default (metric-card.tsx). Also not an
// exported symbol; the sibling `branches-median-pr-size.spec.ts` pins the same
// literal for the same reason, so the two can't drift the copy apart silently.
const METRIC_CARD_UNAVAILABLE_LABEL = "—";

// Any rendered currency at all. `$0`, `$0.00` and the sub-cent `$0.004` are the
// same fabricated figure at different precisions, so the negative assertion has to
// reject the dollar sign rather than one spelling of zero.
const CURRENCY_VALUE_PATTERN = /\$/;

test.describe("Branches AI spend canonical availability", () => {
  test("zero legacy usage without qualifying activity renders Unavailable", async () => {
    test.setTimeout(180_000);

    // Empty CLAUDE_HOME and CODEX_HOME so the boot collectors ingest nothing: the
    // corpus is exactly the one branch seeded below, and a developer's real
    // ~/.claude or ~/.codex history cannot leak priced sessions into the card.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-zero-spend-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-zero-spend-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-zero-spend-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      SEED.repoFullName,
    ]);
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      ...authorityServer.env,
    };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      // Seed while the app is DOWN. `costUsd: 0` writes a real priced-at-zero
      // `token_usage` row — the state under test, distinct from omitting it.
      await seedNoPullRequestBranch(userDataDir, {
        ...SEED,
        activityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        costUsd: 0,
      });

      // Launch 2 — the app reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        // The route mounted (the title lives only in the Topbar breadcrumb, so
        // scope to <header> or it also matches the sidebar nav entry).
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // Widen to "All time" so the seeded branch is in range. This ALSO decides
        // which cost source feeds the card: with no active window the map is built
        // from the `token_usage` aggregate this spec seeds, whereas an active
        // window builds it from `token_events` (not seeded), which would silently
        // exercise a different branch of the code.
        await page.locator('[aria-label="All time"]:visible').click();

        // Wait for the LOADED corpus BEFORE reading the card under test. This
        // ordering is load-bearing, not stylistic: while the branches read is in
        // flight every card renders a loading placeholder, so asserting the spend
        // card first could match the skeleton and pass without proving the data.
        // "Active branches" reporting an AVAILABLE 1 proves the read settled AND
        // that the corpus is non-empty (an empty one is "No data" everywhere,
        // which is the other way this test could pass vacuously).
        //
        // `:visible` is mandatory throughout: under keep-alive the Sessions view
        // stays mounted-but-hidden and renders its own summary-card row, so a
        // page-wide `[data-slot="card"]` match would resolve two cards and trip
        // strict mode.
        await expect(
          summaryCardValue(page, ACTIVE_BRANCHES_CARD_LABEL)
        ).toHaveText("1", { timeout: 30_000 });

        const spendValue = summaryCardValue(page, SPEND_CARD_LABEL);
        await expect(spendValue).toHaveText(METRIC_CARD_UNAVAILABLE_LABEL, {
          timeout: 30_000,
        });
        await expect(spendValue).not.toHaveText(CURRENCY_VALUE_PATTERN);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("branches-zero-spend-card.png"),
        });

        // No uncaught renderer errors (a blanked chunk would also fail the above).
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * The rendered VALUE of the one visible summary card labelled `label`. MetricCard
 * puts the label in `[data-slot="card-description"]` and the value in
 * `[data-slot="card-title"]`, both inside one `[data-slot="card"]`.
 */
function summaryCardValue(page: Parameters<typeof gotoNav>[0], label: string) {
  return page
    .locator('[data-slot="card"]:visible')
    .filter({ hasText: label })
    .locator('[data-slot="card-title"]');
}
