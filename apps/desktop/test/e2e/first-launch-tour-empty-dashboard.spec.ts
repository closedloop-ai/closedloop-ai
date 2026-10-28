/**
 * ISS-9992 regression, through the launched app: a first-launch install whose
 * dashboard draws the EMPTY state must not open the guided tour, and must not
 * spend the install's one shot.
 *
 * The shipped bug. Arming was gated on the reveal tick, the backfill settle, the
 * insights read, the harness read, the assignment, `firstLaunch` and the tour
 * standing — and none of those asked what the page had DRAWN. On an install with
 * no sessions `DashboardEmptySurface` replaces the body before a single row renders, so
 * no `data-tour` anchor exists at all, while the header's `[data-tour-btn]` still
 * satisfied the arm's on-screen guard (ISS-10929 has since retired that control
 * and moved the guard onto `[data-tour]` itself). The tour opened over nothing, wrote
 * `dashboardOnboardedStorageKey`, and `closeTour` then retired the tour for that
 * reader on EVERY device — for the exact cohort onboarding exists for.
 *
 * WHY THE RENDERER SUITE IS NOT ENOUGH (
 * `src/renderer/components/dashboard/__tests__/first-launch-dashboard-empty-tour.test.tsx`).
 * It injects the session read, the source probe, the harness read and the
 * insights hooks as separate mocks and drives every clock by hand, so it pins
 * the decision but never the chain that produces its inputs: the boot import
 * finding nothing, the local SQLite read, the source-readiness probe, the real
 * 2.5s poll, the reveal interval, and the header control's own presence under a
 * real layout. All of that exists only in a booted Electron app.
 *
 * ONE PROFILE, TWO LAUNCHES, and the second is what makes the first
 * non-vacuous. Launch 1 is the regression: empty store, genuine first launch, no
 * tour and no latch. Launch 2 seeds a single session into that SAME profile
 * while the app is down and launches it again — still a first launch precisely
 * because launch 1 declined to write the latch — and the tour opens on its own.
 * So every gate the arm waits on demonstrably opens in this environment, and
 * launch 1's silence is the content check rather than a dead harness. Launch 2
 * is also the user-visible payoff: the reader still gets their tour, on the
 * launch that has something to show them.
 *
 * Would fail before the change: launch 1's dashboard would open the tour intro
 * over its empty state and write the latch, and launch 2 would then be an
 * already-onboarded launch with no tour left to give.
 *
 * HOW LAUNCH 1's SILENCE IS MEASURED. The arm gate that costs wall-clock here
 * is rendered: `DashboardEmptySurface`'s own title draws only once
 * `resolveDashboardState` has stopped resolving and settled on `Empty`, so its
 * APPEARANCE is the page reporting that. ISS-10492 retired `AnalyzingBar` — the
 * dashboard's second progress surface — which used to carry this signal; the
 * empty title is the same fact from the branch the assertions already name.
 * That is awaited with an explicit timeout, not slept through. The window is then read
 * with a page-side MutationObserver armed BEFORE it opens, so a callout that
 * opened and closed inside it is still counted — an end-of-window sample alone
 * could not see one. The latch is the durable half of the same proof: the arm
 * writes it in the beat it opens the tour, so it survives any close.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { dashboardOnboardedStorageKey } from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { insightsTrendSeedIso } from "./helpers/insights-trend-seed";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The first beat of the canonical run, which ISS-10546 made the run's OPENING
 * callout: the intro summary card that used to lead it is retired, so the tour
 * now paints `stats` first.
 */
const TOUR_FIRST_STEP_TITLE = "Start with the headline metrics";
/**
 * The blocker the tour lays behind EVERY step, and the handle both the absence
 * and the presence checks below address the tour by.
 *
 * Deliberately not a step title. This spec's absence assertions are the whole
 * point of it — a tour that must NOT have opened — and a title literal stops
 * matching the moment the run's first beat is reworded or reordered, which
 * turns the assertion green while the tour opens behind it. The blocker is
 * emitted by the engine for any run, so it cannot go stale that way.
 */
