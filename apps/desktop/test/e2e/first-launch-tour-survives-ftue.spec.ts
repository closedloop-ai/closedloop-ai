/**
 * ISS-11204: a first-launch tour stays closed behind onboarding, then opens
 * when the guest exits the modal. Seeded sessions give it real anchors, and a
 * route remount proves the covered run has not spent the first-launch latch.
 *
 * ISS-11751 rides the same walk: the sidebar's Getting started module must not
 * stand under that takeover, and must come back when it closes. The merged fix
 * shipped with a renderer fixture that hands the gate its answer directly
 * (`getting-started-modal-exclusion.test.tsx`); this is the launched-app half
 * `apps/desktop/AGENTS.md` asks of a UI bug fix, where the real dialog host is
 * what writes the store.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu.ts";
import { GETTING_STARTED_CARD_LABEL } from "@repo/app/onboarding/components/getting-started-card-shell.tsx";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  activeNavPanel,
  gotoNav,
  gotoNavSettled,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const CONTINUE_BUTTON = "Continue";
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
/** The Account step, and the guest's own way off it. */
const ACCOUNT_EYEBROW = "Create your account";
const SKIP_ACCOUNT_BUTTON = "Skip for now";
/**
 * The blocker `Tour` lays behind every step — the handle for "a run is open",
 * addressed this way rather than by a step title for the reason
 * `first-launch-tour-empty-dashboard.spec.ts` gives: a title literal stops
 * matching the moment the run's first beat is reworded, which turns these
 * assertions green while the tour is not there.
 */
const TOUR_BLOCKER_SELECTOR = 'button[aria-label="Skip tour"]';
/**
 * The accessible name the tour's skip affordance carries, used for the
 * accessibility-tree half of the reachability assertions below.
 *
 * `Tour` renders TWO controls under this name — the full-bleed blocker, which
 * carries it as an `aria-label`, and the visible labelled button — so a role
 * query is ambiguous by design and is only ever counted here, never resolved to
 * one element. Visibility is addressed through {@link TOUR_BLOCKER_SELECTOR},
 * which is unique.
 */
const SKIP_TOUR_NAME = "Skip tour";
/** The `[data-tour]` row anchors: the page drew a body with something to ring. */
const ROW_ANCHORS = "[data-tour]";
const STEP_BUDGET_MS = 30_000;
/**
 * Budget for the cold import to produce the first usable dashboard rows.
 */
const ARM_BUDGET_MS = 90_000;
/**
 * Enough transcripts for a dashboard with rows, and few enough that the import
 * has settled by the time the walk reaches the step this spec holds it on —
 * `content` must read `Ready` or the arm declines on content and proves nothing
 * about the cover.
 */
const SEEDED_SESSIONS = Array.from({ length: 12 }, (_, index) => ({
  sessionId: `iss-10570-${index}`,
  slug: `iss-10570-${index}`,
}));

