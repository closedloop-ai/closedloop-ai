/**
 * E2E proof (FEA-2939): the Desktop Dashboard KPI cards render VALUES computed
 * from a seeded local corpus.
 *
 * dashboard-computed-badge.spec.ts asserts a badge's ABSENCE and
 * dashboard-github-gating.spec.ts asserts the gated card's Connect-GitHub
 * affordance, but nothing asserted the numeric VALUE of the always-local KPI
 * cards (SESSIONS, COST, MEDIAN PR SIZE, KLOC) against a known corpus — so a
 * regression that zeroed, dashed, or mis-wired those tiles would pass CI.
 *
 * This seeds the exact FEA-2159 corpus (one MERGED, single-PR, LOC-un-enriched
 * branch) into the app's SQLite store while the app is DOWN, boots the real
 * Dashboard, and asserts the stats-row card values the local insights backend
 * computes from it:
 *   - SESSIONS      = "1"      (COUNT of the one seeded session in range)
 *   - COST          = a "$…" currency (no token_usage seeded → $0.00, but the
 *                     assertion tolerates formatting; it proves the card renders
 *                     a value, not the "—" placeholder)
 *   - MEDIAN PR SIZE = "0"     (no enriched pull_request artifact → median 0)
 *   - KLOC          = "0"      (no captured PR LOC → 0.0 → "0")
 *
 * SESSIONS = "1" is the load-bearing assertion: it is non-empty and non-zero, so
 * it fails closed against both the empty-state ("No agent sessions yet") and a
 * broken projection. The card values are read the same way the real MetricCard
 * renders them (label in [data-slot="card-description"], value span inside
 * [data-slot="card-title"]), scoped to the stats row so the "Recent Sessions"
 * panel and charts can't satisfy the locators.
 *
 * The GitHub-gated "Captured PRs" tile in the same row is intentionally NOT
 * asserted here — that is dashboard-github-gating.spec.ts's job.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedMergedUnenrichedSinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2939-dashboard-kpi-e2e",
  sessionId: "fea-2939-dashboard-kpi-e2e-session",
  prNumber: 2939,
  mergedAt: "2026-05-15T12:00:00.000Z",
} as const;

const CURRENCY_VALUE = /^\$/;

/** The value span the MetricCard renders (label lives in card-description). */
function kpiValue(page: Page, label: string): Locator {
  return page
    .locator('[data-tour="stats"] [data-slot="card"]')
    .filter({ hasText: label })
    .locator('[data-slot="card-title"] span')
    .first();
}

test.describe("Dashboard KPI values (FEA-2939)", () => {
  test("renders numeric KPI card values from a seeded corpus", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-kpi-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-kpi-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-kpi-udd-")
    );

    try {
      // Launch 1 — migrate the schema, then set the onboarding flags so the
      // relaunch skips the first-launch reveal/tour and renders the KPI tiles
      // immediately (same approach as dashboard-github-gating.spec.ts).
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await first.page.evaluate(
          ([onboardedKey, tourSeenKey]) => {
            localStorage.setItem(onboardedKey, "1");
            localStorage.setItem(tourSeenKey, "1");
          },
          [dashboardOnboardedStorageKey, dashboardTourSeenStorageKey]
        );
      } finally {
        await first.cleanup();
      }

      // Seed the un-enriched merged single-PR branch while the app is DOWN.
      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED);

      // Launch 2 — the real Dashboard reads the seeded corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "dashboard");

        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Welcome to Closedloop",
          })
        ).toBeVisible({ timeout: 30_000 });

        // Data present, so the dashboard is NOT in its empty state.
        await expect(page.getByText("No agent sessions yet")).toHaveCount(0);

        // Widen to "All time" so the past-dated seed is in range regardless of
        // the run clock. `:visible` scopes to the mounted Dashboard.
        await page.locator('[aria-label="All time"]:visible').click();

        // SESSIONS = 1 — the load-bearing, non-empty assertion.
        await expect(kpiValue(page, "Sessions")).toHaveText("1", {
          timeout: 45_000,
        });
        // MEDIAN PR SIZE = — (FEA-2923): no enriched pull_request artifact is
        // seeded, so the delivery median has nothing to average and renders the
        // honest empty state, not a misleading 0. (KLOC below is a SUM, so it
        // stays 0.)
        await expect(kpiValue(page, "Median PR size")).toHaveText("—");
        // KLOC = 0 (no captured PR LOC).
        await expect(kpiValue(page, "KLOC captured")).toHaveText("0");
        // COST renders a currency value (not the "—" placeholder).
        await expect(kpiValue(page, "Cost")).toHaveText(CURRENCY_VALUE);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-kpi-values.png"),
        });

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