const TOUR_BLOCKER_SELECTOR = 'button[aria-label="Skip tour"]';
/** The local-read empty treatment. Every e2e profile is signed out. */
const DASHBOARD_EMPTY_TEXT = "No agent sessions yet";
// Two cards ONLY the promoted skeleton draws (ISS-10567). The blank slate this
// replaced rendered `DASHBOARD_EMPTY_TEXT` and nothing else, so that string
// alone would stay green if the skeleton mount regressed. Spelled as literals
// rather than imported from the component under test: a fixture built from the
// thing under test agrees with the thing under test when it is renamed away.
const PROMOTED_SKELETON_ACTIVITY_EMPTY = "No activity yet";
const PROMOTED_SKELETON_PR_THROUGHPUT = "PR throughput";
/**
 * The local arm's description, naming every source the collectors scan
 * (ISS-11346). A literal for the same reason as the two cards above.
 */
const DASHBOARD_EMPTY_LOCAL_DESCRIPTION =
  "Start using Claude Code, Codex, Cursor, Copilot, or OpenCode on this Mac and your sessions will appear here automatically — computed locally, nothing uploaded.";
const SEEDED_SESSION_ID = "iss-9992-second-launch-session";
const STEP_BUDGET_MS = 30_000;
/**
 * How long the auto-arm is given to open the tour on the launch that should get
 * one. Generous: it covers the reveal, the settle polls, three insights reads
 * and the arm's own delay on a cold Electron start.
 */
const ARM_BUDGET_MS = 90_000;
/**
 * The residual hold after the rendered arm gate clears, before the absence is
 * read back.
 *
 * The empty title proves the dashboard state resolved, and it is awaited rather
 * than assumed. It does NOT prove the reveal ran out or that the run is
 * `settled`:
 * the backfill latch needs two further no-growth session polls at
 * `BOOT_IMPORT_STORE_POLL_MS` and draws nothing at all, so there is no signal left to
 * await for that one. So this covers those two polls plus the arm's own 650ms
 * delay — 5.65s of mechanism, budgeted at better than double. Measured against
 * a build that arms on `Empty`: it opened the tour 6.4s after the observer
 * below was armed, against a reveal that cannot clear before 3.6s, so the gap
 * this actually has to span was under 3s.
 */
const EMPTY_ARM_MARGIN_MS = 12_000;
/**
 * The tour, however it opened. `Tour` lays a "Skip tour" blocker behind every
 * step, so this catches whichever run resolved rather than only the beat the
 * assertions name.
 */
const TOUR_OPEN_SELECTOR = TOUR_BLOCKER_SELECTOR;

