import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity.ts";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag.ts";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity.ts";
import {
  armBranchesPageDataGate,
  type HeldBranchesPageData,
  readBranchesPageDataGateStats,
  readHeldBranchesPageData,
  rejectHeldBranchesPageData,
  releaseHeldBranchesPageData,
} from "./helpers/branches-page-data-gate";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  recordDbChangedPushes,
  waitForLiveBridgeQuiescence,
} from "./helpers/live-bridge-quiescence";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

test("range transitions with held IPC never present previous Branches cohorts", async () => {
  test.setTimeout(240_000);
  const repository = "closedloop-e2e/placeholder-range";
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-placeholder-udd-")
  );
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-placeholder-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-placeholder-codex-")
  );
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
  };

  try {
    const bootstrap = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    await seedRangeRows(userDataDir, repository);

    const launched = await launchDesktopApp({
      branchesPageDataGate: true,
      env,
      keepUserDataDir: true,
      userDataDir,
      beforeLaunch: (profileDir) =>
        seedDesktopFeatureFlags(profileDir, {
          [BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY]: true,
        }),
    });
    try {
      await installControllablePageClock(launched.page);
      await recordDbChangedPushes(launched.page);
      await launched.page.evaluate(
        ({ key, value }) => {
          globalThis.localStorage.setItem(key, JSON.stringify(value));
        },
        { key: DESKTOP_DATE_RANGE_STORAGE_KEY, value: "90d" }
      );
      await gotoNav(launched.page, "branches");
      await expect(branchLink(launched.page, "iss-7197-old-90d")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        launched.page.getByText("1–4 of 4", { exact: true })
      ).toBeVisible();
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      await expect(
        launched.page.getByText("4 Branches in Last 90 days")
      ).toHaveCount(0);
      await expect(launched.page.getByText(NET_NEW_BANNER_COPY)).toHaveCount(0);

      // Every read counted below is compared against another read, so the
      // collector's startup invalidations have to be spent BEFORE the first of
      // them: a `desktop:db:changed` flush arriving mid-spec would invalidate
      // the very range cache the reuse assertion is pinning.
      await waitForLiveBridgeQuiescence(launched.page);

      await armBranchesPageDataGate(launched.app);
      await launched.page.locator('[aria-label="Last 7 days"]:visible').click();
      await waitForHeldRequests(launched.app, isSevenDayRequest);
      await expect(
        launched.page.getByText("Loading branches…", { exact: true })
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-old-90d")).toHaveCount(
        0
      );
      const rowsPerPage = launched.page.getByRole("combobox", {
        name: "Rows per page",
      });
      await expect(rowsPerPage).toBeVisible();
      await expect(rowsPerPage).toBeDisabled();
      await expect(rowsPerPage).toContainText("25 / page");
      await expect(branchLink(launched.page, "iss-7197-mid-30d")).toHaveCount(
        0
      );
      await expect(branchLink(launched.page, "iss-7197-recent-7d")).toHaveCount(
        0
      );
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      await expect(
        launched.page.getByRole("button", { name: NAME_COLUMN_BUTTON })
      ).toHaveCount(0);
      await expect(launched.page.getByText(NET_NEW_BANNER_COPY)).toHaveCount(0);
      await expect(launched.page.getByText(COHORT_CLAIM_PATTERN)).toHaveCount(
        0
      );
      await expect(
        launched.page.getByText("1–4 of 4", { exact: true })
      ).toHaveCount(0);
      await launched.page.screenshot({
        fullPage: true,
        path: test.info().outputPath("branches-7d-pending.png"),
      });

      const sevenDay = await releaseHeldRequests(
        launched.app,
        isSevenDayRequest
      );
      await expect(
        branchLink(launched.page, "iss-7197-recent-7d")
      ).toBeVisible();
      await expect(
        branchLink(launched.page, "iss-7197-unavailable")
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-mid-30d")).toHaveCount(
        0
      );
      await expect(branchLink(launched.page, "iss-7197-old-90d")).toHaveCount(
        0
      );
      await expect(
        launched.page.getByText("1–2 of 2", { exact: true })
      ).toBeVisible();
      await expect(rowsPerPage).toBeEnabled();
      await expect(rowsPerPage).toContainText("25 / page");
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      await expect(
        launched.page.getByText("2 Branches in Last 7 days")
      ).toHaveCount(0);

      await advancePageClock(
        launched.page,
        SERVER_PAGE_CLOCK_RETRY_BOUNDARY_MS + CLIENT_CLOCK_SKEW_MS
      );

      await launched.page
        .locator('[aria-label="Last 30 days"]:visible')
        .click();
      await waitForHeldRequests(launched.app, isThirtyDayRequest);
      await expect(
        launched.page.getByText("Loading branches…", { exact: true })
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-recent-7d")).toHaveCount(
        0
      );
      await expect(
        branchLink(launched.page, "iss-7197-unavailable")
      ).toHaveCount(0);
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      const thirtyDay = await releaseHeldRequests(
        launched.app,
        isThirtyDayRequest
      );
      expect(thirtyDay[0]?.request.startDate).not.toBe(
        sevenDay[0]?.request.startDate
      );
      await expect(
        branchLink(launched.page, "iss-7197-recent-7d")
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-mid-30d")).toBeVisible();
      await expect(
        branchLink(launched.page, "iss-7197-unavailable")
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-old-90d")).toHaveCount(
        0
      );
      await expect(
        launched.page.getByText("1–3 of 3", { exact: true })
      ).toBeVisible();
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      await expect(
        launched.page.getByText("3 Branches in Last 30 days")
      ).toHaveCount(0);
      await expect(launched.page.getByText(NET_NEW_BANNER_COPY)).toHaveCount(0);
      await expect(
        launched.page.getByRole("button", { name: NAME_COLUMN_BUTTON })
      ).toBeVisible();

      await launched.page.getByRole("button", { name: "Filter" }).click();
      await launched.page.getByRole("menuitem", { name: "Name" }).click();
      await expect(
        launched.page.getByRole("menuitem", { name: RECENT_FACET_PATTERN })
      ).toBeVisible();
      await expect(
        launched.page.getByRole("menuitem", { name: MID_FACET_PATTERN })
      ).toBeVisible();
      await expect(
        launched.page.getByRole("menuitem", { name: OLD_FACET_PATTERN })
      ).toHaveCount(0);
      await launched.page.keyboard.press("Escape");
      await launched.page.keyboard.press("Escape");

      // ISS-9225: the desktop view hands `BranchesListSurfaceV2` ONE toolbar
      // prop set and the surface composes `BranchesListToolbarV2` from it.
      // Mounting the package surface with callback spies cannot tell that apart
      // from a host that built the props and never reached the toolbar with
      // them (davetho), so this drives the shipped renderer: hide a column
      // from the Options menu and the desktop table has to lose the header,
      // then "Reset view" has to bring it back.
      const repositoryHeader = branchColumnHeader(
        launched.page,
        REPOSITORY_COLUMN_ID
      );
      await expect(repositoryHeader).toBeVisible();
      await optionsMenuTrigger(launched.page).click();
      await launched.page.getByRole("menuitem", REPOSITORY_COLUMN_ROW).click();

      // Close the menu BEFORE reading the table. Radix's dropdown is modal and
      // `aria-hidden`s the view behind it, so a columnheader query taken while
      // it is open resolves to nothing whether or not the toggle ever reached
      // the table — the assertion below would pass against a toolbar wired to
      // nothing.
      await launched.page.keyboard.press("Escape");
      await expect(repositoryHeader).toHaveCount(0);

      await optionsMenuTrigger(launched.page).click();
      await launched.page.getByRole("menuitem", RESET_VIEW_ROW).click();
      await expect(repositoryHeader).toBeVisible();

      await launched.page.screenshot({
        fullPage: true,
        path: test.info().outputPath("branches-30d-settled.png"),
      });

      const sevenDayRequestCount = await pageDataRequestCount(
        launched.app,
        isSevenDayRequest
      );
      await launched.page.locator('[aria-label="Last 7 days"]:visible').click();
      await settleClientRender(launched.page);
      await expect(
        launched.page.getByText("Loading branches…", { exact: true })
      ).toHaveCount(0);
      await expect(
        branchLink(launched.page, "iss-7197-recent-7d")
      ).toBeVisible();
      await expect(
        branchLink(launched.page, "iss-7197-unavailable")
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-mid-30d")).toHaveCount(
        0
      );
      await expect(branchLink(launched.page, "iss-7197-old-90d")).toHaveCount(
        0
      );
      await expect(
        launched.page.getByText("1–2 of 2", { exact: true })
      ).toBeVisible();
      await expect(
        metricCardValue(launched.page, "Active branches")
      ).toHaveText("—");
      await expect(
        launched.page.getByText("2 Branches in Last 7 days")
      ).toHaveCount(0);
      expect(await pageDataRequestCount(launched.app, isSevenDayRequest)).toBe(
        sevenDayRequestCount
      );

      await launched.page.locator('[aria-label="All time"]:visible').click();
      await rejectHeldRequests(launched.app, isAllTimeRequest);
      await expect(
        launched.page.getByText("Couldn't load branches", { exact: true })
      ).toBeVisible();
      await expect(
        launched.page.getByRole("button", { name: RETRY_BUTTON_NAME_PATTERN })
      ).toBeVisible();
      await expect(branchLink(launched.page, "iss-7197-recent-7d")).toHaveCount(
        0
      );
      await expect(branchLink(launched.page, "iss-7197-mid-30d")).toHaveCount(
        0
      );
      await expect(
        branchLink(launched.page, "iss-7197-unavailable")
      ).toHaveCount(0);
      await expect(
        launched.page.getByRole("button", { name: NAME_COLUMN_BUTTON })
      ).toHaveCount(0);
      await expect(launched.page.getByText(NET_NEW_BANNER_COPY)).toHaveCount(0);
      await expect(launched.page.getByText(COHORT_CLAIM_PATTERN)).toHaveCount(
        0
      );
      expect(launched.pageErrors).toEqual([]);
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

async function installControllablePageClock(page: Page): Promise<void> {
  await page.evaluate((key: string) => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    Reflect.set(globalThis, key, (milliseconds: number) => {
      offsetMs += milliseconds;
    });
    Date.now = () => realNow() + offsetMs;
  }, CONTROLLED_PAGE_CLOCK_KEY);
}

async function advancePageClock(
  page: Page,
  milliseconds: number
): Promise<void> {
  await page.evaluate(
    ({ key, deltaMs }) => {
      const advanceClock = Reflect.get(globalThis, key) as unknown;
      if (typeof advanceClock !== "function") {
        throw new Error("The controllable Branches E2E clock is not installed");
      }
      advanceClock(deltaMs);
    },
    { deltaMs: milliseconds, key: CONTROLLED_PAGE_CLOCK_KEY }
  );
  await settleClientRender(page);
}

async function settleClientRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      })
  );
}

