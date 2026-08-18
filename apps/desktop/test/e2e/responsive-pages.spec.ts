/**
 * E2E responsive smoke: dashboard, sessions, and branches — both the LIST and
 * the DETAIL pages — stay inside the narrow desktop viewport.
 *
 * Unit tests pin the class contracts, but FEA-2511 is a rendered layout issue.
 * This launches the built Electron app with a disposable profile, seeds the
 * local SQLite store, resizes to a small viewport, and asserts the real pages do
 * not create document-level horizontal overflow.
 *
 * FEA-2511 specifically fixed the shared session/branch DETAIL properties and
 * comments rails at narrow widths, but the original spec only drove the
 * dashboard and the sessions/branches LIST pages — so a regression of the
 * `.sd3` narrow-stacking or a fixed-width element in the properties rail would
 * go uncaught on desktop. This also navigates into a seeded session detail and
 * branch detail at 390px and asserts no horizontal overflow there.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
// Explicit `.ts`: `@repo/app` publishes no `exports` map, so this Electron
// runner resolves the subpath straight through the node_modules symlink and
// needs the extension (as the sibling `@repo/api/src/types/*.ts` imports do).
import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels.ts";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag.ts";
import {
  ActivityBreakdownSlot,
  SHARE_COLUMN_LABEL,
} from "@repo/app/agents/lib/session-activity-phases.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
  openDetailFromList,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  type SessionListSeed,
  seedMergedUnenrichedSinglePrBranch,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const NARROW_VIEWPORT = { height: 760, width: 390 };
// ISS-4674 — the Activity breakdown panel, the columns its phone set drops, and
// the width below which a phase name is no longer a name, just the crushed
// column the ticket reported.
const ACTIVITY_BREAKDOWN_PANEL_LABEL = "Activity breakdown";
const ACTIVITY_BREAKDOWN_SECONDARY_LABELS = ["Source", "Conf.", "Tokens"];
// The seeded session has no tiling at all, so the breakdown renders its single
// client-synthesized residual row — the `unattributed` bucket (spend the
// classifier never saw), NOT `other` (spend it tiled but could not classify).
// Read the word from the canonical map rather than a copied literal: ISS-4790
// renamed these buckets, and the stale "Other / unclassified" literal this
// replaces matched NOTHING — which silently took the whole
// `expectActivityBreakdownReadable` helper (phase-track floor, column-set, and
// share-column assertions alike) out of service. The alias is named for the
// bucket it now resolves to, so a failure here points at the right row.
const UNATTRIBUTED_PHASE_LABEL = ACTIVITY_PHASE_LABEL.unattributed;
const PHASE_LABEL_MIN_WIDTH_PX = 40;
// Fractional layout widths land a hair either side of an integer boundary.
const SUB_PIXEL_TOLERANCE_PX = 1;
const RESPONSIVE_BRANCH_SEED = {
  repoFullName: "closedloop-ai/responsive-desktop-check",
  branchName: "feature/fea-2511-small-resolution-responsive-branch",
  sessionId: "fea-2511-dashboard-branch-session",
  prNumber: 2511,
  mergedAt: "2026-07-14T12:00:00.000Z",
} as const;
const RESPONSIVE_SESSIONS: SessionListSeed[] = Array.from(
  { length: 30 },
  (_value, index) => ({
    sessionId: `fea-2511-session-${String(index + 1).padStart(2, "0")}`,
    name: `FEA-2511 narrow sessions ${String(index + 1).padStart(2, "0")}`,
  })
);

test.describe("Responsive desktop pages", () => {
  test("dashboard, sessions, and branches list + detail do not overflow at 390px", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-responsive-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      RESPONSIVE_BRANCH_SEED.repoFullName,
    ]);

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

      await seedMergedUnenrichedSinglePrBranch(
        userDataDir,
        RESPONSIVE_BRANCH_SEED
      );
      await seedSessionsList(userDataDir, RESPONSIVE_SESSIONS);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        // ISS-5841: the phases strip and Activity breakdown are a Labs toggle,
        // default OFF. This spec measures whether those regions OVERFLOW at
        // 390px, which is only answerable while they render, so it opts the gate
        // ON. Leaving it shut would turn a layout assertion into a vacuous pass.
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [SESSION_ACTIVITY_PHASES_FLAG_KEY]: true,
          });
        },
        // ISS-5828 (from main): the branch detail this spec opens resolves its
        // repository defaults through the GitHub authority, so the launch points
        // at a fake local authority server rather than the network.
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
          ...authorityServer.env,
        },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await page.setViewportSize(NARROW_VIEWPORT);

        await gotoNav(page, "dashboard");
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Welcome to Closedloop",
          })
        ).toBeVisible({ timeout: 30_000 });
        // The unified GitHub-first account graduated to always-on (FEA-3999), so
        // a signed-out device (every E2E profile) layers the first-launch
        // onboarding overlay over the mounted Dashboard — it mounts async on the
        // signed-out auth pull, independent of the onboarded/tour-seen storage
        // keys seeded above, and its `role="dialog"` intercepts the "All time"
        // click. Neutralize it before driving the Dashboard control (a persistent
        // style rule, so a later mount cannot re-intercept). Mirrors
        // dashboard-kpi-values.spec.ts.
        await dismissDesktopOnboardingOverlay(page);
        await clickAllTimeIfPresent(page);
        await expectNoHorizontalOverflow(page, "dashboard");

        await gotoNav(page, "sessions");
        await expectNavViewMounted(page, "Sessions");
        await clickAllTimeIfPresent(page);
        await expect(
          page.getByText("FEA-2511 narrow sessions 30").first()
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole("navigation", { name: "pagination" })
        ).toBeVisible();
        await expectNoHorizontalOverflow(page, "sessions");

        // Session DETAIL — FEA-2511 fixed the shared detail properties/comments
        // rails at narrow widths, verified only in Storybook. Drive the real
        // detail page on desktop so a regression is caught here.
        await openDetailFromList(
          page,
          page.getByRole("link", {
            exact: true,
            name: "FEA-2511 narrow sessions 30",
          }),
          "Sessions"
        );
        await expectNoHorizontalOverflow(page, "session detail");
        await expectActivityBreakdownReadable(page);

        await gotoNav(page, "branches");
        await expectNavViewMounted(page, "Branches");
        await clickAllTimeIfPresent(page);
        await expect(
          page.getByText(RESPONSIVE_BRANCH_SEED.branchName).first()
        ).toBeVisible({ timeout: 30_000 });
        await expectNoHorizontalOverflow(page, "branches");
        await expectBranchesTableKeyboardScrollable(page);

        // Branch DETAIL — the other half of the FEA-2511 shared-detail fix.
        await openDetailFromList(
          page,
          page
            .locator('a[href^="#/branches/"]')
            .filter({ hasText: RESPONSIVE_BRANCH_SEED.branchName }),
          "Branches"
        );
        await expectNoHorizontalOverflow(page, "branch detail");

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

/**
 * `gotoNav` only assigns `window.location.hash` and returns -- it does NOT wait,
 * so the OUTGOING view is still mounted when it resolves. Synchronize on the
 * INCOMING route before driving any of its controls, otherwise a page-wide
 * locator can match (and click) the outgoing view's control, leaving the
 * incoming list unfiltered. The route title lives only in the Topbar
 * breadcrumb, so scope to <header> to avoid matching the sidebar nav button.
 * Mirrors branches-median-pr-size.spec.ts and branch-updatedat.spec.ts.
 */
