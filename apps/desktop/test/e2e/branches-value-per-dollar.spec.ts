/**
 * PRD-601 LIST-012 requires the exact "LOC per $" label and a ratio of
 * independently windowed publication LOC and qualifying Session cost. This
 * guest-shell test keeps the local rows and phase attribution visible while
 * refusing a ratio without account-backed default-branch authority (ISS-10574).
 * `desktop-default-branch-production-wiring.test.ts` covers the numeric SQLite
 * producer with an explicit fresh authority source.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.ts";
import { createBranchesListParityData } from "../../../../e2e/helpers/branches-list-parity-data";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  type SharedSessionLocPerDollarSeed,
  seedSharedSessionLocPerDollarBranches,
} from "./helpers/seed-loc-per-dollar-db";

// The canonical label — `packages/api/src/utils/loc-per-dollar.ts`. Pinned as a
// local literal rather than imported: a desktop e2e spec must never import an
// extension-less `@repo/*` TS subpath, which aborts the WHOLE Electron suite at
// load time before any test runs.
const branchesListParityData = createBranchesListParityData();
const { branches, expectations, repoDisplayName, repoFullName, session } =
  branchesListParityData;
const CARD_SELECTOR = '[data-slot="card"]';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const ALL_TIME_RANGE_LABEL = DesktopDateRangeLabel.AllTime;
// A finite range that is NOT the 7d landing default. The boot-time analytics
// fetch for the default window can race the branch-analytics projection and be
// cached (staleTime) with a mid-projection value; re-selecting that same window
// would serve the racy cache instead of a fresh windowed read. 30d draws the
// same cohort (the older merge is 45 days out), so every expectation holds.
const FINITE_RANGE_LABEL = DesktopDateRangeLabel.Last30Days;

const SEED: SharedSessionLocPerDollarSeed = {
  branches: [
    {
      branchId: branches.recent.id,
      branchName: branches.recent.name,
      mergedAt: branches.recent.activityAt,
      prNumber: branches.recent.prNumber,
    },
    {
      branchId: branches.older.id,
      branchName: branches.older.name,
      mergedAt: branches.older.activityAt,
      prNumber: branches.older.prNumber,
    },
  ],
  costUsd: session.costUsd,
  repoFullName,
  sessionId: session.id,
};

test.describe("Guest Branches local metrics", () => {
  test("keeps windowed rows and phase attribution without a false cohort ratio", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-udd-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      // Seed the shared-session, two-branch corpus while the app is DOWN.
      await seedSharedSessionLocPerDollarBranches(userDataDir, SEED);

      // Launch 2 — the app's real branch-analytics projection reads the seeded
      // corpus at boot.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        // The published rows survive locally, but this guest has no authority
        // to exclude the repository default from the cohort.
        await clickDesktopDateRange(page, ALL_TIME_RANGE_LABEL);
        await assertCanonicalBranchRow(page, branches.recent);
        await assertCanonicalBranchRow(page, branches.older);
        expect(await readCanonicalMetricSnapshot(page)).toEqual({
          aiSpendUsd: {
            state: BranchMetricAvailability.Unavailable,
            value: null,
          },
          cohortSize: 2,
          locPerDollar: {
            state: BranchMetricAvailability.Unavailable,
            value: null,
          },
          medianPrSize: {
            state: BranchMetricAvailability.Unavailable,
            value: null,
          },
          phaseCoverage: { completeness: "complete", subtotalUsd: 50 },
        });
        await expect(locPerDollarValue(page)).toHaveText("No data", {
          timeout: 30_000,
        });

        // Narrowing to 30 days removes only the older publication; lack of
        // authority must not turn the remaining local row into a ratio.
        await clickDesktopDateRange(page, FINITE_RANGE_LABEL);
        await expect(
          visibleBranchNameCells(page, branches.older.name)
        ).toHaveCount(0);
        await assertCanonicalBranchRow(page, branches.recent);
        await expect(locPerDollarValue(page)).toHaveText("No data", {
          timeout: 30_000,
        });

        // Follow the real local list link into Branch Detail. The one $100
        // session is shared by two branches, so the renderer must receive and
        // display the SQLite projection's canonical $50 share, never raw $100.
        await page
          .getByRole("link", { name: branches.recent.name })
          .first()
          .click();
        await expect(
          page.getByRole("heading", { name: branches.recent.name })
        ).toBeVisible({ timeout: 30_000 });
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        const timeline = page.locator("section.bq-act");
        await expect(
          timeline.getByText("$50.00", { exact: true }).first()
        ).toBeVisible();
        await expect(
          timeline.getByText("$100.00", { exact: true })
        ).toHaveCount(0);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("value-per-dollar-card-e2e.png"),
        });

        // No uncaught renderer errors (a blanked chunk would also fail above).
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/** Every VISIBLE rendering of a branch name, for the absence assertion. */
function visibleBranchNameCells(page: Page, branchName: string) {
  return page.getByText(branchName).locator("visible=true");
}

