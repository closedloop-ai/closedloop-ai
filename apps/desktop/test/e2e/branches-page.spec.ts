/**
 * E2E test: Branches page loads and renders.
 *
 * Guards the lazy BranchesView chunk: the renderer bundles `@repo/app`
 * branches modules whose self-referencing `@repo/app/…` imports only resolve
 * through the alias in vite.renderer.config.ts. A resolution regression
 * surfaces as an uncaught chunk-evaluation page error and a blank screen —
 * something typecheck and the build cannot catch (Rollup externalizes
 * unresolved specifiers with only a warning).
 *
 * Branches is always available in the desktop app (no longer feature-flag-gated):
 * the nav entry and the page render regardless of build type, so this test also
 * guards that the page body mounts and its chunk evaluates cleanly.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

test.describe("Branches page", () => {
  test("navigating to Branches renders without page errors", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-branches-e2e-",
    });

    try {
      // Navigate via hash routing — same mechanism as the sidebar.
      await gotoNav(page, "branches");

      // Assert a BranchesView-owned element — the summary cards render for
      // every branches state (data, empty, or error). NOT the Topbar
      // breadcrumb: App.tsx renders the Topbar from the route's navId regardless
      // of whether the page body mounted, so a breadcrumb check would pass on a
      // blank body and miss the chunk-evaluation regression this spec guards.
      // "AI spend" is a GitHub-free card that always renders (FEA-2051 removed
      // the GitHub-gated "Active PRs" card this guard previously keyed on).
      await expect(page.getByText("AI spend", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // The table is now wired to the local IPC branches source (A4), so the
      // removed BRANCH_SAMPLE_ROWS no longer render. A fresh launch has no local
      // branches, so assert the sample rows are absent. (The visible empty/
      // degraded state is "No branches yet." when the local source resolves, or a
      // load-failure message if capture is off — both are acceptable here; the
      // chunk-evaluation guard below is this spec's real purpose.)
      await expect(
        page.getByText("agent/repo-overrides-workspace-config")
      ).toHaveCount(0);

      // The lazy chunk loaded and evaluated cleanly. An unresolved bare
      // specifier (the regression this spec guards) throws an uncaught
      // error during chunk evaluation and blanks the renderer.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
