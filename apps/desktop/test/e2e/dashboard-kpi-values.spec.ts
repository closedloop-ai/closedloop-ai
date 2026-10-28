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
 * computes from it.
 *
 * The seeded session is SUBSTANTIVE by default: without an activity signal
 * FEA-3284's `quality=substantive` list read classifies it as an idle phantom
 * row, the Dashboard never leaves its empty state, and every assertion below
 * fails. The signal is a synthetic `PreToolUse` tool event (FEA-1421) — no
 * `token_usage` is seeded, which is why COST stays $0.00 below.
 *
 * Card values:
 *   - SESSIONS      = "1"      (COUNT of the one seeded session in range)
 *   - COST          = a "$…" currency (no token_usage seeded → $0.00, but the
 *                     assertion tolerates formatting; it proves the card renders
 *                     a value, not the "—" placeholder)
 *   - MEDIAN PR SIZE = "—"     (no enriched pull_request artifact → median null)
 *   - KLOC          = "—"     (ISS-5412: the seeded PR carries no line counts at
 *                     all, so the sum has nothing to read — unknown, not zero)
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
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action.ts";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy.ts";
import {
  DESKTOP_RECENT_SESSIONS_DESCRIPTION,
  DESKTOP_RECENT_SESSIONS_TITLE,
  DESKTOP_SYNCED_SESSIONS_TITLE,
  WEB_RECENT_SESSIONS_TITLE,
} from "@repo/app/insights/components/overview/recent-sessions-copy.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2939-dashboard-kpi-e2e",
  sessionId: "fea-2939-dashboard-kpi-e2e-session",
  prNumber: 2939,
  closedAt: "2026-05-15T12:00:00.000Z",
} as const;

const CURRENCY_VALUE = /^\$/;

/** The value span the MetricCard renders (label lives in card-description). */
/**
 * The stats row's GitHub-truth tiles — `kpi:merged`, `kpi:pr-size`, `kpi:kloc`
 * — all gated when signed out (ISS-7866). `kpi:sessions` and `kpi:cost` are
 * local and stay live, which is what keeps the count assertions honest.
 */
const GATED_STATS_TILE_COUNT = 3;
/**
 * The gated CARD's verb, read from the canonical map rather than spelled here —
 * this spec is not policing the copy, so a reword should move it rather than
 * redden it. `dashboard-github-gating.spec.ts` is the one that keeps the literal
 * on purpose (tamsinb review on #8169).
 */
const GATED_CONNECT_CTA_LABEL =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardCtaLabel ??
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel;
/** `value={null}` renders `MetricCard`'s muted no-data glyph. */
const GATED_VALUE_TEXT = "No data";

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
      await seedClosedAtOnlySinglePrBranch(userDataDir, SEED);

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
            name: DASHBOARD_HEADING,
          })
        ).toBeVisible({ timeout: 30_000 });

        // Data present, so the dashboard is NOT in its empty state.
        await expect(page.getByText("No agent sessions yet")).toHaveCount(0);

        // Widen to "All time" so the past-dated seed is in range regardless of
        // the run clock.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        // SESSIONS = 1 — the load-bearing, non-empty assertion.
        await expect(kpiValue(page, "Sessions")).toHaveText("1", {
          timeout: 45_000,
        });
        // ISS-9996: the local, unbounded card names its source, not recency.
        const sessions = page.locator('[data-tour="sessions"]');
        await expect(
          sessions.getByText(DESKTOP_RECENT_SESSIONS_TITLE, { exact: true })
        ).toBeVisible();
        const caption = sessions.getByText(
          DESKTOP_RECENT_SESSIONS_DESCRIPTION,
          { exact: true }
        );
        await expect(caption).toBeVisible();
        await expect(caption).not.toContainText("latest");
        await expect(
          sessions.getByText(WEB_RECENT_SESSIONS_TITLE, { exact: true })
        ).toHaveCount(0);
        await expect(
          sessions.getByText(DESKTOP_SYNCED_SESSIONS_TITLE, { exact: true })
        ).toHaveCount(0);
        // BEHAVIOR CHANGE (ISS-7866). These two tiles used to assert "—" here:
        // FEA-2923 and ISS-5412 established that an unsized captured-PR cohort
        // must render the honest empty rather than a measured 0, and that claim
        // still holds — but it is no longer the claim this signed-out profile
        // can make. `kpi:pr-size` and `kpi:kloc` are GitHub-truth tiles now, and
        // signed out resolves to a definite Disconnected, so the whole row's
        // GitHub-derived half is GATED: no value at all, and an ask instead.
        //
        // Their labels moved too. A gated card is named by the CATALOG title,
        // not by the local producer's "Median captured PR size" / "KLOC
        // captured" — labelling the ask with the captured population would
        // promise that connecting GitHub lights up a local-capture median. So
        // this asserts the gated STATE across the row rather than re-guessing
        // three labels.
        const statsCards = page.locator(
          '[data-tour="stats"] [data-slot="card"]'
        );
        await expect(
          statsCards.getByRole("button", {
            exact: true,
            name: GATED_CONNECT_CTA_LABEL,
          })
        ).toHaveCount(GATED_STATS_TILE_COUNT);
        // And the gated cards withdraw the value rather than dashing it, which
        // is what distinguishes "we cannot see this" from FEA-2923's "we looked
        // and there was nothing to average".
        await expect(
          statsCards.filter({ hasText: GATED_VALUE_TEXT })
        ).toHaveCount(GATED_STATS_TILE_COUNT);
        // COST is local and ungated — it still renders a currency value. The
        // counterweight: without it, the assertions above would pass just as
        // well against a dashboard that gated every tile, or rendered none.
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
