/**
 * E2E proof (ISS-5523): the distinguishable-series gate reaches the model usage
 * chart on the DESKTOP adapter, and the capped palette never paints a real model
 * in the colour reserved for the aggregate band.
 *
 * WHY THIS SPEC EXISTS, AND WHAT IT DELIBERATELY DOES NOT ASSERT (wongk review,
 * #4717). The review asked for "the >10-series case in the existing web and
 * Electron E2E harnesses". The >10-series case is NOT reachable on this surface
 * on either adapter, and seeding harder does not change that: the producers cap
 * the population before the renderer ever sees it.
 *
 *   - desktop: `buildModelSeries` (`src/main/database/local-insights-series.ts`)
 *     keeps `MAX_MODEL_SERIES = 6` plus one producer-side `"other"` bucket.
 *   - cloud:   `modelUsageSeries` (`apps/api/app/insights/service.ts`) has the
 *     identical `MAX_MODEL_SERIES = 6`.
 *
 * So `modelUsageOverTime` tops out at SEVEN series, the ISS-5523 fold (which
 * needs more than ten) never fires here, and no `Other models (N)` band can
 * render on the dashboard on either shell. Asserting one would mean seeding a
 * payload the product cannot emit — a test that passes for a reason production
 * never exercises. The fold itself is proven where it is genuinely reachable:
 * the fold kernel and rendered-chart suites under
 * `packages/app/insights/components/overview/__tests__/`.
 *
 * What IS real, production-reachable behaviour on this adapter — and what this
 * spec pins — is the palette REGIME. `TimeSeriesAreaChart` keys the regime on the
 * cap being REQUESTED, not on a fold having happened, so with the gate open the
 * chart leaves the wrapping `chartColor` cycle for the non-wrapping
 * `chartSeriesColor` order. That is a visible change for every desktop user the
 * flag reaches, and it is the seam that would silently break if the desktop
 * feature-flag path, the shared component, or the IPC insights read regressed.
 *
 * Three assertions, each able to fail on its own:
 *   1. gate open vs closed produce DIFFERENT fills — proves the flag actually
 *      reaches this chart through the desktop Labs registry → IPC → renderer
 *      path. Fails closed if the gate never arrives (fills would be identical).
 *   2. with the gate open, no drawn band wears `CHART_OTHER_SERIES_COLOR` — the
 *      reserved aggregate neutral. No band may wear it here, because nothing
 *      folded, so there is no aggregate band at all.
 *   3. with the gate open, every drawn band has a distinct fill.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CHART_DISTINGUISHABLE_SERIES_FLAG_KEY } from "@repo/api/src/types/chart-distinguishable-series-flag.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { insightsTrendSeedIso } from "./helpers/insights-trend-seed";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import { seedModelUsage } from "./helpers/seed-model-usage-db";

const SESSION_ID = "iss-5523-model-usage-series-cap-session";
// ISS-6268: relative to the run clock, never an absolute date — the Insights
// trend window is a ROLLING 90 days even on "All time", so a literal seed
// silently ages out and empties this chart.
const SEEDED_AT = insightsTrendSeedIso();

/**
 * Exactly six models — `MAX_MODEL_SERIES`, so the producer keeps all of them and
 * adds NO `"other"` bucket. Every drawn band is therefore a real model, which is
 * what lets assertion 2 say "no band may wear the neutral" without having to
 * carve out a producer-side "Other" series that is not the ISS-5523 aggregate.
 */
const MODELS = [
  "claude-opus-4-5",
  "gpt-5.4",
  "claude-sonnet-4-5",
  "gemini-3-pro",
  "gpt-5-mini",
  "claude-haiku-4",
] as const;

/**
 * The reserved aggregate colour, resolved by the real engine.
 *
 * `CHART_OTHER_SERIES_COLOR` is a `color-mix(in oklch, …)` over CSS custom
 * properties, so it only becomes a comparable value once something paints it.
 * Reading the literal string off the attribute would compare source text, not
 * colour, and would silently stop matching the moment the bundle downlevels the
 * colour space.
 */
async function resolveAggregateNeutral(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color =
      "color-mix(in oklch, var(--muted-foreground) 70%, var(--card))";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
}

