/**
 * E2E smoke test: every top-level nav view mounts and renders without errors.
 *
 * Drives the renderer through all nav ids via hash routing (the sidebar is
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

import { expect, type Page, test } from "@playwright/test";
import { gotoHash, gotoNav, launchDesktopApp } from "./helpers/desktop-app";

type ViewCase = {
  navId: string;
  /** Topbar breadcrumb label (from nav-config NAV_ENTRIES). */
  label: string;
  /** Static heading rendered in the view body, if any. */
  heading?: { name: string; level: 1 | 2 };
  /**
   * A stable labelled region (`role="region"`) the view body renders in every
   * data state, if any. Asserting it pins a structural boundary the page
   * heading alone can't — e.g. the Packs "Your packs" region only exists when
   * the shared by-source `MemberView` mounted, so it fails if the route falls
   * back to the old flat slot or the required provider stack is missing.
   */
  region?: { name: string };
};

// A detail surface reached by hash route. Each mounts its OWN lazy chunk
// (SessionDetailView / BranchDetailView / AgentDetailView), distinct from the
// list view's — the surface where the reported "Failed to fetch dynamically
// imported module" crash occurred — so the smoke must drive them directly. A
// synthetic (non-existent) id is intentional: the chunk still loads and mounts
// regardless of data, and the view must render a graceful empty/not-found state
// rather than crash.
type DetailCase = {
  name: string;
  hash: string;
  /** Topbar breadcrumb parent label the detail renders under. */
  parentLabel: string;
};

// The RootErrorBoundary's crash fallback heading. Its presence means a render
// threw and the boundary swapped the whole app for the error screen — the exact
// symptom of an unrecovered chunk-load failure.
const CRASH_FALLBACK_TEXT = "Something went wrong";

// Substrings (lowercased) of the messages a failed dynamic import surfaces,
// plus the RootErrorBoundary's own log line. A chunk-load failure CAUGHT by the
// boundary shows the crash fallback and logs one of these via console.error
// WITHOUT firing pageerror, so scanning console output catches the
// boundary-swallowed crash the pageerror collector alone would miss.
const FATAL_CONSOLE_PATTERNS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "loading chunk",
  "error boundary caught",
];

function fatalConsoleErrors(consoleErrors: string[]): string[] {
  return consoleErrors.filter((text) => {
    const lowered = text.toLowerCase();
    return FATAL_CONSOLE_PATTERNS.some((pattern) => lowered.includes(pattern));
  });
}

/**
 * Assert a just-navigated surface is healthy: the boundary crash fallback is NOT
 * shown, no uncaught renderer error fired, and no chunk-load / error-boundary
 * console error was logged since `errorsBefore`/`consoleBefore`. Soft so one
 * broken surface is reported without masking the rest.
 */
async function expectSurfaceHealthy(
  page: Page,
  label: string,
  captured: {
    pageErrors: Error[];
    errorsBefore: number;
    consoleErrors: string[];
    consoleBefore: number;
  }
): Promise<void> {
  await expect
    .soft(
      page.getByText(CRASH_FALLBACK_TEXT, { exact: true }),
      `${label}: RootErrorBoundary crash fallback must not be shown`
    )
    .toHaveCount(0);

  expect
    .soft(
      captured.pageErrors.slice(captured.errorsBefore),
      `${label}: navigation should not throw uncaught renderer errors`
    )
    .toEqual([]);

  expect
    .soft(
      fatalConsoleErrors(captured.consoleErrors.slice(captured.consoleBefore)),
      `${label}: no chunk-load / error-boundary console errors`
    )
    .toEqual([]);
}

