/**
 * ISS-10885 regression: the guided onboarding action row occupies its own
 * space instead of painting over the step's content.
 *
 * The row used to be `absolute … bg-background` inside the scroll body, with a
 * fixed `pb` reserve that was only ever correct at the BOTTOM of the scroll
 * range. At every other scroll position it painted an opaque band of
 * `--background` across the dialog — on the sync-policy step, over the lower
 * half of the third privacy card, with no scrollbar contrast to say the content
 * was still there. The buttons stayed clickable throughout, so reachability
 * never caught it; occlusion is what broke.
 *
 * Would fail before the change: with the row out of flow, its box starts INSIDE
 * the scroll region's box, so `rowTop < scrollBottom`.
 *
 * A jsdom test cannot prove this one. `guided-onboarding-action-row-occlusion`
 * pins the class contract structurally, but jsdom resolves no Tailwind and
 * measures no pixels, so only a launched shell can compare the two boxes.
 *
 * The window is shrunk before the measurement and the overflow is ASSERTED: a
 * step whose content fits has no band to paint and would report a green that
 * means nothing.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence.ts";
import {
  createInitialOnboardingState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

/** The sync-policy step's eyebrow — the screen ISS-10885 was reported on. */
const SYNC_POLICY_EYEBROW = "Your data, your choice";
const CONTINUE_BUTTON = "Continue";
const STEP_BUDGET_MS = 30_000;
/**
 * Small enough that the sync step's three privacy cards cannot fit, which is
 * the state the old overlay was wrong in. The overflow is asserted rather than
 * assumed, so a future copy trim that makes the step fit fails this spec
 * loudly instead of passing it vacuously.
 */
const CONSTRAINED_CONTENT_SIZE = { height: 620, width: 900 };
/** The walk that reaches the sync step in the ISS-10890 order. */
const SYNC_STEP_RUN_HISTORY = [
  OnboardingPhase.Welcome,
  OnboardingPhase.SessionDiscovery,
  OnboardingPhase.Account,
  OnboardingPhase.CreateOrganization,
];
/** One device pixel of slack: box edges are fractional after layout rounding. */
const EDGE_TOLERANCE_PX = 1;

test("ISS-10885: the onboarding action row never overlaps the scroll region", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedGuestProfile(
    "desktop-onboarding-action-row-",
    homes.env
  );
  const launched = await launchDesktopApp({
    env: homes.env,
    keepFirstRunState: true,
    userDataDir,
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await expect(launched.page.getByText(SYNC_POLICY_EYEBROW)).toBeVisible({
      timeout: STEP_BUDGET_MS,
    });

    await launched.app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    }, CONSTRAINED_CONTENT_SIZE);

    // The action row is the Continue button's own parent, and the scroll region
    // is the sibling directly above it — the two halves of the step frame,
    // located through the rendered tree rather than through a class string the
    // renderer bundle would have to re-export to this spec.
    const geometry = await measureStepFrame(
      launched.page.getByRole("button", { name: CONTINUE_BUTTON })
    );

    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.scrollTop).toBe(0);
    expect(geometry.rowTop).toBeGreaterThanOrEqual(
      geometry.scrollBottom - EDGE_TOLERANCE_PX
    );
  } finally {
    await launched.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    removeDirs(homes.dirs);
  }
});

type StepFrameGeometry = {
  clientHeight: number;
  rowTop: number;
  scrollBottom: number;
  scrollHeight: number;
  scrollTop: number;
};

async function measureStepFrame(
  continueButton: Locator
): Promise<StepFrameGeometry> {
  return await continueButton.evaluate((button) => {
    const actionRow = button.parentElement;
    const scroll = actionRow?.previousElementSibling as HTMLElement | null;
    if (!(actionRow && scroll)) {
      throw new Error(
        "step rendered without an action row and a scroll region"
      );
    }
    scroll.scrollTop = 0;
    const rowBox = actionRow.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    return {
      clientHeight: scroll.clientHeight,
      rowTop: rowBox.top,
      scrollBottom: scrollBox.bottom,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
    };
  });
}

function createHarnessHomes(): {
  dirs: string[];
  env: Record<string, string>;
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-action-row-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-action-row-codex-")
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

/**
 * Boot once to create a signed-out profile with the tour already seen and the
 * guest run parked on the sync step, then shut down — the relaunch renders the
 * dashboard with no auto-armed tour competing for the screen and the takeover
 * restored on the step this spec measures. Seeded rather than walked: since
 * ISS-10890 the sync step follows the organization step, which a signed-out
 * harness cannot complete.
 */
async function seedGuestProfile(
  prefix: string,
  env: Record<string, string>
): Promise<string> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const first = await launchDesktopApp({
    env,
    keepFirstRunState: true,
    keepUserDataDir: true,
    userDataDir,
  });
  try {
    await gotoNav(first.page, "dashboard");
    await first.page.evaluate(
      ([tourSeenKey, guestRunKey, onboardedKey, guestRun]) => {
        localStorage.setItem(tourSeenKey, "1");
        localStorage.removeItem(onboardedKey);
        localStorage.setItem(guestRunKey, guestRun);
      },
      [
        dashboardTourSeenStorageKey,
        desktopGuestGuidedOnboardingStorageKey,
        dashboardOnboardedStorageKey,
        JSON.stringify({
          revision: SYNC_STEP_RUN_HISTORY.length,
          state: serializeOnboardingState({
            ...createInitialOnboardingState(),
            history: SYNC_STEP_RUN_HISTORY,
            organizationEstablished: true,
            phase: OnboardingPhase.SyncPolicy,
          }),
        }),
      ]
    );
  } finally {
    await first.cleanup();
  }
  return userDataDir;
}
