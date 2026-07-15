/**
 * E2E test: Desktop Agents view loads and renders (T-10.12).
 *
 * Guards the lazy AgentsView chunk in the desktop renderer: the renderer
 * bundles `@repo/app` agents modules whose self-referencing `@repo/app/…`
 * imports only resolve through the alias in vite.renderer.config.ts. A
 * resolution regression surfaces as an uncaught chunk-evaluation page error
 * and a blank screen — something typecheck and the build cannot catch.
 *
 * The Agents view is feature-flag-gated via `hiddenNavIds` (no DesktopFeatureFlagGate
 * component on desktop). In an unbuilt / fresh-launch state the view may not
 * be reachable via the sidebar, so these tests drive it with hash routing
 * (the same mechanism `gotoNav` uses for all Labs-area views).
 *
 * Covers:
 *  - Navigating to the Agents view renders without page errors (chunk loads).
 *  - The list view renders a stable shell element (summary card or loading state).
 *  - Navigating to an agent detail hash renders without page errors.
 *  - No uncaught renderer errors on either route.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "../test/e2e/helpers/desktop-app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to a detail hash route using the same hash-routing mechanism as
 * `gotoNav`. The desktop router matches `#/agents/:id` and renders
 * AgentDetailView when `AgentsView` is mounted.
 */
async function gotoAgentDetail(
  page: import("@playwright/test").Page,
  agentSlug: string
): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `/agents/${id}`;
  }, agentSlug);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Agents desktop view", () => {
  test("navigating to Agents renders without page errors", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-agents-e2e-",
    });

    try {
      await gotoNav(page, "agents");

      // The Agents view renders summary cards regardless of whether the
      // local DB has component rows. "Components" is a stable MetricCard
      // label in AgentsSummaryCards that renders for every list state
      // (loading, empty, or data). If the chunk fails to evaluate, the
      // renderer throws an uncaught error and the card never appears —
      // both the card assertion and pageErrors check guard that case.
      //
      // Use a generous timeout since the app must launch + evaluate the
      // lazy chunk before anything renders.
      await expect(page.getByText("Components", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("navigating to an agent detail hash renders without page errors", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-agents-detail-e2e-",
    });

    try {
      // First navigate to the list so the module chunk is loaded.
      await gotoNav(page, "agents");
      await expect(page.getByText("Components", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // Navigate to a synthetic detail slug. The desktop detail view
      // will attempt to fetch via the HTTP data source. In an offline /
      // cloud-disconnected launch (cloudConnectionEnabled: false, which
      // `seedE2eDesktopSettings` sets), the HTTP call will fail and the
      // view renders an error state — "Component not found." — rather
      // than the properties panel. Either outcome is acceptable here; the
      // purpose of this spec is to guard the chunk-evaluation path and
      // confirm no uncaught renderer error fires.
      await gotoAgentDetail(page, "test-agent-slug-e2e");

      // A short settle period lets the renderer resolve the route and
      // evaluate any newly-needed lazy sub-chunks without blocking on
      // a data-fetch that will fail in this offline state.
      await page.waitForTimeout(2000);

      // No uncaught renderer errors from chunk evaluation.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