/**
 * Computed fill of every drawn band in the model usage card.
 *
 * `.recharts-area-area` and NOT `.recharts-area path`: each `<Area>` emits TWO
 * paths — the filled body and the stroked curve — so the looser selector returns
 * two nodes per series, and the curve's computed `fill` is `none`.
 *
 * The count is awaited HERE, on the band paths this read actually consumes,
 * because `evaluateAll` is a one-shot DOM read that Playwright never retries: if
 * it lands before the bands are in the DOM it returns `[]` and the caller hard-
 * fails with a bare "Expected 6, Received 0" that names no selector. Waiting on
 * a proxy instead — the parent `.recharts-area` groups — does not cover it; the
 * group is a separate element from its curve, so a state with 6 groups and 0
 * band paths satisfies the proxy and still empties this read. The wait is
 * BOUNDED, so a chart that is genuinely empty still fails: this can only remove
 * a false red, never manufacture a green.
 */
async function modelChartFills(page: Page): Promise<string[]> {
  const bands = page.locator('[data-tour="models"] .recharts-area-area');
  await expect(bands).toHaveCount(MODELS.length, { timeout: 45_000 });
  return await bands.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).fill).filter(Boolean)
  );
}

async function openDashboard(page: Page): Promise<void> {
  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: "Welcome to Closedloop",
    })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No agent sessions yet")).toHaveCount(0);
  await dismissDesktopOnboardingOverlay(page);
  // Widen to "All time" so the past-dated seed is in range regardless of the
  // run clock.
  await page.locator('[aria-label="All time"]:visible').click();
  // Recharts animates areas in, so the card is only "open" once one series
  // group per model exists. This is the CARD-level checkpoint, not the guard for
  // the fill read — the band paths that read consumes are awaited in
  // `modelChartFills`, against their own selector.
  await expect(page.locator('[data-tour="models"] .recharts-area')).toHaveCount(
    MODELS.length,
    { timeout: 45_000 }
  );
}

test.describe("Dashboard model usage series cap (ISS-5523)", () => {
  test("opens the gate on the desktop dashboard chart without reusing the aggregate colour", async () => {
    test.setTimeout(300_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5523-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5523-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5523-udd-")
    );

    try {
      // Launch 1 — migrate the schema and skip the first-launch reveal/tour.
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

      // Seed while the app is DOWN: one substantive session, then one
      // token_usage row per model.
      await seedSessionsList(userDataDir, [
        { sessionId: SESSION_ID, at: SEEDED_AT, name: "ISS-5523 usage seed" },
      ]);
      await seedModelUsage(userDataDir, {
        models: MODELS,
        sessionId: SESSION_ID,
      });

      // Launch 2 — gate CLOSED. The pre-ISS-5523 wrapping palette.
      const closed = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      let closedFills: string[] = [];
      try {
        await openDashboard(closed.page);
        closedFills = await modelChartFills(closed.page);
        expect(closed.pageErrors).toEqual([]);
      } finally {
        await closed.cleanup();
      }
      expect(closedFills.length).toBe(MODELS.length);

      // Launch 3 — gate OPEN via the desktop Labs registry.
      const open = await launchDesktopApp({
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [CHART_DISTINGUISHABLE_SERIES_FLAG_KEY]: true,
          });
        },
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openDashboard(open.page);
        const openFills = await modelChartFills(open.page);
        const neutral = await resolveAggregateNeutral(open.page);

        expect(openFills.length).toBe(MODELS.length);

        // 1. The gate reached this chart on THIS adapter. If the desktop flag
        //    path regressed, the chart would keep the closed-gate palette and
        //    these would be identical.
        expect(openFills).not.toEqual(closedFills);

        // 2. Nothing folded (six series, cap ten), so there is no aggregate
        //    band — and therefore no band may wear the aggregate's neutral. A
        //    real model wearing it is the defect this ticket is about.
        expect(neutral).toBeTruthy();
        expect(openFills).not.toContain(neutral);

        // 3. Every drawn band keeps its own fill.
        expect(new Set(openFills).size).toBe(openFills.length);

        await open.page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-model-usage-series-cap.png"),
        });

        expect(open.pageErrors).toEqual([]);
      } finally {
        await open.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
