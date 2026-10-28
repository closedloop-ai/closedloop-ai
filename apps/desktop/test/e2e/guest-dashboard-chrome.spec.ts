/**
 * E2E regression (ISS-5112, PLN-1600 Step D; ISS-10929/ISS-10942): the guest
 * chrome, proven through the LAUNCHED app.
 *
 * Step D added surfaces the renderer suites can only mount in isolation: the
 * guest sidebar footer and the standing account offer. What no render test can
 * prove is that a real signed-out profile gets them at once, in the running app.
 *
 * The review finding (cr-44060) guarded here: Settings and Diagnostics have NO
 * other link site in the renderer and no Electron app-menu entry. A guest branch
 * that replaced the footer dropdown with a bare button stranded a signed-out
 * user with no route to either. This drives the menu open and follows Settings
 * through to the rendered page.
 *
 * ISS-10942 MOVED the standing offer off the dashboard title row and into the
 * sidebar's Getting started module, so the offer is asserted THROUGH that
 * module on the dashboard. The Settings leg no longer says anything about the
 * offer at all: Settings is a modal dialog, so ARIA cannot see the sidebar
 * while it is open, and the absence the old leg asserted was the modal's doing
 * rather than the offer's placement. ISS-10929 retired the Organization scope
 * toggle and the gate behind it, so the second case here, which drove that
 * toggle, is gone with the contract it covered.
 *
 * Would fail before the change: the footer would expose no menu at all, so
 * Settings would be unreachable.
 *
 * The tour is suppressed by seeding both onboarding storage keys — an auto-armed
 * tour renders a modal callout that would swallow the clicks below.
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
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu.ts";
import { GETTING_STARTED_CARD_LABEL } from "@repo/app/onboarding/components/getting-started-card-shell.tsx";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

const ACCOUNT_MENU_TRIGGER = "Open account menu";
const SIGN_UP_BUTTON =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount];
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
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // ISS-10942: the offer is the Getting started module's pending step, so it
    // is located THROUGH that module rather than anywhere on the page — a bare
    // page-wide button match would pass against a stray reinstated control.
    const gettingStarted = launched.page.getByRole("region", {
      name: GETTING_STARTED_CARD_LABEL,
    });
    await expect(
      gettingStarted.getByRole("button", { name: SIGN_UP_BUTTON })
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

    // The offer is NOT asserted here any more, in either direction, and that is
    // the honest outcome rather than a dropped case.
    //
    // ISS-10942 moved the offer off the dashboard title row and into the
    // sidebar's Getting started module, which retires the contract this leg
    // used to state ("it belongs on the dashboard title row, so it must not
    // appear on Settings"). But the replacement assertion cannot be written
    // either: desktop Settings is a Radix `Dialog` (`settings-shell` is a
    // `DialogContent`), so while it is open Radix marks the rest of the app
    // `aria-hidden` and NO ARIA query can see the sidebar — present or absent.
    // The old `toHaveCount(0)` was passing for that reason and not for the one
    // its comment gave, so restoring it would re-state a claim it never proved.
    // The offer's real contract is asserted on the dashboard above, where the
    // module is actually reachable.
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
