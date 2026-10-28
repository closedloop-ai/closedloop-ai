/**
 * ISS-11412: Desktop Insights pages its bounded session list through the v2
 * `TablePagination`.
 *
 * The v1 pager rendered nothing for a single page; v2 stays mounted with both
 * boundaries locked, as v2 is designed (ISS-11412 Decision 3). So the one-page
 * and empty cases fail on the base, and the two-page case is parity: Next still moves the
 * bounded view's own "<from>-<to> of <total>" chip to the second page.
 *
 * Seeding follows `insights-load-and-verify.spec.ts`: launch once to create the
 * SQLite schema, write the sessions straight into the store with the app down,
 * then launch again and click "Load insights". Every harness home is isolated,
 * so the seeded sessions are the only ones and the chip is deterministic.
 */

import { expect, type Page, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
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

/** The bounded view's page size (`desktop-insights-bounded-view.tsx`). */
const INSIGHTS_PAGE_SIZE = 25;

const PREVIOUS_PAGE_LABEL = "Go to previous page";
const NEXT_PAGE_LABEL = "Go to next page";
const MOUNT_TIMEOUT_MS = 30_000;
const CARD_SELECTOR = '[data-slot="card"]';
/** `Pagination`'s wrapper (`@closedloop-ai/design-system/components/ui/pagination`). */
const PAGER_SELECTOR = '[aria-label="pagination"]';

test.describe("Insights pager (ISS-11412)", () => {
  test("a one-page list shows the pager with both boundaries locked", async () => {
    test.setTimeout(240_000);
    await withLoadedInsights(seeds(3), async (page) => {
      await expect(page.getByText("1-3 of 3", { exact: true })).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(
        visible(page.getByLabel(PREVIOUS_PAGE_LABEL))
      ).toHaveAttribute("aria-disabled", "true");
      await expect(visible(page.getByLabel(NEXT_PAGE_LABEL))).toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });
  });

  test("an empty list shows the pager with both boundaries locked", async () => {
    test.setTimeout(240_000);
    await withLoadedInsights([], async (page) => {
      await expect(page.getByText("0-0 of 0", { exact: true })).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(
        visible(page.getByLabel(PREVIOUS_PAGE_LABEL))
      ).toHaveAttribute("aria-disabled", "true");
      await expect(visible(page.getByLabel(NEXT_PAGE_LABEL))).toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });
  });

  test("Next moves the bounded list to its second page", async () => {
    test.setTimeout(240_000);
    const total = INSIGHTS_PAGE_SIZE + 2;
    const sessions = seeds(total);
    await withLoadedInsights(sessions, async (page) => {
      await expect(
        page.getByText(`1-${INSIGHTS_PAGE_SIZE} of ${total}`, { exact: true })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      const firstPage = await sessionsInList(page, sessions);
      expect(firstPage).toHaveLength(INSIGHTS_PAGE_SIZE);

      await visible(page.getByLabel(NEXT_PAGE_LABEL)).click();

      await expect(
        page.getByText(`${INSIGHTS_PAGE_SIZE + 1}-${total} of ${total}`, {
          exact: true,
        })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      // The rows moved with the chip: the list now holds exactly the sessions
      // the first page did not, so a chip that advanced over stale rows fails.
      await expect
        .poll(() => sessionsInList(page, sessions), {
          timeout: MOUNT_TIMEOUT_MS,
        })
        .toEqual(
          sessions
            .map((session) => session.sessionId)
            .filter((sessionId) => !firstPage.includes(sessionId))
        );
      await expect(visible(page.getByLabel(NEXT_PAGE_LABEL))).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      await expect(
        visible(page.getByLabel(PREVIOUS_PAGE_LABEL))
      ).toHaveAttribute("aria-disabled", "false");
    });
  });
});

/**
 * The seeded session ids the Insights card lists, in seed order. Scoped to the
 * card that holds the pager: other views the shell keeps mounted render the
 * same `#/sessions/<id>` links.
 */
async function sessionsInList(
  page: Page,
  sessions: SessionListSeed[]
): Promise<string[]> {
  const card = page
    .locator(CARD_SELECTOR)
    .filter({ has: page.locator(PAGER_SELECTOR) })
    .locator("visible=true")
    .first();
  const listed: string[] = [];
  for (const { sessionId } of sessions) {
    if ((await card.locator(`a[href="#/sessions/${sessionId}"]`).count()) > 0) {
      listed.push(sessionId);
    }
  }
  return listed;
}

/** `count` distinct sessions, minutes apart so their order is stable. */
function seeds(count: number): SessionListSeed[] {
  const now = Date.now();
  return Array.from({ length: count }, (_unused, index) => ({
    at: new Date(now - index * 60_000).toISOString(),
    name: `iss-11412 insights pager ${String(index).padStart(2, "0")}`,
    sessionId: `iss-11412-insights-pager-${index}`,
  }));
}

/**
 * The one on-screen match: views the shell keeps mounted while hidden can carry
 * a pager of their own.
 */
function visible(locator: ReturnType<Page["getByLabel"]>) {
  return locator.locator("visible=true").first();
}

/** Seed `sessions`, launch, open Insights, load it, and hand over the page. */
async function withLoadedInsights(
  sessions: SessionListSeed[],
  assert: (page: Page) => Promise<void>
): Promise<void> {
  const dirs = makeSeededSessionsDirs("desktop-insights-pager");
  const env = seededSessionsEnv(dirs);
  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(dirs.userDataDir, sessions);

    const app = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await gotoNav(app.page, "insights");
      const loadButton = app.page.getByRole("button", {
        name: "Load insights",
      });
      await expect(loadButton).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await loadButton.click();

      await assert(app.page);

      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
}