test("ISS-11204: the tour starts only after the FTUE takeover closes", async () => {
  test.setTimeout(360_000);

  const homes = createHarnessHomes();
  seedClaudeTranscripts(homes.env.CLAUDE_HOME, SEEDED_SESSIONS);
  const userDataDir = await seedFirstRunGuestProfile(homes.env);
  const launched = await launchDesktopApp({
    env: homes.env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });

  try {
    await gotoNavSettled(launched.page, "dashboard", STEP_BUDGET_MS);

    // Walk to the step the takeover parks on while the analyzer works, and
    // stay there. Everything below happens with the modal genuinely up.
    await launched.page
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click({ timeout: STEP_BUDGET_MS });
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // The dashboard behind it drew a real body — the arm's content gate is
    // open, so a silent arm below would be about the cover and nothing else.
    const dashboard = activeNavPanel(launched.page, "dashboard");
    await expect
      .poll(() => dashboard.locator(ROW_ANCHORS).count(), {
        message: "the dashboard behind the takeover drew its row anchors",
        timeout: ARM_BUDGET_MS,
      })
      .toBeGreaterThan(0);

    // The spotlight must not exist while onboarding still owns the screen.
    await expect(launched.page.locator(TOUR_BLOCKER_SELECTOR)).toHaveCount(0);
    await expect(
      launched.page.getByRole("button", { name: SKIP_TOUR_NAME })
    ).toHaveCount(0);

    // ISS-11751, and FIRST the reason every query below carries
    // `includeHidden`. The takeover is a modal Radix dialog, so the shell it
    // covers is marked `aria-hidden` wholesale: a default (visible-only) role
    // query reports EVERY sidebar node absent whether this gate fired or not,
    // which would make the absence assertion that follows pass with the fix
    // reverted. The account trigger is the control that proves it — a sibling
    // of the Getting started module, in the same hidden footer, which the
    // takeover must NOT remove.
    const accountTrigger = launched.page.getByRole("button", {
      name: WORKSPACE_MENU_TRIGGER_LABEL,
    });
    await expect(accountTrigger).toHaveCount(0);
    await expect(
      launched.page.getByRole("button", {
        includeHidden: true,
        name: WORKSPACE_MENU_TRIGGER_LABEL,
      })
    ).toHaveCount(1);

    // THE SUPPRESSION. Counted with `includeHidden` so a still-rendered module
    // under the dialog's `aria-hidden` is a FAILURE here rather than a pass.
    await expect(gettingStartedRegion(launched.page)).toHaveCount(0);

    // THE WIRING. The shot is unspent while the run is covered — this is the
    // assertion that fails the moment `blockingModalOpen` stops reaching the
    // arm, and it is durable in a way the open tour above is not.
    expect(await readOnboardedLatch(launched.page)).toBeNull();
    await launched.page.screenshot({
      path: test.info().outputPath("onboarding-no-tour.png"),
    });

    // The route change the walkthrough itself performs. `tourActive` is
    // component state and does not survive it; only the latch does.
    await gotoNavSettled(launched.page, "sessions", STEP_BUDGET_MS);
    await gotoNavSettled(launched.page, "dashboard", STEP_BUDGET_MS);
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    expect(await readOnboardedLatch(launched.page)).toBeNull();

    // Exit the takeover through the real host: Continue off discovery, then the
    // guest's own way past the account step. `SkipAccount` moves the run to
    // `DashboardAvailable`, which `isBlockingPhase` excludes — so the dialog
    // closes because the machine moved, not because anything dismissed it.
    await launched.page
      .getByRole("button", { name: CONTINUE_BUTTON })
      .click({ timeout: STEP_BUDGET_MS });
    await expect(launched.page.getByText(ACCOUNT_EYEBROW)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    await launched.page
      .getByRole("button", { name: SKIP_ACCOUNT_BUTTON })
      .click({ timeout: STEP_BUDGET_MS });
    await expect(launched.page.getByText(ACCOUNT_EYEBROW)).toBeHidden({
      timeout: STEP_BUDGET_MS,
    });

    // ISS-11751's release, on this same fixture. A takeover covers the module;
    // it does not retire it — and without this the suppression above is also
    // what a screen that rendered nothing at all would look like.
    await expect(gettingStartedRegion(launched.page)).toHaveCount(1, {
      timeout: STEP_BUDGET_MS,
    });
    await expect(
      launched.page.getByRole("region", { name: GETTING_STARTED_CARD_LABEL })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // THE PAYOFF. The reader gets the tour they were owed: live, in the
    // accessibility tree, and actually on screen.
    await expect(launched.page.locator(TOUR_BLOCKER_SELECTOR)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });
    // ...and back in the accessibility tree, which is the half the covered
    // assertion above measured as zero.
    await expect
      .poll(
        () =>
          launched.page.getByRole("button", { name: SKIP_TOUR_NAME }).count(),
        {
          message: "the tour's skip control is announceable once uncovered",
          timeout: STEP_BUDGET_MS,
        }
      )
      .toBeGreaterThan(0);
    // ...and only NOW is the shot spent.
    await expect
      .poll(() => readOnboardedLatch(launched.page), {
        message: "the arm writes the first-launch latch once the cover is gone",
        timeout: ARM_BUDGET_MS,
      })
      .toBe("1");
    await launched.page.screenshot({
      path: test.info().outputPath("tour-after-onboarding.png"),
    });
    expect(launched.pageErrors).toEqual([]);
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

/**
 * A profile that is a genuine first run with the tour still OWED.
 *
 * Neither the first-launch latch nor the tour-seen key may be present: the
 * guided run arms only on a first run and reads the former, and the arm reads
 * the latter for its standing. The guest run record is cleared so the walk
 * starts at Welcome.
 */
async function seedFirstRunGuestProfile(
  env: Record<string, string>
): Promise<string> {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss10570-tour-ftue-")
  );
  const first = await launchDesktopApp({
    env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await gotoNav(first.page, "dashboard");
    await first.page.evaluate(
      ([tourSeenKey, guestRunKey, onboardedKey]) => {
        localStorage.removeItem(tourSeenKey);
        localStorage.removeItem(onboardedKey);
        localStorage.removeItem(guestRunKey);
      },
      [
        dashboardTourSeenStorageKey,
        desktopGuestGuidedOnboardingStorageKey,
        dashboardOnboardedStorageKey,
      ]
    );
  } finally {
    await first.cleanup();
  }
  return userDataDir;
}

function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss10570-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss10570-codex-")
  );
  return {
    dirs: [claudeHome, codexHome],
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
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

/**
 * The sidebar's Getting started module, counted whether or not the takeover's
 * `aria-hidden` has taken it out of the accessibility tree.
 *
 * `includeHidden` is the whole point: without it an absence assertion under the
 * modal is satisfied by the dialog hiding the shell, so it holds with or without
 * the ISS-11751 gate.
 */
function gettingStartedRegion(page: Page): Locator {
  return page.getByRole("region", {
    includeHidden: true,
    name: GETTING_STARTED_CARD_LABEL,
  });
}