async function waitForHeldRequests(
  app: Parameters<typeof readHeldBranchesPageData>[0],
  predicate: (held: HeldBranchesPageData) => boolean
) {
  await expect
    .poll(async () => (await readHeldRequests(app, predicate)).length)
    .toBeGreaterThan(0);
  return readHeldRequests(app, predicate);
}

async function releaseHeldRequests(
  app: Parameters<typeof readHeldBranchesPageData>[0],
  predicate: (held: HeldBranchesPageData) => boolean
) {
  const held = await waitForHeldRequests(app, predicate);
  for (const entry of held) {
    await releaseHeldBranchesPageData(app, entry.id);
  }
  return held;
}

async function rejectHeldRequests(
  app: Parameters<typeof readHeldBranchesPageData>[0],
  predicate: (held: HeldBranchesPageData) => boolean
) {
  const held = await waitForHeldRequests(app, predicate);
  for (const entry of held) {
    await rejectHeldBranchesPageData(app, entry.id);
  }
  return held;
}

async function readHeldRequests(
  app: Parameters<typeof readHeldBranchesPageData>[0],
  predicate: (held: HeldBranchesPageData) => boolean
) {
  return (await readHeldBranchesPageData(app)).filter(predicate);
}

async function pageDataRequestCount(
  app: Parameters<typeof readBranchesPageDataGateStats>[0],
  predicate: (held: HeldBranchesPageData) => boolean
): Promise<number> {
  const stats = await readBranchesPageDataGateStats(app);
  return stats.requests.filter(predicate).length;
}