async function expectNavViewMounted(page: Page, title: string): Promise<void> {
  await expect(
    page.locator("header").getByText(title, { exact: true })
  ).toBeVisible({ timeout: 30_000 });
}

const ALL_TIME_SETTLE_MS = 5000;

async function clickAllTimeIfPresent(page: Page): Promise<void> {
  // Locator resolution and actionability are separate steps. During a route
  // transition, the outgoing toggle can match `:visible` and disappear before
  // Playwright clicks it. Find and click the currently rendered toggle in one
  // browser task so the transition cannot invalidate the chosen element.
  try {
    await expect
      .poll(
        () =>
          page.locator('[aria-label="All time"]').evaluateAll((elements) => {
            const visibleElement = elements.find(
              (element) => element.getClientRects().length > 0
            );
            if (!(visibleElement instanceof HTMLElement)) {
              return false;
            }
            visibleElement.click();
            return true;
          }),
        { timeout: ALL_TIME_SETTLE_MS }
      )
      .toBe(true);
  } catch {
    return;
  }
}

async function expectNoHorizontalOverflow(
  page: Page,
  pageName: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          return maxScrollWidth - document.documentElement.clientWidth;
        }),
      { message: `${pageName} should not overflow horizontally` }
    )
    .toBeLessThanOrEqual(1);
}

/**
 * PRD-600 COMMON-018: the populated Branches table's real two-axis scroll
 * owner is keyboard reachable and responds to horizontal arrow input. The
 * narrow viewport plus seeded row guarantees the table is wider than its
 * scrollport, so this fails if the owner loses either its tab stop or native
 * overflow behavior.
 */