// Order mirrors NAV_ENTRIES. Labels come from nav-config; headings from each
// view's PageShell `title`. FEA-3990: every top-level view title now routes
// through the shared PageShell as a single <h1>, so every heading below is
// level 1 (the outline is uniform across peer views). FEA-3989: a view's nav
// label and its page heading name the same destination — note "requests" now
// asserts a "Requests" <h1> that matches its nav label (previously the body
// read "Activity"), and "insights" asserts an "Insights" <h1> aligned to its
// nav label (previously "Agent Monitoring"; final vocab pending FEA-3970).
const VIEWS: ViewCase[] = [
  {
    navId: "dashboard",
    label: "Dashboard",
    // The first-launch dashboard renders its PageShell title as an <h1>.
    heading: { name: "Welcome to Closedloop", level: 1 },
  },
  // Sessions and Branches are full-width, table-led views whose title shows
  // only in the Topbar breadcrumb (no in-body <h1>) — the label assertion
  // covers them, and the page-error guard covers their lazy @repo/app chunks.
  { navId: "sessions", label: "Sessions" },
  { navId: "branches", label: "Branches" },
  {
    navId: "insights",
    label: "Insights",
    heading: { name: "Insights", level: 1 },
  },
  // FEA-4087: the top-level Packs view mounts its own lazy chunk (PacksView →
  // the shared @repo/app PacksPage spine) and renders its PageShell title as an
  // <h1>, so the packaged-Electron smoke must drive it directly to catch a
  // missing or broken production chunk.
  // FEA-4166: also assert the "Your packs" region — the shared by-source
  // `MemberView`'s primary `PageSection` (`<section aria-label="Your packs">`,
  // present in every data state). The "Packs" <h1> comes from the PageShell and
  // survives even the old flat member slot, so it can't pin this change; the
  // "Your packs" region only exists once the member `MemberView` mounted behind
  // its full provider stack, so it fails if the route regresses to the flat
  // `PluginsPanel` slot or the Auth/Api/QueryClient providers are missing.
  {
    navId: "packs",
    label: "Packs",
    heading: { name: "Packs", level: 1 },
    region: { name: "Your packs" },
  },
  // FEA-2923 / T-16.4: the standalone Packs, Skills, Tools, and SubAgents Lab
  // views were deprecated and fold into the unified Agents workspace (their nav
  // ids now redirect to /agents via normalizeNavId). The workspace hosts its
  // inventory in a tabbed surface with no standalone <h1>, so we assert the
  // Topbar label only (the page-error guard still covers the mount).
  { navId: "agents", label: "Agents" },
  { navId: "plans", label: "Plans", heading: { name: "Plans", level: 1 } },
  {
    navId: "approvals",
    label: "Approvals",
    heading: { name: "Approvals", level: 1 },
  },
  {
    navId: "requests",
    label: "Requests",
    heading: { name: "Requests", level: 1 },
  },
  {
    navId: "diagnostics",
    label: "Diagnostics",
    heading: { name: "Diagnostics", level: 1 },
  },
  {
    navId: "settings",
    label: "Settings",
    heading: { name: "Settings", level: 1 },
  },
];

// Detail surfaces — the class of route where the reported chunk-load crash hit.
// Synthetic ids: the lazy chunk mounts regardless of data, and an empty local DB
// must yield a graceful empty/not-found state, not a crash. Agent detail is
// reachable by hash even with the Agents nav flag off (the route matches; only
// the sidebar entry + list are gated).
const DETAIL_SURFACES: DetailCase[] = [
  {
    name: "session-detail",
    hash: "/sessions/e2e-smoke-missing-id",
    parentLabel: "Sessions",
  },
  {
    name: "branch-detail",
    hash: "/branches/e2e-smoke-missing-id",
    parentLabel: "Branches",
  },
  {
    name: "agent-detail",
    hash: "/agents/e2e-smoke-missing-slug",
    parentLabel: "Agents",
  },
];

test.describe("All views smoke", () => {
  test("every nav + detail view mounts, renders its shell, and throws no JS errors", async () => {
    // One launch drives all views with up to two 15s-timeout assertions
    // each. The 60s per-test default would be exhausted by a handful of timed-
    // out assertions and Playwright would kill the test mid-loop — defeating
    // the soft-assertion design (one broken view shouldn't mask the rest).
    // Give the loop enough runway to reach every view even in that worst case.
    test.setTimeout(240_000);

    const { page, pageErrors, consoleErrors, cleanup } = await launchDesktopApp(
      {
        userDataPrefix: "desktop-smoke-e2e-",
      }
    );

    try {
      for (const view of VIEWS) {
        const errorsBefore = pageErrors.length;
        const consoleBefore = consoleErrors.length;

        await gotoNav(page, view.navId);

        // Topbar breadcrumb label — present on every view regardless of data.
        // Scoped to <header> so it can't match a sidebar nav button of the
        // same name. Also proves the shell survived (a root-boundary crash
        // replaces the whole app, header included).
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

        // Stable labelled region where the view has one — a structural boundary
        // the page heading alone can't pin.
        if (view.region) {
          await expect
            .soft(
              page.getByRole("region", {
                name: view.region.name,
                exact: true,
              }),
              `${view.navId}: region "${view.region.name}" should be visible`
            )
            .toBeVisible({ timeout: 15_000 });
        }

        // No crash fallback, no uncaught error, no chunk-load/boundary console
        // error while this view's chunk evaluated.
        await expectSurfaceHealthy(page, view.navId, {
          pageErrors,
          errorsBefore,
          consoleErrors,
          consoleBefore,
        });
      }

      // Detail surfaces mount their own lazy chunks — drive each directly.
      for (const detail of DETAIL_SURFACES) {
        const errorsBefore = pageErrors.length;
        const consoleBefore = consoleErrors.length;

        await gotoHash(page, detail.hash);

        // The detail breadcrumb renders its parent list label; its visibility
        // proves the shell resolved the detail route and did not crash.
        await expect
          .soft(
            page
              .locator("header")
              .getByText(detail.parentLabel, { exact: true }),
            `${detail.name}: breadcrumb "${detail.parentLabel}" should be visible`
          )
          .toBeVisible({ timeout: 15_000 });

        await expectSurfaceHealthy(page, detail.name, {
          pageErrors,
          errorsBefore,
          consoleErrors,
          consoleBefore,
        });
      }
    } finally {
      await cleanup();
    }
  });
});