function isSevenDayRequest(held: HeldBranchesPageData): boolean {
  const ageDays = requestStartAgeDays(held);
  return ageDays !== null && ageDays <= 14;
}

function isThirtyDayRequest(held: HeldBranchesPageData): boolean {
  const ageDays = requestStartAgeDays(held);
  return ageDays !== null && ageDays > 14 && ageDays <= 45;
}

function isAllTimeRequest(held: HeldBranchesPageData): boolean {
  return held.request.startDate === undefined;
}

function requestStartAgeDays(held: HeldBranchesPageData): number | null {
  const startDate = Date.parse(held.request.startDate ?? "");
  return Number.isFinite(startDate) ? (Date.now() - startDate) / DAY_MS : null;
}

async function seedRangeRows(
  userDataDir: string,
  repository: string
): Promise<void> {
  await seedRangeBranch(
    userDataDir,
    repository,
    "iss-7197-recent-7d",
    "iss-7197-recent-session",
    2
  );
  await seedRangeBranch(
    userDataDir,
    repository,
    "iss-7197-mid-30d",
    "iss-7197-mid-session",
    20
  );
  await seedRangeBranch(
    userDataDir,
    repository,
    "iss-7197-old-90d",
    "iss-7197-old-session",
    60
  );
  await seedRangeBranch(
    userDataDir,
    repository,
    "iss-7197-unavailable",
    "iss-7197-unavailable-session",
    -2
  );
}