test("ISS-9992: an empty first launch keeps its tour for the launch that has rows", async () => {
  test.setTimeout(360_000);

  const homes = createHarnessHomes();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss9992-empty-tour-")
  );

  try {
    const empty = await launchDesktopApp({
      env: homes.env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(empty.page, "dashboard");
      await expect(
        empty.page.getByRole("heading", {
          exact: true,
          level: 1,
          name: DASHBOARD_HEADING,
        })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });

      // Armed BEFORE the window: a tour that opens and closes inside it leaves
      // nothing for a check at the end to find.
      await observeTourOpens(empty.page);

      // The page is on the EMPTY branch, asserted from the title only
      // `DashboardEmptySurface` draws — a still-loading dashboard is anchorless
      // too, so "no anchor" alone would not tell the two apart.
      await expect(empty.page.getByText(DASHBOARD_EMPTY_TEXT)).toBeVisible({
        timeout: STEP_BUDGET_MS,
      });
      // ...and it is the PROMOTED skeleton, not the blank slate it replaced:
      // both of these are cards only the skeleton emits, in this launched-app
      // flow (davetho).
      await expect(
        empty.page.getByText(PROMOTED_SKELETON_ACTIVITY_EMPTY)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(
        empty.page.getByText(PROMOTED_SKELETON_PR_THROUGHPUT)
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(
        empty.page.getByText(DASHBOARD_EMPTY_LOCAL_DESCRIPTION, { exact: true })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(empty.page.locator("[data-tour]")).toHaveCount(0);
      // ...and ISS-10929 retired the header control entirely, so there is no
      // replay press left that could open a run by hand over a page with no
      // anchors. The arm's on-screen gate moved with it: it now asks for the
      // run's own `[data-tour]` anchor, which this page draws none of —
      // launch 2 below is this file's own proof that the arm still fires where
      // the page does draw them.
      await expect(empty.page.locator("[data-tour-btn]")).toHaveCount(0);

      // The state has resolved — the arm gate that takes wall-clock, awaited on
      // the page's own rendering of it (the empty title asserted above).
      await empty.page.waitForTimeout(EMPTY_ARM_MARGIN_MS);

      // A captured count over the whole window, not a sample at the end of it.
      // A non-null record is also proof the observer was still installed.
      expect(await readTourOpens(empty.page)).toEqual({
        firstOpenMs: null,
        opens: 0,
      });
      await expect(empty.page.locator(TOUR_BLOCKER_SELECTOR)).toHaveCount(0);
      await expect(empty.page.getByText(DASHBOARD_EMPTY_TEXT)).toBeVisible();
      // The shot is unspent. This is what makes the relaunch below a FIRST
      // launch, and it is the value the shipped build destroyed permanently.
      expect(await readOnboardedLatch(empty.page)).toBeNull();
      expect(empty.pageErrors).toEqual([]);

      // The db host migrates asynchronously after launch, so the seed below
      // would otherwise race the migration.
      await waitForBranchesSchema(userDataDir);
    } finally {
      await empty.cleanup();
    }

    // Seeded while the app is DOWN, so there is no cross-process WAL contention.
    await seedSessionsList(userDataDir, [
      {
        sessionId: SEEDED_SESSION_ID,
        at: insightsTrendSeedIso(),
        name: "ISS-9992 second-launch seed",
      },
    ]);

    const populated = await launchDesktopApp({
      env: homes.env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoNav(populated.page, "dashboard");
      await expect(
        populated.page.getByRole("heading", {
          exact: true,
          level: 1,
          name: DASHBOARD_HEADING,
        })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });

      // Nothing is clicked here: this is the AUTO-arm, the same one launch 1
      // declined, now firing on a page that has something to ring.
      await expect(
        populated.page.getByRole("dialog", { name: TOUR_FIRST_STEP_TITLE })
      ).toBeVisible({ timeout: ARM_BUDGET_MS });
      await expect(populated.page.getByText(DASHBOARD_EMPTY_TEXT)).toHaveCount(
        0
      );
      await expect
        .poll(() => readOnboardedLatch(populated.page), {
          message: "the arm writes the first-launch latch as it opens the tour",
          timeout: STEP_BUDGET_MS,
        })
        .toBe("1");
    } finally {
      await populated.cleanup();
    }
  } finally {
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * Isolated harness homes, so the operator's (or the runner's) real Claude/Codex
 * transcripts are never imported. Without them the first launch would ingest
 * whatever is on the machine and stop being the empty install under test.
 */
function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss9992-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss9992-codex-")
  );
  return {
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
    dirs: [claudeHome, codexHome],
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readOnboardedLatch(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => localStorage.getItem(key),
    dashboardOnboardedStorageKey
  );
}

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: a global `Window` augmentation has to be an interface — a type alias cannot merge with the DOM declaration.
  interface Window {
    iss9992TourOpens?: TourOpenRecord;
  }
}

/** Appearances of the tour since the observer was armed, and the first one. */
type TourOpenRecord = { opens: number; firstOpenMs: number | null };

/**
 * Count every appearance of the tour from now on, page-side.
 *
 * Added nodes are inspected as well as current presence: a callout mounted and
 * unmounted inside a single observer batch never shows up in a presence check,
 * and a transient open is exactly the case this exists to catch.
 */
async function observeTourOpens(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const record: TourOpenRecord = { firstOpenMs: null, opens: 0 };
    window.iss9992TourOpens = record;
    const start = performance.now();
    const note = () => {
      record.opens += 1;
      record.firstOpenMs ??= Math.round(performance.now() - start);
    };
    let present = document.querySelector(selector) !== null;
    if (present) {
      note();
    }
    const observer = new MutationObserver((entries) => {
      const added = entries.some((entry) =>
        Array.from(entry.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(selector) || node.querySelector(selector) !== null)
        )
      );
      if (added) {
        note();
        present = true;
        return;
      }
      const now = document.querySelector(selector) !== null;
      if (now && !present) {
        note();
      }
      present = now;
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }, TOUR_OPEN_SELECTOR);
}

/** `null` when the observer is not installed, which is itself a failure. */
function readTourOpens(page: Page): Promise<TourOpenRecord | null> {
  return page.evaluate(() => window.iss9992TourOpens ?? null);
}
