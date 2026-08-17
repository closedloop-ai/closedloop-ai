/**
 * E2E regression (ISS-5112): the `guest-onboarding` Labs flag decides whether a
 * signed-out device meets the blocking first-launch auth overlay or reaches the
 * Dashboard as a guest — proven through the LAUNCHED app.
 *
 * The renderer suites cover `shouldShowOnboardingOverlay` and the mounted
 * component in isolation, but neither boots Electron, so neither proves the
 * chain `persisted Labs setting → getAllFlags IPC → DesktopFeatureFlagProvider →
 * DashboardPage` actually carries the decision. This spec closes that gap (the
 * launched-app coverage `apps/desktop/AGENTS.md` requires for a behavior change
 * on a renderer surface).
 *
 * Would fail before the change: the overlay mounted for every signed-out
 * device, so the flag-on case would still find the dialog.
 *
 * BOTH branches are asserted. The flag-off case is not redundant — it is the
 * product default that every existing user gets, and a gate that accidentally
 * always suppressed the overlay would pass a flag-on-only spec. No existing
 * spec covers it: the ones that dismiss the overlay use a helper that no-ops
 * when it is absent, so they stay green either way.
 *
 * Flag key and the overlay's accessible name are pinned as LITERALS: importing
 * `src/shared/feature-flags` from a spec aborts the whole Electron run under
 * Playwright's Node loader (same note as `collapsible-import-splash.spec.ts`).
 * Drift is caught by `test/guest-onboarding-flag.test.ts`, which asserts the
 * registry defines this key, and by `ONBOARDING_OVERLAY_LABEL` below, which the
 * shared helper owns.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, test } from "@playwright/test";
import {
  enterFromGuestLanding,
  gotoNav,
  launchDesktopApp,
  ONBOARDING_OVERLAY_LABEL,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";

const GUEST_ONBOARDING_FLAG_KEY = "guest-onboarding";
const DASHBOARD_HEADING = "Welcome to Closedloop";
// The flag-OFF branch is where the overlay must APPEAR, so a plain visibility
// wait carries it.
const OVERLAY_BUDGET_MS = 30_000;
// The flag-ON branch asserts the overlay never arrives, which needs a different
// shape. Playwright's auto-retrying assertions stop at the FIRST poll that
// succeeds, so `toHaveCount(0)` immediately after the Dashboard heading paints
// resolves at once — while the auth pull is still `loading`, a state in which
// `shouldShowOnboardingOverlay` returns false for EVERY flag value. Such an
// assertion stays green whether or not the gate works, which is the whole point
// of the spec. A bounded wait that must TIME OUT spends the entire window
// instead, so an overlay mounting once auth settles to `signed_out` fails.
const OVERLAY_NEVER_ARRIVES_MS = 15_000;

test("ISS-5112: guest onboarding ON lets a signed-out device reach the Dashboard unblocked", async () => {
  test.setTimeout(180_000);

  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-guest-onboarding-on-e2e-",
    beforeLaunch: (userDataDir) =>
      seedDesktopFeatureFlags(userDataDir, {
        [GUEST_ONBOARDING_FLAG_KEY]: true,
      }),
  });

  try {
    // Step F: with the flag on, a profile that has never completed a first
    // launch opens on the landing takeover instead of the shell, so the app is
    // only reachable through it. Strict on purpose — if the landing regressed,
    // this fails here rather than silently proceeding to assert against a screen
    // that never mounted. The flag-OFF test below needs no equivalent: the
    // landing is gated on the same flag.
    await enterFromGuestLanding(launched.page, OVERLAY_BUDGET_MS);
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("heading", { name: DASHBOARD_HEADING })
    ).toBeVisible({ timeout: OVERLAY_BUDGET_MS });

    // The gate is the subject: no blocking dialog, ever, on this profile. The
    // wait must REJECT — resolving means the overlay attached.
    await expect(
      launched.page
        .getByRole("dialog", { name: ONBOARDING_OVERLAY_LABEL })
        .waitFor({ state: "attached", timeout: OVERLAY_NEVER_ARRIVES_MS })
    ).rejects.toThrow();
  } finally {
    await launched.cleanup();
  }
});

test("ISS-5112: with the flag OFF a signed-out device still meets the onboarding overlay", async () => {
  test.setTimeout(180_000);

  // No flag seed at all — this profile receives the shipped product default,
  // which is what makes this an assertion about the default rather than about
  // an explicitly-written `false`.
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-guest-onboarding-off-e2e-",
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(
      launched.page.getByRole("dialog", { name: ONBOARDING_OVERLAY_LABEL })
    ).toBeVisible({ timeout: OVERLAY_BUDGET_MS });
  } finally {
    await launched.cleanup();
  }
});
