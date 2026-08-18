/**
 * E2E regression (ISS-5112, PLN-1600 Step C): what the `guest-onboarding` Labs
 * flag does to the end of the first-launch tour, proven through the LAUNCHED
 * app.
 *
 * Two behaviors, both flag-gated, neither provable without booting Electron:
 *   1. The tour runs FIVE steps instead of six — the Recent Sessions spotlight
 *      is gone. Each spec walks the whole sequence and names the step it expects
 *      after every press, so a step appearing or disappearing fails here rather
 *      than silently changing what a new user is shown.
 *   2. Finishing it as a signed-out guest opens the account dialog, and the last
 *      step's button says so ("Create account", not "Done"). Every E2E profile
 *      is signed out, so the flag is the only variable between the two tests
 *      below.
 *
 * The renderer suites cover `buildTourSteps`, `AccountDialog`, and the page's
 * `closeTour` wiring in isolation; none of them proves the chain
 * `persisted Labs setting → getAllFlags IPC → DesktopFeatureFlagProvider →
 * FirstLaunchDashboard → Tour → dialog` carries the decision.
 *
 * Would fail before the change: the flag-on run would still reach the sessions
 * spotlight, and its last button would read "Done" over a press that opens a
 * dialog.
 *
 * The tour is REPLAYED from the header control rather than waited on: the
 * first-launch auto-arm depends on the reveal scan, the backfill settling, and
 * three insights queries resolving, and `closeTour` reads none of that — it
 * reads the flag and the auth state, which a replay exercises identically.
 * Seeding the two onboarding storage keys on a first launch keeps an auto-armed
 * tour from racing the replayed one.
 *
 * The flag key is pinned as a LITERAL: importing `src/shared/feature-flags` from
 * a spec aborts the whole Electron run under Playwright's Node loader (same note
 * as `guest-onboarding-gate.spec.ts`). Drift is caught by
 * `test/guest-onboarding-flag.test.ts`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const GUEST_ONBOARDING_FLAG_KEY = "guest-onboarding";
const DASHBOARD_HEADING = "Welcome to Closedloop";
const TOUR_INTRO_TITLE = "Build and see how your agents perform";
const STATS_STEP_TITLE = "The headline metrics";
const ACTIVITY_STEP_TITLE = "When the work happens";
const SESSIONS_STEP_TITLE = "Every session, drillable";
const MODELS_STEP_TITLE = "Which models did the work";
const PRS_STEP_TITLE = "Shipping velocity";
const ACCOUNT_DIALOG_TITLE = "Create your account";
/**
 * The dialog's accessible name once the flow mounts.
 *
 * It is `aria-labelledby` the flow's own visible heading, deliberately, so the
 * name tracks the step on screen instead of going stale as the flow advances to
 * Connect GitHub and sync consent. Which means the offer's locator STOPS
 * matching after the handoff — re-scope, do not query inside it.
 */
/** The dialog's own primary. The tour's last button keeps saying "Create account". */
const DIALOG_SIGN_UP_LABEL = "Sign Up";
/** What that same button renames itself to while the browser handoff is in flight. */
const DIALOG_SIGN_UP_PENDING_LABEL = "Opening browser…";
const HARNESSES_ROW_LABEL = "Harnesses found";
// ISS-5112: in guest mode the last press hands off to the account dialog, so
// the button names that. Flag off it stays the plain "Done" that just closes.
const GUEST_FINISH_LABEL = "Create account";
const DEFAULT_FINISH_LABEL = "Done";
const STEP_BUDGET_MS = 30_000;

