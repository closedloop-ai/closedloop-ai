/**
 * Desktop-owned proof for the shared Branches responsive narrow list.
 *
 * The projection semantics stay covered in shared and web lanes. This spec owns
 * the Electron boundaries: the shell's measured list band, signed-out launch,
 * SQLite pagination, hash routing, and document-level overflow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { encodeBranchId } from "@repo/api/src/types/branch.ts";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import { PRODUCT_GRID_FAVORITE_COLUMN_LABEL } from "@repo/app/shared/lib/product-grid-favorites.ts";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
} from "../../src/shared/window-defaults.js";
import {
  browserViewportWidth,
  setBrowserWindowContentSize,
} from "./helpers/browser-window-size";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import { expectDesktopRowPointerRefusal } from "./helpers/grid-pointer-contract";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import { expectFreshWindowBounds } from "./helpers/summary-strip";

const REPOSITORY = "closedloop-e2e/responsive-grid-v2";
const SELECTED_BRANCH_NAME = "iss-9451-responsive-00";
const SELECTED_BRANCH_ID = encodeBranchId({
  branchName: SELECTED_BRANCH_NAME,
  repoFullName: REPOSITORY,
});
const SELECTED_BRANCH_HASH = `#/branches/${encodeURIComponent(SELECTED_BRANCH_ID)}`;
const NARROW_WINDOW_SIZE = { height: 844, width: 390 };
const DEFAULT_WINDOW_BOUNDS = {
  height: DEFAULT_WINDOW_HEIGHT,
  width: DEFAULT_WINDOW_WIDTH,
};
const HISTORY_LIST_TEST_ID = "branches-history-list";
const BRANCHES_SCROLL_CONTAINER_TEST_ID = "branches-scroll-container";
const METRIC_ROW_OWNS_HORIZONTAL_SCROLL_PATTERN = /overflow-x-auto/;
const EDGE_FLUSH_TOLERANCE_PX = 1;
const GRID_CONTENT_WIDTH_PX = 768;
const SORT_TOOLBAR_TRIGGER = /^Sorted by/;
const RESIZE_REPOSITORY_COLUMN = /^Resize Repository column/;
const ROW_COUNT = 26;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRID_DATA_ROW_SELECTOR =
  '[data-grid-row-id]:not([data-grid-row-id^="__grid-chrome__"])';

test("signed-out Desktop switches between narrow and wide grids without losing routing or local pagination", async () => {
  test.setTimeout(240_000);
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-responsive-v2-udd-")
  );
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-responsive-v2-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-responsive-v2-codex-")
  );
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
  };

  try {
    const bootstrap = await launchDesktopApp({
      beforeLaunch: seedResponsiveNarrowGridview,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    seedDesktopFeatureFlags(userDataDir, {
      [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
    });

    const activityAt = new Date(Date.now() - DAY_MS).toISOString();
    expectFixtureInsideDefaultDateWindow(
      activityAt,
      "Responsive Branches activityAt"
    );
    for (let index = 0; index < ROW_COUNT; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await seedNoPullRequestBranch(userDataDir, {
        activityAt,
        branchName: `iss-9451-responsive-${suffix}`,
        repoFullName: REPOSITORY,
        sessionId: `iss-9451-responsive-session-${suffix}`,
      });
    }

    const app = await launchDesktopApp({
      beforeLaunch: seedResponsiveNarrowGridview,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await expectFreshWindowBounds(app.app, DEFAULT_WINDOW_BOUNDS);
      await gotoNav(app.page, "branches");
      await expect(app.page.getByText("1–25 of 26")).toBeVisible({
        timeout: 30_000,
      });

      const history = app.page.getByTestId(HISTORY_LIST_TEST_ID);
      await expect(
        history.locator('[data-grid-interaction-contract="pointer-hover"]')
      ).toHaveCount(1);
      expect(await measuredWidth(history)).toBeGreaterThanOrEqual(
        GRID_CONTENT_WIDTH_PX
      );
      await expect(history.getByRole("grid")).toBeVisible();
      await expect(history.locator("dl")).toHaveCount(0);
      const pointerRow = history
        .locator("[data-grid-row-id][draggable]")
        .first();
      // ISS-12918 (#9116) put the favorite star cell first in each row, so
      // the identity cell is located by its own marker, not by position.
      const rowLink = pointerRow
        .locator("[data-grid-lead-cell]")
        .getByRole("link")
        .first();
      // ISS-12901: the native link drags below need rendered frames between
      // pointer moves, which the unmapped Linux CI Xvfb window throttles.
      await mapInactiveLinuxCiWindow(
        app.app,
        app.page,
        selectInactiveLinuxCiMapping(
          { platform: process.platform, env: process.env },
          true
        )
      );
      await expectDesktopRowPointerRefusal({
        destination: history
          .locator("[data-grid-row-id][draggable]")
          .nth(1)
          .locator("[data-grid-lead-cell]"),
        link: rowLink,
        page: app.page,
        row: pointerRow,
        surface: history,
      });
      await expectMetricsCardsToSpanBandAtDesktopWidth(app.page);
      await expectDocumentToFitViewport(app.page);

      await setBrowserWindowContentSize(app.app, { height: 844, width: 960 });
      expect(await browserViewportWidth(app.page)).toBe(960);
      expect(await measuredWidth(history)).toBeLessThan(GRID_CONTENT_WIDTH_PX);
      await expect(history.getByRole("grid")).toBeVisible();
      await expect(history.getByRole("columnheader").nth(0)).toHaveText(
        PRODUCT_GRID_FAVORITE_COLUMN_LABEL
      );
      await expect(history.getByRole("columnheader").nth(1)).toHaveText("Name");
      expect(await history.getByRole("columnheader").count()).toBeGreaterThan(
        1
      );
      await expect(history.locator("dl")).toHaveCount(0);
      const repositoryHeader = history.getByRole("columnheader", {
        name: "Repository",
      });
      await expect(repositoryHeader).toBeVisible();
      const resizeHandle = repositoryHeader.getByRole("button", {
        name: RESIZE_REPOSITORY_COLUMN,
      });
      await expect(resizeHandle).toBeVisible();
      const startingWidth = await repositoryHeader.evaluate(
        (element) => element.getBoundingClientRect().width
      );
      const startingName = await resizeHandle.getAttribute("aria-label");
      if (!startingName) {
        throw new Error("Repository resize handle has no accessible name");
      }
      await resizeHandle.focus();
      await resizeHandle.press("ArrowRight");
      await expect
        .poll(() =>
          repositoryHeader.evaluate(
            (element) => element.getBoundingClientRect().width
          )
        )
        .toBeGreaterThan(startingWidth);
      await expect(resizeHandle).toBeFocused();
      await expect(resizeHandle).not.toHaveAttribute(
        "aria-label",
        startingName
      );
      await expect(app.page.getByRole("button", { name: "View" })).toHaveCount(
        0
      );
      // ISS-13007 R-IDENTICAL-LISTS: Branches offers Sort in the toolbar.
      await expect(
        app.page.getByRole("button", { name: SORT_TOOLBAR_TRIGGER }).first()
      ).toBeVisible();

      await setBrowserWindowContentSize(app.app, {
        height: 844,
        width: GRID_CONTENT_WIDTH_PX,
      });
      expect(await browserViewportWidth(app.page)).toBe(GRID_CONTENT_WIDTH_PX);
      await expect(history.getByRole("grid")).toBeVisible();
      expect(await history.getByRole("columnheader").count()).toBeGreaterThan(
        1
      );
      await expect(app.page.getByRole("button", { name: "View" })).toHaveCount(
        0
      );

      await setBrowserWindowContentSize(app.app, NARROW_WINDOW_SIZE);
      expect(await browserViewportWidth(app.page)).toBe(
        NARROW_WINDOW_SIZE.width
      );
      await expect
        .poll(() => measuredWidth(history), { timeout: 30_000 })
        .toBeLessThan(GRID_CONTENT_WIDTH_PX);
      await expect(history.getByRole("grid")).toBeVisible();
      await expect(history.getByRole("columnheader")).toHaveCount(1);
      await expect(history.getByRole("columnheader")).toHaveText("Name");
      await expect(history.locator(GRID_DATA_ROW_SELECTOR)).toHaveCount(25);
      await expect(history.locator("dl")).toHaveCount(0);
      await expect(
        app.page.getByRole("button", { name: "View" })
      ).toBeVisible();
      await expect(
        app.page.getByRole("region", { name: "Branches" })
      ).toHaveAttribute("tabindex", "0");
      await expect(app.page.getByRole("searchbox")).toHaveCount(0);
      await expectMetricsRowToOwnHorizontalOverflow(app.page);
      await expectDocumentToFitViewport(app.page);

      await app.page.getByLabel("Go to next page").click();
      await expect(app.page.getByText("26–26 of 26")).toBeVisible({
        timeout: 30_000,
      });
      await expect(history.locator(GRID_DATA_ROW_SELECTOR)).toHaveCount(1);

      await app.page.getByLabel("Go to previous page").click();
      await expect(app.page.getByText("1–25 of 26")).toBeVisible({
        timeout: 30_000,
      });

      const pageSize = app.page.getByRole("combobox", {
        name: "Rows per page",
      });
      await expect(pageSize).toContainText("25 / page");
      await pageSize.click();
      await app.page.getByRole("option", { name: "50 / page" }).click();
      await expect(app.page.getByText("1–26 of 26")).toBeVisible({
        timeout: 30_000,
      });
      await expect(history.locator(GRID_DATA_ROW_SELECTOR)).toHaveCount(26);
      await pageSize.click();
      await app.page.getByRole("option", { name: "100 / page" }).click();
      await expect(pageSize).toContainText("100 / page");
      await expect(app.page.getByText("1–26 of 26")).toBeVisible({
        timeout: 30_000,
      });

      const branchLink = history.getByRole("link", {
        name: SELECTED_BRANCH_NAME,
      });
      await expect(branchLink).toHaveAttribute("href", SELECTED_BRANCH_HASH);
      await branchLink.click();
      await expect
        .poll(() => app.page.evaluate(() => globalThis.location.hash))
        .toBe(SELECTED_BRANCH_HASH);
      await expect(
        app.page.getByRole("heading", {
          exact: true,
          level: 1,
          name: SELECTED_BRANCH_NAME,
        })
      ).toBeVisible({ timeout: 30_000 });
      await expect(app.page.getByText("Branch not found")).toHaveCount(0);
      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

function measuredWidth(locator: ReturnType<Page["getByTestId"]>) {
  return locator.evaluate((element) => {
    const surface = element.parentElement?.parentElement;
    if (!surface) {
      throw new Error("The Branches list-surface root is missing");
    }
    return surface.getBoundingClientRect().width;
  });
}

function seedResponsiveNarrowGridview(userDataDir: string): void {
  mergeE2eFeatureFlagAssignment(userDataDir, {
    [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
  });
}

function branchesMetricsRow(page: Page) {
  const branchesSurface = page
    .locator("div")
    .filter({
      has: page.getByTestId(BRANCHES_SCROLL_CONTAINER_TEST_ID),
    })
    .last();
  return branchesSurface
    .getByTestId("grid-table-metric-band")
    .locator("[data-density]")
    .first();
}

async function expectMetricsRowToOwnHorizontalOverflow(
  page: Page
): Promise<void> {
  const metricsRow = branchesMetricsRow(page);
  await expect(metricsRow).toBeVisible();
  await expect(metricsRow).toHaveClass(
    METRIC_ROW_OWNS_HORIZONTAL_SCROLL_PATTERN
  );
  const dimensions = await metricsRow.evaluate((row) => ({
    clientWidth: row.clientWidth,
    rankCount: new Set(
      Array.from(row.querySelectorAll('[data-slot="card"]')).map((card) =>
        Math.round(card.getBoundingClientRect().top)
      )
    ).size,
    scrollWidth: row.scrollWidth,
  }));
  expect(dimensions.clientWidth).toBeGreaterThan(0);
  expect(dimensions.clientWidth).toBeLessThanOrEqual(NARROW_WINDOW_SIZE.width);
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(dimensions.rankCount).toBe(1);
}

async function expectMetricsCardsToSpanBandAtDesktopWidth(
  page: Page
): Promise<void> {
  const metricsRow = branchesMetricsRow(page);
  await expect(metricsRow).toBeVisible();
  // ISS-10636: the caller resizes the window immediately above, and the
  // five-card row has to cross a density tier on that resize before it can close
  // the band. That tier is measured by a ResizeObserver and published through
  // React, so poll the rendered geometry instead of reading the pre-resize floor.
  await expect
    .poll(() => metricsRow.evaluate((row) => row.scrollWidth - row.clientWidth))
    .toBe(0);
  const geometry = await metricsRow.evaluate((row) => {
    const cards = Array.from(row.querySelectorAll('[data-slot="card"]'));
    const rowBox = row.getBoundingClientRect();
    return {
      cardCount: cards.length,
      clientWidth: row.clientWidth,
      contentRight: rowBox.left + row.clientLeft + row.clientWidth,
      rightmostCardRight: cards.reduce(
        (right, card) => Math.max(right, card.getBoundingClientRect().right),
        Number.NEGATIVE_INFINITY
      ),
      scrollWidth: row.scrollWidth,
    };
  });
  expect(geometry.cardCount).toBeGreaterThan(1);
  expect(geometry.clientWidth).toBeGreaterThan(DEFAULT_WINDOW_BOUNDS.width / 2);
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  expect(
    Math.abs(geometry.rightmostCardRight - geometry.contentRight)
  ).toBeLessThanOrEqual(EDGE_FLUSH_TOLERANCE_PX);
}

async function expectDocumentToFitViewport(page: Page): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    globalThis.scrollTo(400, globalThis.scrollY);
    const scrollXAfterProbe = globalThis.scrollX;
    globalThis.scrollTo(0, globalThis.scrollY);
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      scrollXAfterProbe,
    };
  });
  expect(
    diagnostics.scrollXAfterProbe,
    JSON.stringify(diagnostics, null, 2)
  ).toBeLessThanOrEqual(1);
}
