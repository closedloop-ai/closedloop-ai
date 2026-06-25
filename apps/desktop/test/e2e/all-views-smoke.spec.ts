/**
 * E2E smoke test: every top-level nav view mounts and renders without errors.
 *
 * Drives the renderer through all 17 nav ids via hash routing (the sidebar is
 * in FOCUS_MODE, so most destinations are only reachable by hash, not click).
 * For each view it asserts:
 *   - the Topbar breadcrumb shows the view's label (a data-independent signal
 *     that the route resolved and the shell rendered), and
 *   - where the view has a stable static heading, that heading is visible, and
 *   - no uncaught renderer error fired while that view's lazy chunk evaluated
 *     (the regression branches-page.spec.ts guards, generalized to all views).
 *
 * Uses one app launch and soft assertions so a single broken view is reported
 * without masking the rest. Views render from an empty local DB, so this is a
 * "renders cleanly / correct empty state" pass; data-backed flows live in the
 * sessions/approvals/settings specs.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

type ViewCase = {
  navId: string;
  /** Topbar breadcrumb label (from nav-config NAV_ENTRIES). */
  label: string;
  /** Static heading rendered in the view body, if any. */
  heading?: { name: string; level: 1 | 2 };
};

// Order mirrors NAV_ENTRIES. Labels come from nav-config; headings from each
// view's PageShell `title` (<h1>) or panel <h2>. Data-driven views built on
// shared @repo/app components (Kanban, Activity, Requests) have no stable
// static heading — the Topbar label + page-error guard cover those.
const VIEWS: ViewCase[] = [
  {
    navId: "dashboard",
    label: "Dashboard",
    // The first-launch dashboard renders its PageShell title as an <h1>.
    heading: { name: "Welcome to Closedloop", level: 1 },
  },
  { navId: "kanban", label: "My Issues" },
  // Sessions and Branches are full-width, table-led views whose title shows
  // only in the Topbar breadcrumb (no in-body <h1>) — the label assertion
  // covers them, and the page-error guard covers their lazy @repo/app chunks.
  { navId: "sessions", label: "Sessions" },
  { navId: "branches", label: "Branches" },
  { navId: "activity", label: "Activity" },
  {
    navId: "insights",
    label: "Insights",
    heading: { name: "Agent Monitoring", level: 1 },
  },
  {
    navId: "workflows",
    label: "Workflows",
    heading: { name: "Workflows", level: 1 },
  },
  { navId: "packs", label: "Packs", heading: { name: "Packs", level: 1 } },
  { navId: "skills", label: "Skills", heading: { name: "Skills", level: 1 } },
  { navId: "tools", label: "Tools", heading: { name: "Tools", level: 1 } },
  {
    navId: "subagents",
    label: "SubAgents",
    heading: { name: "SubAgents", level: 1 },
  },
  { navId: "plans", label: "Plans", heading: { name: "Plans", level: 1 } },
  {
    navId: "pull-requests",
    label: "Pull Requests",
    heading: { name: "Pull Requests", level: 1 },
  },
  {
    navId: "approvals",
    label: "Approvals",
    heading: { name: "Approvals", level: 2 },
  },
  { navId: "requests", label: "Requests" },
  {
    navId: "diagnostics",
    label: "Diagnostics",
    heading: { name: "Diagnostics", level: 2 },
  },
  {
    navId: "settings",
    label: "Settings",
    heading: { name: "Settings", level: 2 },
  },
];

test.describe("All views smoke", () => {
  test("every nav view mounts, renders its shell, and throws no page errors", async () => {
    // One launch drives all 17 views with up to two 15s-timeout assertions
    // each. The 60s per-test default would be exhausted by a handful of timed-
    // out assertions and Playwright would kill the test mid-loop — defeating
    // the soft-assertion design (one broken view shouldn't mask the rest).
    // Give the loop enough runway to reach every view even in that worst case.
    test.setTimeout(240_000);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-smoke-e2e-",
    });

    try {
      for (const view of VIEWS) {
        const errorsBefore = pageErrors.length;

        await gotoNav(page, view.navId);

        // Topbar breadcrumb label — present on every view regardless of data.
        // Scoped to <header> so it can't match a sidebar nav button of the
        // same name.
        await expect
          .soft(
            page.locator("header").getByText(view.label, { exact: true }),
            `${view.navId}: Topbar label "${view.label}" should be visible`
          )
          .toBeVisible({ timeout: 15_000 });

        // Static body heading where the view has one.
        if (view.heading) {
          await expect
            .soft(
              page.getByRole("heading", {
                name: view.heading.name,
                level: view.heading.level,
                exact: true,
              }),
              `${view.navId}: heading "${view.heading.name}" should be visible`
            )
            .toBeVisible({ timeout: 15_000 });
        }

        // No uncaught renderer error fired while this view's chunk evaluated.
        const newErrors = pageErrors.slice(errorsBefore);
        expect
          .soft(
            newErrors,
            `${view.navId}: navigation should not throw renderer errors`
          )
          .toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });
});