async function expectBranchesTableKeyboardScrollable(
  page: Page
): Promise<void> {
  const scrollOwner = page.getByRole("region", { name: "Branches" });
  await expect(scrollOwner).toHaveAttribute("tabindex", "0");
  await expect
    .poll(() =>
      scrollOwner.evaluate(
        (element) => element.scrollWidth - element.clientWidth
      )
    )
    .toBeGreaterThan(0);

  // Enter through the document's real tab order rather than treating
  // programmatic focus as accessibility proof.
  await scrollOwner.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(scrollOwner).toBeFocused();

  await scrollOwner.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await scrollOwner.press("ArrowRight");
  await expect
    .poll(() => scrollOwner.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
}

/**
 * ISS-4674 — the session-detail Activity breakdown at 390px. Its eight columns'
 * fixed tracks alone exceed a narrow viewport, so before the fix the flexible
 * phase-name column collapsed to a bare colored swatch. The panel is shared code
 * (`@repo/app` `SessionActivityBreakdown`, mounted here through
 * `SessionDetailView`), so the renderer gets the same responsive column set as
 * the web shell — asserted on this surface rather than assumed from the web
 * spec, because the Electron window can be dragged to widths the browser suite
 * never exercises.
 *
 * The seeded session carries no per-phase attribution, so the breakdown renders
 * its honest single "Unattributed" remainder (ISS-4790 — spend the classifier
 * never saw), which is the panel's longest single-token phase label and
 * therefore its strictest case for the phase-track floor.
 */
async function expectActivityBreakdownReadable(page: Page): Promise<void> {
  const panel = page.getByRole("region", {
    name: ACTIVITY_BREAKDOWN_PANEL_LABEL,
  });
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Anchored on `data-slot`, not on text. The phase name shares its cell with
  // the narrow set's provenance suffix, so at this width the cell's text can
  // read "Unattributedinferred" and a text locator would match nothing
  // — and even for the seeded no-provenance session a text locator resolves to
  // the inner name element, whose box is its glyphs rather than the phase TRACK
  // this assertion is about. The cell is the grid item that owns that track.
  const phaseCell = panel.locator(
    `[data-slot="${ActivityBreakdownSlot.PhaseCell}"]:has([data-slot="${ActivityBreakdownSlot.PhaseName}"]:text-is("${UNATTRIBUTED_PHASE_LABEL}"))`
  );
  await expect(phaseCell).toBeVisible();
  const phaseBox = await phaseCell.boundingBox();
  expect(phaseBox?.width ?? 0).toBeGreaterThan(PHASE_LABEL_MIN_WIDTH_PX);

  // The scrolling track the columns live in. Its own box — not the viewport —
  // is what a column must sit inside, and it is the element whose internal
  // overflow the page-level `expectNoHorizontalOverflow` helper cannot see.
  const track = panel.locator(".overflow-x-auto");
  await expect(track).toBeVisible();

  // Cost and the share column stay on screen at this width; the muted three give
  // way. `toBeVisible()` alone does NOT prove they are inside the nested
  // horizontal scrollport at rest (shafty023) — a value pushed off the right edge
  // is still "visible" to Playwright. Assert each sits fully inside the TRACK box
  // while it is unscrolled, and that the five-column phone set has no internal
  // overflow to scroll in the first place, so a Desktop regression that pushed
  // the share column off the edge would fail here instead of passing on a bare
  // visibility check.
  await expectPhoneTrackHasNoInternalOverflow(track);
  // The share column names the basis it is showing (ISS-4685). This seeded
  // session has no tiling AND no `estimatedCost` — `SessionListSeed` leaves
  // `cost_usd_estimated` NULL by default — so it is unpriced work, and the
  // column is the TIME variant. It is pinned rather than sniffed, so a seed that
  // gained a price fails here instead of quietly asserting the other mode; that
  // pinning is what caught this seed being the exact unpriced-Empty session
  // wongk flagged, back when the basis was keyed off the breakdown MODE and this
  // column claimed a cost share of a session with no cost. Read from the shared
  // constant: this spec measures the column's GEOMETRY and must not be where a
  // copy change is discovered.
  for (const label of ["Cost", SHARE_COLUMN_LABEL.time]) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
    await expectColumnInsideTrackAtRest(track, label);
  }
  for (const label of ACTIVITY_BREAKDOWN_SECONDARY_LABELS) {
    await expect(panel.getByText(label, { exact: true })).toBeHidden();
  }
}

// The phone (five-column) set fits, so its track has nothing to scroll — the
// whole reason it is the primary fix over scrolling all eight. Confirms `Cost`
// and the share column are on screen at rest, not merely a swipe away. Polled
// because the renderer reflows asynchronously after navigation.
async function expectPhoneTrackHasNoInternalOverflow(track: Locator) {
  await expect
    .poll(async () =>
      track.evaluate((element) => element.scrollWidth - element.clientWidth)
    )
    .toBeLessThanOrEqual(SUB_PIXEL_TOLERANCE_PX);
}

// A column label sits fully inside the track's visible box while the track is
// unscrolled (`scrollLeft === 0`) — the "no column silently clips off the right
// edge" half of ISS-4674, measured against the track, not the viewport.
async function expectColumnInsideTrackAtRest(track: Locator, label: string) {
  await track.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const trackBox = await track.boundingBox();
  const labelBox = await track.getByText(label, { exact: true }).boundingBox();
  if (!(trackBox && labelBox)) {
    throw new Error(`Expected geometry for the ${label} column`);
  }
  expect(labelBox.x).toBeGreaterThanOrEqual(
    trackBox.x - SUB_PIXEL_TOLERANCE_PX
  );
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
    trackBox.x + trackBox.width + SUB_PIXEL_TOLERANCE_PX
  );
}