async function seedRangeBranch(
  userDataDir: string,
  repository: string,
  branchName: string,
  sessionId: string,
  ageDays: number
): Promise<void> {
  const activityAt = activityAtDaysAgo(ageDays);
  await seedNoPullRequestBranch(userDataDir, {
    repoFullName: repository,
    branchName,
    sessionId,
    activityAt,
    canonicalActivityEvidenceJson: canonicalActivityEvidence(
      activityAt,
      sessionId
    ),
  });
}

function canonicalActivityEvidence(
  occurredAt: string,
  sourceEventId: string
): string {
  const completeness = BranchActivityEvidenceCompleteness.Complete;
  return JSON.stringify({
    monitoredSessionActivity: {
      completeness,
      events: [
        {
          completeness,
          kind: MonitoredSessionActivityEventKind.AgentAction,
          occurredAt,
          sourceEventId,
        },
      ],
    },
  });
}

function activityAtDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function metricCardValue(page: Page, label: string) {
  return page
    .locator(CARD_SELECTOR)
    .filter({ hasText: label })
    .first()
    .locator(CARD_VALUE_SELECTOR);
}

function branchLink(page: Page, name: string) {
  return page
    .getByRole("region", { name: "Branches" })
    .getByRole("link", { name, exact: true });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_PAGE_CLOCK_RETRY_BOUNDARY_MS = 5000;
const CLIENT_CLOCK_SKEW_MS = 1000;
const CONTROLLED_PAGE_CLOCK_KEY = "__clBranchesE2eAdvanceNow";
const CARD_SELECTOR = '[data-slot="card"]';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const RETRY_BUTTON_NAME_PATTERN = /retry/i;
/** The grid's sortable lead (branch name) column header. */
const NAME_COLUMN_BUTTON = "Name";
const COHORT_CLAIM_PATTERN =
  /Updating Branches for|Couldn't update Branches for/i;
const NET_NEW_BANNER_COPY =
  "These branches are tracked locally with no linked pull request yet — the metrics shown are net-new.";
const DESKTOP_DATE_RANGE_STORAGE_KEY = "shared:date-range:desktop";
const RECENT_FACET_PATTERN = /iss-7197-recent-7d/;
const MID_FACET_PATTERN = /iss-7197-mid-30d/;
const OLD_FACET_PATTERN = /iss-7197-old-90d/;

/**
 * The VISIBLE Options trigger. `GridTableToolbar` mounts its wide and folded
 * clusters as sibling slots and hides one with CSS, so the role query matches
 * twice. `exact` because Playwright name matching is a substring and "Options"
 * is a prefix a later "More options" control would satisfy.
 */
function optionsMenuTrigger(page: Page) {
  return page
    .getByRole("button", { exact: true, name: "Options" })
    .filter({ visible: true });
}

/**
 * A header cell addressed by COLUMN ID rather than accessible name (ISS-6065).
 *
 * The v2 grid renders a resize handle and a column-options button INSIDE the
 * header cell. Before ISS-11837 those controls' names were folded into the
 * cell's accessible name, so a name lookup for "Repository" matched nothing and
 * the absence assertion would have passed whether or not the toggle ever
 * reached the table. The cell is now named by its label, but the column id is
 * still the address that cannot drift with the header's naming.
 *
 * `:visible` scopes it to the Branches table. The shell keeps visited views
 * mounted-but-hidden, and Dashboard — the canonical landing, so always the first
 * one mounted — renders a Recent Sessions grid carrying its own
 * `[data-column-id="repo"]` header. Without this the presence assertions are a
 * strict-mode violation and the ABSENCE assertion below could be satisfied by
 * the hidden Dashboard copy, which is the failure mode this helper's whole
 * docstring is about. A hidden view can never satisfy `:visible`, so the
 * absence assertion keeps its teeth.
 */
function branchColumnHeader(page: Page, columnId: string) {
  return page.locator(
    `[role="columnheader"][data-column-id="${columnId}"]:visible`
  );
}

/** `APPROVED_BRANCH_TOGGLEABLE_COLUMNS`' id for the "Repository" column. */
const REPOSITORY_COLUMN_ID = "repo";
const REPOSITORY_COLUMN_ROW = { exact: true, name: "Repository" } as const;
const RESET_VIEW_ROW = { exact: true, name: "Reset view" } as const;
