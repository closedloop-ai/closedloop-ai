/**
 * E2E regression (ISS-5112, PLN-1600 Step F): the first-run landing, proven
 * through the LAUNCHED app.
 *
 * The renderer suites mount the gate with mocked auth, mocked navigation and a
 * stubbed `localStorage`. None of that proves the chain that actually decides
 * what a new user sees: `persisted Labs setting → getAllFlags IPC →
 * DesktopFeatureFlagProvider → GuestLandingGate`, over a REAL localStorage that
 * survives an app restart, with the real navigation store behind Get Started.
 *
 * Three things are asserted that nothing else covers:
 *
 *   1. The landing replaces the shell. Not "is visible over it" — the sidebar
 *      and topbar must be GONE, because an overlay would leave the dashboard
 *      mounted behind it and `useTourArming` would spend the one-shot guided
 *      tour on a screen nobody is looking at.
 *   2. Get Started lands on the DASHBOARD, not on `DEFAULT_NAV_ID` (Sessions).
 *      This is the whole reason Step F is load-bearing: without the forced
 *      route, the tour Step C built is unreachable on a real first launch.
 *   3. It is once, ever — across a real relaunch of the same profile. A
 *      same-session assertion would pass on component state alone and prove
 *      nothing about the storage key.
 *
 * Would fail before the change: the landing does not exist, so (1) finds no
 * headline.
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
  enterFromGuestLanding,
  GUEST_LANDING_CTA,
  GUEST_LANDING_HEADING,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

// Pinned as a LITERAL: importing `src/shared/feature-flags` from a spec aborts
// the whole Electron run under Playwright's Node loader (same note as
// `guest-onboarding-gate.spec.ts`). `test/guest-onboarding-flag.test.ts` asserts
// the registry defines this key, so drift is caught there.
const GUEST_ONBOARDING_FLAG_KEY = "guest-onboarding";
const DASHBOARD_HEADING = "Welcome to Closedloop";
const SIDEBAR_TOGGLE_LABELS = /^(Expand|Collapse) sidebar$/;
const STEP_BUDGET_MS = 30_000;
// The flag-OFF and post-answer branches assert the landing NEVER arrives, which
// needs a wait that must TIME OUT. Playwright's auto-retrying assertions settle
// on the first successful poll, so `toBeHidden()` immediately after launch
// resolves while the renderer is still mounting — a state in which nothing is
// visible and every flag value passes. Both e2e specs on this plan already
// shipped with a defect of exactly that shape.
const LANDING_NEVER_ARRIVES_MS = 15_000;

test("ISS-5112: a first launch with guest onboarding ON opens on the landing, not the app", async () => {
  test.setTimeout(180_000);

  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-guest-landing-on-e2e-",
    beforeLaunch: (userDataDir) =>
      seedDesktopFeatureFlags(userDataDir, {
        [GUEST_ONBOARDING_FLAG_KEY]: true,
      }),
  });

  try {
    await expect(
      launched.page.getByRole("heading", { name: GUEST_LANDING_HEADING })
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // REPLACES the shell. The sidebar trigger lives in the Topbar and renders on
    // every route, so its absence is the cheapest proof the shell is not mounted
    // underneath. An overlay implementation would leave it in the tree.
    await expect(
      launched.page.getByRole("button", { name: SIDEBAR_TOGGLE_LABELS })
    ).toHaveCount(0);

    // Both actions are real and different — Get Started enters with NO account,
    // Sign in authenticates. The sign-in path is asserted because the funnel's
    // other surfaces deliberately dropped theirs, which reads like a reason to
    // drop this one too.
    await expect(
      launched.page.getByRole("button", { name: GUEST_LANDING_CTA })
    ).toBeVisible();
    await expect(
      launched.page.getByRole("button", { name: "Sign in" })
    ).toBeVisible();
  } finally {
    await launched.cleanup();
  }
});

test("ISS-5112: Get Started lands on the Dashboard and the landing never returns", async () => {
  test.setTimeout(240_000);

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-guest-landing-once-e2e-")
  );
  const seedFlag = (dir: string) =>
    seedDesktopFeatureFlags(dir, { [GUEST_ONBOARDING_FLAG_KEY]: true });

  try {
    const first = await launchDesktopApp({
      userDataDir,
      keepUserDataDir: true,
      beforeLaunch: seedFlag,
    });
    try {
      await enterFromGuestLanding(first.page, STEP_BUDGET_MS);

      // The forced route. `DEFAULT_NAV_ID` is Sessions, so a Dashboard heading
      // here can only come from Get Started having navigated — and this is the
      // only thing that makes the guest tour reachable on a real first launch.
      await expect(
        first.page.getByRole("heading", { name: DASHBOARD_HEADING })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expectShellMounted(first.page);
    } finally {
      await first.cleanup();
    }

    // A REAL relaunch of the same profile. Same-session state would prove
    // nothing about the storage key that has to survive a restart.
    const second = await launchDesktopApp({
      userDataDir,
      keepUserDataDir: true,
      beforeLaunch: seedFlag,
    });
    try {
      await expectLandingNeverArrives(second.page);
      // And the forced route was genuinely one-time: this launch resolves to
      // DEFAULT_NAV_ID like every other.
      await expectShellMounted(second.page);
    } finally {
      await second.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("ISS-5112: with the flag OFF a first launch never sees the landing", async () => {
  test.setTimeout(180_000);

  // No flag seed at all — this profile receives the shipped product default,
  // which is what makes this an assertion about the default rather than about an
  // explicitly-written `false`. Without it, a gate that always took over would
  // pass a flag-on-only spec.
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-guest-landing-off-e2e-",
  });

  try {
    await expectLandingNeverArrives(launched.page);
    await gotoNav(launched.page, "dashboard");
    await expectShellMounted(launched.page);
  } finally {
    await launched.cleanup();
  }
});

/** The app shell is mounted: its sidebar trigger renders on every route. */
async function expectShellMounted(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: SIDEBAR_TOGGLE_LABELS })
  ).toBeVisible({ timeout: STEP_BUDGET_MS });
}

/**
 * The landing must never attach during this window. A bounded wait that has to
 * REJECT, not a `toBeHidden()` that resolves against a still-mounting renderer.
 */
async function expectLandingNeverArrives(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("button", { name: GUEST_LANDING_CTA })
      .waitFor({ state: "attached", timeout: LANDING_NEVER_ARRIVES_MS })
  ).rejects.toThrow();
}
