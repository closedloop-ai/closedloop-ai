import { expect, test } from "@playwright/test";
import {
  LIST_TOOLBAR_FILTER_LABEL,
  LIST_TOOLBAR_SEARCH_LABEL,
} from "@repo/app/shared/components/list-toolbar-copy.ts";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import {
  browserViewportWidth,
  setBrowserWindowContentSize,
  setBrowserWindowZoomFactor,
} from "./helpers/browser-window-size";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";

const FIRST_SEEDED_SESSION_NAME = "ISS-9107 desktop v2 mount";
const SEEDED_SESSION_COUNT = 30;
const PAGE_SIZE_50_URL_PATTERN = /pageSize=50/;

const SEEDED_SESSIONS: SessionListSeed[] = Array.from(
  { length: SEEDED_SESSION_COUNT },
  (_value, index) => {
    const at = seededSessionAt(index);
    return {
      at,
      lastActivityAt: at,
      name:
        index === 0
          ? FIRST_SEEDED_SESSION_NAME
          : `ISS-8756 desktop page-size row ${index + 1}`,
      sessionId: `iss-8756-page-size-${index + 1}`,
    };
  }
);

/** The Desktop Sessions footer writes page size to hash-route state and expands the local result page. */
async function withSessionsAt(
  prefix: string,
  assertions: (
    page: Awaited<ReturnType<typeof launchDesktopApp>>["page"],
    app: Awaited<ReturnType<typeof launchDesktopApp>>["app"]
  ) => Promise<void>,
  beforeLaunch: (userDataDir: string) => void = seedResponsiveNarrowGridview
): Promise<void> {
  const dirs = makeSeededSessionsDirs(prefix);
  const env = seededSessionsEnv(dirs);
  try {
    // Launch 1 — create + migrate the SQLite schema, then close so the seed
    // writes without cross-process WAL contention.
    const first = await launchDesktopApp({
      beforeLaunch,
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(dirs.userDataDir, SEEDED_SESSIONS);
    // Launch 2 — the real Sessions IPC source reads the seeded corpus at boot.
    const { app, page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch,
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await gotoNav(page, "sessions");
      // Widen the window filter so the seeded row is in range independent of
      // the run clock.
      await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
      await expect(
        page.getByRole("link", { name: FIRST_SEEDED_SESSION_NAME })
      ).toBeVisible({ timeout: 30_000 });

      await assertions(page, app);
      // A branch that renders and throws is not a working mount.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
}

function seededSessionAt(index: number): string {
  return new Date(Date.now() - index * 60_000).toISOString();
}

test("the desktop Sessions v2 footer changes rows per page through URL-backed state", async () => {
  test.setTimeout(300_000);

  await withSessionsAt("iss-8756-page-size", async (page) => {
    const pageSize = page.getByRole("combobox", { name: "Rows per page" });
    await expect(pageSize).toContainText("25 / page");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Showing 1-25 of ${SEEDED_SESSION_COUNT} sessions` })
    ).toBeVisible();

    await pageSize.click();
    await page.getByRole("option", { name: "50 / page" }).click();

    await expect(page).toHaveURL(PAGE_SIZE_50_URL_PATTERN);
    await expect(pageSize).toContainText("50 / page");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Showing 1-30 of ${SEEDED_SESSION_COUNT} sessions` })
    ).toBeVisible({ timeout: 30_000 });
  });
});

test("[ISS-13035] with gridview-adoption off the Sessions toolbar keeps the Filter button and has no search box", async () => {
  test.setTimeout(300_000);

  await withSessionsAt(
    "iss-13035-sessions-toolbar-off",
    async (page) => {
      await expect(
        page.getByRole("button", { name: "Filter", exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: LIST_TOOLBAR_FILTER_LABEL,
          exact: true,
        })
      ).toHaveCount(0);
      await expect(
        page.getByRole("textbox", {
          name: LIST_TOOLBAR_SEARCH_LABEL,
          exact: true,
        })
      ).toHaveCount(0);
    },
    () => undefined
  );
});

test("[ISS-9523][ISS-9606] the adjacent Sessions toolbar stays wide at 960px, compacts below 768px, and responds to 400% zoom", async () => {
  test.setTimeout(300_000);

  await withSessionsAt("iss-10901-sessions-toolbar", async (page, app) => {
    await setBrowserWindowContentSize(app, { height: 900, width: 960 });
    await expect.poll(() => browserViewportWidth(page)).toBe(960);
    const list = page.getByTestId("sessions-history-list");
    expect(await list.getByRole("columnheader").count()).toBeGreaterThan(1);

    await expect(
      page.getByRole("button", { name: LIST_TOOLBAR_FILTER_LABEL, exact: true })
    ).toBeVisible();
    const sorts = page.getByRole("button", { name: sortedByPattern });
    const group = page.getByRole("button", { name: "Group", exact: true });
    const options = page.getByRole("button", { name: "Options", exact: true });
    await expect(sorts).toContainText("Sorts: 1");
    await expect(group).toBeVisible();
    await expect(options).toBeVisible();
    await expect(
      page.getByRole("button", { name: "View", exact: true })
    ).toHaveCount(0);

    await sorts.click();
    await page.keyboard.press("Escape");
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.keyboard.press("Tab");
      if (
        await group.evaluate((element) => element === document.activeElement)
      ) {
        break;
      }
    }
    await expect(group).toBeFocused();
    expect(
      await group.evaluate((element) => element.matches(":focus-visible"))
    ).toBe(true);
    await page.keyboard.press("Tab");
    await expect(options).toBeFocused();
    expect(
      await options.evaluate((element) => element.matches(":focus-visible"))
    ).toBe(true);

    await setBrowserWindowContentSize(app, { height: 844, width: 390 });
    await expect.poll(() => browserViewportWidth(page)).toBe(390);
    await expect(list.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
    await expect(list.getByRole("columnheader")).toHaveText("Name");
    await expect(
      page.getByRole("button", { name: "View", exact: true })
    ).toBeVisible();

    await setBrowserWindowContentSize(app, { height: 900, width: 1280 });
    await expect.poll(() => browserViewportWidth(page)).toBe(1280);
    await expect
      .poll(() => list.getByRole("columnheader").count())
      .toBeGreaterThan(1);

    await setBrowserWindowZoomFactor(app, 4);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          innerWidth: globalThis.innerWidth,
          visualViewportScale: globalThis.visualViewport?.scale,
          visualViewportWidth: globalThis.visualViewport?.width,
        }))
      )
      .toEqual({
        innerWidth: 320,
        visualViewportScale: 1,
        visualViewportWidth: 320,
      });
    await expect(list.getByRole("grid")).toHaveAttribute("aria-colcount", "1");
    await expect(list.getByRole("columnheader")).toHaveText("Name");
    await expect(list.locator('[data-slot="card"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "View", exact: true })
    ).toBeVisible();
    await expect(group).toHaveCount(0);
    await expect(options).toHaveCount(0);
    await expect(sorts).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.document.documentElement.clientWidth
      )
    ).toBe(true);
  });
});

const sortedByPattern = /^Sorted by /;

function seedResponsiveNarrowGridview(userDataDir: string): void {
  mergeE2eFeatureFlagAssignment(userDataDir, {
    [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
  });
}
