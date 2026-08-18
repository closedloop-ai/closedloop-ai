/**
 * E2E regression (ISS-5112, PLN-1600 Step D): the guest chrome and the
 * Organization-scope gate, proven through the LAUNCHED app.
 *
 * Step D adds three surfaces the renderer suites can only mount in isolation:
 * the always-present Topbar sign-up button, the guest sidebar footer, and the
 * Organization gate over the dashboard body. What no render test can prove is
 * that the chain `persisted Labs setting → getAllFlags IPC →
 * DesktopFeatureFlagProvider → Sidebar/Topbar/FirstLaunchDashboard` actually
 * carries the decision to all three at once, on a real signed-out profile.
 *
 * Two review findings (cr-44060) are guarded here specifically:
 *
 *   1. Settings and Diagnostics have NO other link site in the renderer and no
 *      Electron app-menu entry, and Settings hosts the Labs tab that owns this
 *      very flag. A guest branch that replaced the footer dropdown with a bare
 *      button stranded a signed-out user with no route to either — and no way
 *      to switch the flag back off. This drives the menu open and follows
 *      Settings through to the rendered page, and asserts the standing sign-up
 *      offer stays OFF that screen (it belongs on the dashboard title row).
 *
 *   2. The gate is a section, not a modal, so the header scope toggle stays live
 *      underneath it. Selecting "Me" there is a real second exit beside the
 *      card's own button, and it used to change the underlying scope while
 *      leaving the toggle displaying "Organization" over a gate that never
 *      lifted.
 *
 * Would fail before the change: (1) the footer would expose no menu at all, so
 * Settings would be unreachable; (2) the gate card would still be on screen
 * after selecting "Me".
 *
 * The tour is suppressed by seeding both onboarding storage keys — an auto-armed
 * tour renders a modal callout that would swallow the clicks below.
 *
 * The flag key is pinned as a LITERAL: importing `src/shared/feature-flags` from
 * a spec aborts the whole Electron run under Playwright's Node loader (same note
 * as `tour-account-dialog.spec.ts`). Drift is caught by
 * `test/guest-onboarding-flag.test.ts`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const GUEST_ONBOARDING_FLAG_KEY = "guest-onboarding";
const DASHBOARD_HEADING = "Welcome to Closedloop";
const ACCOUNT_MENU_TRIGGER = "Open account menu";
const GATE_HEADING = "Organization scope needs an account";
const SIGN_UP_BUTTON = "Create account";
const STEP_BUDGET_MS = 30_000;

test("ISS-5112: a guest keeps Settings and Diagnostics reachable from the footer menu", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedOnboardedProfile(
    "desktop-guest-chrome-nav-",
    homes.env
  );
  const launched = await launchDesktopApp({
    userDataDir,
    env: homes.env,
    beforeLaunch: (dir) =>
      seedDesktopFeatureFlags(dir, { [GUEST_ONBOARDING_FLAG_KEY]: true }),
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", { name: DASHBOARD_HEADING })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // Present HERE first. Without this the absence asserted on Settings below
    // would pass against an offer that renders nowhere at all.
    await expect(
      launched.page.getByRole("button", { name: SIGN_UP_BUTTON })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // The footer names what this device actually is. Asserting the positive
    // ("Guest") rather than the absence of an org name is what makes this fail
    // if the trigger regresses to the signed-in label or its "Account" fallback.
    const trigger = launched.page.getByRole("button", {
      name: ACCOUNT_MENU_TRIGGER,
    });
    await expect(trigger).toContainText("Guest", { timeout: STEP_BUDGET_MS });

    await trigger.click();
    const menu = launched.page.getByRole("menu");
    // "Create account", not "Sign In": desktop auth is one loopback OAuth door,
    // so a second name promises a path that does not exist, and this item opens
    // a dialog headed "Create your account".
    await expect(
      menu.getByRole("menuitem", { name: SIGN_UP_BUTTON })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(
      menu.getByRole("menuitem", { name: "Diagnostics" })
    ).toBeVisible();

    // Follow Settings all the way to the rendered page. Asserting the menu item
    // merely EXISTS would stay green if the link were wired to a dead route,
    // and Settings is the page that owns the Labs toggle for this flag.
    await menu.getByRole("menuitem", { name: "Settings" }).click();
    await expect(
      launched.page.getByRole("heading", { name: "Settings" })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // And the offer does NOT follow them here. It lives on the dashboard title
    // row, the one screen whose content an account changes; a filled primary in
    // the window chrome would be the loudest element on Settings, where signing
    // up changes nothing about what is on the page.
    await expect(
      launched.page.getByRole("button", { name: SIGN_UP_BUTTON })
    ).toHaveCount(0);
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

test("ISS-5112: the Organization gate lifts when the guest backs out through the toggle", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedOnboardedProfile(
    "desktop-guest-chrome-scope-",
    homes.env
  );
  const launched = await launchDesktopApp({
    userDataDir,
    env: homes.env,
    beforeLaunch: (dir) =>
      seedDesktopFeatureFlags(dir, { [GUEST_ONBOARDING_FLAG_KEY]: true }),
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", { name: DASHBOARD_HEADING })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // Scoped to the toggle's own container rather than matching "Me" /
    // "Organization" page-wide: the gate card that this test puts on screen
    // also says "Organization", so a bare text locator would go ambiguous
    // exactly when the second half of the test runs.
    const scopeToggle = launched.page
      .getByText("Scope", { exact: true })
      .locator("..");

    // Signed out, the source advertises only personal scope, so this toggle
    // would not render at all without guest mode — which is the whole reason a
    // guest never discovered that an account buys anything on this page.
    const orgOption = scopeToggle.getByText("Organization", { exact: true });
    await expect(orgOption).toBeVisible({ timeout: STEP_BUDGET_MS });
    await orgOption.click();

    const gate = launched.page.getByRole("heading", { name: GATE_HEADING });
    await expect(gate).toBeVisible({ timeout: STEP_BUDGET_MS });

    // Exactly ONE ask for this request. Raising the gate used to fire the
    // signup request in the same tick, stacking the account dialog over this
    // card with the card's own primary dead behind it.
    await expect(launched.page.getByRole("dialog")).toHaveCount(0);
    await expect(
      launched.page.getByRole("button", { name: SIGN_UP_BUTTON })
    ).toHaveCount(1);

    // Back out through the header toggle rather than the card's own button.
    // Both are real exits; only the card's was ever wired to clear the gate.
    await scopeToggle.getByText("Me", { exact: true }).click();

    await expect(gate).toBeHidden({ timeout: STEP_BUDGET_MS });
    // BOTH halves of the state, not just the visible one. Backing out through
    // the toggle used to clear `scope` without clearing `orgGated`, which left
    // the control displaying Organization over personal-scope state. The
    // selected option is the assertion that catches that; the gate going away
    // above is only half of it.
    //
    // (The PageShell title is NOT the assertion to make here — it renders
    // outside the gated region, so it is on screen the whole time and would
    // pass either way.)
    await expect(scopeToggle.getByText("Me", { exact: true })).toHaveAttribute(
      "data-state",
      "on",
      { timeout: STEP_BUDGET_MS }
    );
  } finally {
    await launched.cleanup();
    removeDirs([userDataDir, ...homes.dirs]);
  }
});

/**
 * Isolated harness homes so the operator's (or the runner's) real Claude/Codex
 * transcripts are never imported into the profile under test.
 */
function createHarnessHomes(): {
  env: Record<string, string>;
  dirs: string[];
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-chrome-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-chrome-codex-")
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
 * already seen, and shut down. The relaunch then renders the dashboard with no
 * auto-armed tour throwing a modal callout over the controls under test.
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