/**
 * The one LOC per $ summary card, located through its canonical label. `:visible`
 * scopes past the keep-alive-hidden Sessions view, which stays mounted (and
 * would otherwise collide in a page-wide match) once it has been visited.
 */
function locPerDollarValue(page: Page) {
  return metricCardValue(page, expectations.locPerDollarLabel);
}

/** Read the producer result directly so a projection failure is diagnosable. */
function readCanonicalMetricSnapshot(page: Page) {
  return page.evaluate(async () => {
    const desktopApi = Reflect.get(
      new Object(globalThis.window),
      "desktopApi"
    ) as
      | {
          branchesApi?: {
            analytics?: (query: object) => Promise<{
              canonicalMetrics?: {
                cohortSize?: number;
                aiSpendUsd?: {
                  current?: { state: string; value: number | null };
                };
                locPerDollar?: {
                  current?: { state: string; value: number | null };
                };
                medianPrSize?: {
                  current?: { state: string; value: number | null };
                };
              };
            }>;
            detail?: (id: string) => Promise<{
              phaseAttribution?: { coverage?: unknown };
            } | null>;
            list?: (query: object) => Promise<{ items?: { id: string }[] }>;
          };
        }
      | undefined;
    const analytics = await desktopApi?.branchesApi?.analytics?.({});
    const list = await desktopApi?.branchesApi?.list?.({});
    const detail = list?.items?.[0]?.id
      ? await desktopApi?.branchesApi?.detail?.(list.items[0].id)
      : null;
    const metrics = analytics?.canonicalMetrics;
    return {
      cohortSize: metrics?.cohortSize,
      aiSpendUsd: metrics?.aiSpendUsd?.current,
      locPerDollar: metrics?.locPerDollar?.current,
      medianPrSize: metrics?.medianPrSize?.current,
      phaseCoverage: detail?.phaseAttribution?.coverage,
    };
  });
}

/** One canonical summary card value, located through its shared label. */
function metricCardValue(page: Page, label: string) {
  return page
    .locator(`${CARD_SELECTOR}:visible`)
    .filter({ hasText: label })
    .first()
    .locator(CARD_VALUE_SELECTOR);
}

/** Pin the identity, PR, repository, and canonical activity visible in one row. */
async function assertCanonicalBranchRow(
  page: Page,
  branch: (typeof branches)[keyof typeof branches]
): Promise<void> {
  const row = page
    .locator("div.grid.h-11:visible")
    .filter({ hasText: branch.name })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(
    row
      .locator(
        `a[href="https://github.com/${repoFullName}/pull/${branch.prNumber}"]`
      )
      // ISS-12709 (#8970): Desktop stores no GitHub PR state, so the chip also
      // carries the ISS-8422 unconfirmed tail; the label span is pinned alone.
      .locator("span")
      .first()
    // ISS-7362 (whitlockk): inside the 150px `pr` track the org prefix repeats on
    // every row of an org-scoped list, so the chip carries the same short label
    // the Repository cell shows. One repo in this corpus ⇒ unambiguous ⇒ elided.
  ).toHaveText(`${repoDisplayName}#${branch.prNumber}`);
  await expect(
    row.locator(`a[aria-label="${repoFullName} repository on GitHub"]`)
  ).toBeVisible();
  await expect(row).toContainText(branch.lastActiveLabel);
}