test("ISS-5112: guest onboarding ON runs a five-step tour that ends in the account dialog", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedOnboardedProfile(
    "desktop-tour-account-on-",
    homes.env
  );
  const launched = await launchDesktopApp({
    userDataDir,
    env: homes.env,
    beforeLaunch: (dir) =>
      seedDesktopFeatureFlags(dir, { [GUEST_ONBOARDING_FLAG_KEY]: true }),
  });

  try {
    await openTour(launched.page);

    // Nothing was imported into this profile, so there is nothing to have found
    // — the row is omitted rather than headed over an empty space.
    await expect(
      launched.page
        .getByRole("dialog", { name: TOUR_INTRO_TITLE })
        .getByText(HARNESSES_ROW_LABEL)
    ).toHaveCount(0);

    await launched.page
      .getByRole("button", { name: "Take a quick tour" })
      .click();
    await expectStep(launched.page, STATS_STEP_TITLE);
    await advanceTo(launched.page, ACTIVITY_STEP_TITLE);
    // The Recent Sessions spotlight used to sit here. Advancing lands on Models.
    await advanceTo(launched.page, MODELS_STEP_TITLE);
    await expect(
      launched.page.getByRole("dialog", { name: SESSIONS_STEP_TITLE })
    ).toHaveCount(0);
    await advanceTo(launched.page, PRS_STEP_TITLE);
    // Scoped to the tour callout. The dashboard title row carries a standing
    // "Create account" of its own (PLN-1600 Step D), so a page-wide locator
    // matches two buttons here. Unlike the organization gate — which keeps the
    // header deliberately LIVE, so a duplicate there was genuinely clickable
    // and led somewhere else — the tour dims and covers the page behind it, so
    // the standing offer stays mounted and this names the one being tested.
    const finalStep = launched.page.getByRole("dialog", {
      name: PRS_STEP_TITLE,
    });
    // The button says what it does: "Done" would describe closing the tour,
    // which is not what this press produces.
    await expect(
      finalStep.getByRole("button", { name: DEFAULT_FINISH_LABEL })
    ).toHaveCount(0);
    await finalStep.getByRole("button", { name: GUEST_FINISH_LABEL }).click();

    const accountDialog = launched.page.getByRole("dialog", {
      name: ACCOUNT_DIALOG_TITLE,
    });
    await expect(accountDialog).toBeVisible({ timeout: STEP_BUDGET_MS });
    // The dialog's three controls, per the prototype: the primary, the decline,
    // and the returning-user door. ISS-5489 removed the in-dialog provider step,
    // so "Sign Up" now hands off to the system browser rather than opening a
    // second dialog.
    await expect(
      accountDialog.getByRole("button", { name: DIALOG_SIGN_UP_LABEL })
    ).toBeVisible();
    await expect(
      accountDialog.getByRole("button", { name: "Not now" })
    ).toBeVisible();
    await expect(
      accountDialog.getByRole("button", { name: "Sign in" })
    ).toBeVisible();

    // Press it. Asserting the button merely EXISTS would stay green if the
    // handoff broke — this step proves the dialog actually starts a sign-in
    // rather than dead-ending on its own offer.
    //
    // How far the loopback run gets in the harness is not ours to pin, and BOTH
    // ends of it are proof the press ran: the button goes busy while the system
    // browser opens, or the run fails and the dialog reports it. The idle offer
    // shows neither. Asserting `toBeDisabled` on the "Sign Up" locator alone
    // could never pass: going busy RENAMES the button, so that locator stops
    // matching at the exact moment the state it waits for arrives.
    await accountDialog
      .getByRole("button", { name: DIALOG_SIGN_UP_LABEL })
      .click();
    await expect(
      accountDialog
        .getByRole("button", { name: DIALOG_SIGN_UP_PENDING_LABEL })
        .or(accountDialog.getByRole("alert"))
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // A guest is never trapped: Escape leaves whatever the handoff did, and on
    // the in-flight branch it also cancels the single-flight sign-in run.
    await launched.page.keyboard.press("Escape");
    await expect(accountDialog).toHaveCount(0, { timeout: STEP_BUDGET_MS });
    // And declining leaves the dashboard they were just shown, which is the
    // point of guest mode.
    await expect(
      launched.page.getByRole("heading", { name: DASHBOARD_HEADING })
    ).toBeVisible();
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

test("ISS-5112: with the flag OFF the tour keeps its six steps and ends silently", async () => {
  test.setTimeout(240_000);

  // No flag seed at all — this profile receives the shipped product default,
  // which is what makes this an assertion about the default rather than about an
  // explicitly-written `false`.
  const homes = createHarnessHomes();
  const userDataDir = await seedOnboardedProfile(
    "desktop-tour-account-off-",
    homes.env
  );
  const launched = await launchDesktopApp({ userDataDir, env: homes.env });

  try {
    // Flag off means the signed-out device still meets the blocking overlay, and
    // it would swallow the clicks below.
    await gotoNav(launched.page, "dashboard");
    await dismissDesktopOnboardingOverlay(launched.page);
    await openTour(launched.page);

    await launched.page
      .getByRole("button", { name: "Take a quick tour" })
      .click();
    await expectStep(launched.page, STATS_STEP_TITLE);
    await advanceTo(launched.page, ACTIVITY_STEP_TITLE);
    await advanceTo(launched.page, SESSIONS_STEP_TITLE);
    await advanceTo(launched.page, MODELS_STEP_TITLE);
    await advanceTo(launched.page, PRS_STEP_TITLE);
    await launched.page
      .getByRole("button", { name: DEFAULT_FINISH_LABEL })
      .click();

    await expect(
      launched.page.getByRole("dialog", { name: ACCOUNT_DIALOG_TITLE })
    ).toHaveCount(0, { timeout: STEP_BUDGET_MS });
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * Isolated harness homes so the operator's (or the runner's) real Claude/Codex
 * transcripts are never imported — the intro summary's harness row is asserted
 * ABSENT above, and one stray real session would make that a false failure.
 */
function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tour-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tour-codex-")
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

/**
 * Boot once to create the profile, mark the first-launch reveal and the tour as
 * already seen, and shut down. The relaunch then renders the dashboard without
 * an auto-armed tour competing with the replayed one.
 */
async function seedOnboardedProfile(
  prefix: string,
  env: Record<string, string>
): Promise<string> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const first = await launchDesktopApp({
    userDataDir,
    keepUserDataDir: true,
    env,
  });
  try {
    await gotoNav(first.page, "dashboard");
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
  return userDataDir;
}

/** Open the Dashboard and replay the tour from its header control. */
async function openTour(page: Page): Promise<void> {
  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", { name: DASHBOARD_HEADING })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
  await page.getByRole("button", { name: "Tour" }).click();
  await expectStep(page, TOUR_INTRO_TITLE);
}

/** The tour callout exposes each step as a dialog named by its title. */
async function expectStep(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("dialog", { name: title })).toBeVisible({
    timeout: STEP_BUDGET_MS,
  });
}

/**
 * Press "Next" and wait for the step it should land on. Naming the destination
 * (rather than counting presses) is what makes the dropped spotlight visible in
 * the diff of this file.
 */
async function advanceTo(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Next" }).click();
  await expectStep(page, title);
}
