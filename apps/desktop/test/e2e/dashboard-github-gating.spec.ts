/**
 * E2E visual proof: the Desktop Dashboard gates GitHub-truth metrics when the
 * desktop GitHub data connection is disconnected.
 *
 * The regression this covers was mounted-surface-specific: the shared Insights
 * page had gating logic, but Desktop users see the Dashboard, whose local scope
 * previously forced GitHub-truth KPI tiles to Available. This test launches the
 * real built Electron app, seeds a real local session into the SQLite store so
 * the Dashboard renders rows instead of the empty state, then confirms the
 * visible Dashboard shows the shared gated-connect affordance — wearing the
 * verb that matches what a click actually does from a signed-out app.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action.ts";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * ISS-7866 REVERSES the ISS-5958 M4 contract this spec used to assert.
 *
 * M4's reasoning was sound on its own terms — signed out, the flow creates an
 * account before it can open GitHub's authorize page, and a control labelled
 * "Connect GitHub" hid that step. What it could not see from one surface is the
 * cost across surfaces: the Sessions strip meanwhile asked the same signed-out
 * reader to "Sign in", so one person at one moment met two different verbs for
 * one wall depending on which screen they were on. The
 * `pre-auth-desktop-onboarding` prototype settles it — pre-auth cards ask to
 * connect — and the account step is named by the flow, not the card.
 *
 * ISS-11476 then settled the WORDING of that card ask against the reporter's
 * `web-master` dashboard prototype: a gated card reads "Connect to GitHub",
 * inline in a sentence, not the bare verb the other placements use. The literal
 * stays spelled here deliberately — this spec polices the copy, and
 * `github-connect-copy.test.ts` pins the same string to the canonical map.
 *
 * The retired label is asserted absent, the same way M4 asserted the one it
 * replaced.
 */
const CONNECT_GITHUB_LABEL = "Connect to GitHub";
const RETIRED_SIGN_UP_LABEL = "Sign up with GitHub";
/**
 * The `gatedMetricExplanation` sentence belongs to the `centered`/`banner`
 * variants only, and is asserted ABSENT below: a gated card restating the label
 * its own header already carries is what ISS-7866 removed.
 */
const GATED_METRIC_SENTENCE =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation;
/**
 * What a gated DASHBOARD card says instead, per ISS-11476's acceptance
 * criteria — the sentence the reporter's prototype draws after the link. Scoped
 * to the dashboard's cards: the Insights grid's cloud KPI tiles do not opt in.
 */
const GATED_CARD_SENTENCE =
  GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].cardSupportingCopy ?? "";
const SEED = {
  repoFullName: "acme/web",
  branchName: "fea-2383-dashboard-gating-e2e",
  sessionId: "dashboard-github-gating-e2e-session",
  prNumber: 2383,
  closedAt: "2026-07-07T12:00:00.000Z",
} as const;

/** Cost per merged PR, Tokens per KLOC and Top repo — Top model reads no GitHub data. */
const AI_IMPACT_GITHUB_METRIC_COUNT = 3;
/** `MetricCard`'s no-value label; a literal because specs cannot import the component module. */
const NO_DATA_TEXT = "No data";
/** The catalog title of the dashboard's repo chart. */
const REPO_CHART_TITLE = "Merged PRs by repository";

test.describe("Dashboard GitHub metric gating", () => {
  test("renders the Connect GitHub affordance on the real Desktop Dashboard", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-gating-udd-")
    );

    try {
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

      await seedClosedAtOnlySinglePrBranch(userDataDir, SEED);

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
        await expect(page.getByText("No agent sessions yet")).toHaveCount(0);

        await expect(
          page
            .getByRole("button", { exact: true, name: CONNECT_GITHUB_LABEL })
            .first()
        ).toBeVisible({ timeout: 45_000 });
        await expect(
          page.getByRole("button", {
            exact: true,
            name: RETIRED_SIGN_UP_LABEL,
          })
        ).toHaveCount(0);
        await expect(page.getByText(GATED_METRIC_SENTENCE)).toHaveCount(0);
        // …and the sentence the ticket DOES ask a gated dashboard card for is
        // on screen. Without this, the absence assertion above would also pass
        // on a card that lost both sentences.
        await expect(page.getByText(GATED_CARD_SENTENCE).first()).toBeVisible();

        // ISS-12638: AI Impact's three GitHub-dependent metrics and the repo
        // chart wear the same ask; Top model by cost reads no GitHub data and
        // keeps its own value, which is what keeps these counts honest.
        const impact = page.locator('[data-tour="impact"]');
        await expect(
          impact.getByRole("button", {
            exact: true,
            name: CONNECT_GITHUB_LABEL,
          })
        ).toHaveCount(AI_IMPACT_GITHUB_METRIC_COUNT);
        await expect(
          impact.getByText(NO_DATA_TEXT, { exact: true })
        ).toHaveCount(AI_IMPACT_GITHUB_METRIC_COUNT);
        await expect(
          page
            .locator('[data-slot="card"]')
            .filter({ hasText: REPO_CHART_TITLE })
            .getByRole("button", { exact: true, name: CONNECT_GITHUB_LABEL })
        ).toHaveCount(1);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-github-gating.png"),
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
