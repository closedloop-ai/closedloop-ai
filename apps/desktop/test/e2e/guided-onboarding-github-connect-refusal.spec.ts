/**
 * ISS-10990 launched-app regression: a refused connect handoff on the guided
 * onboarding GitHub step SAYS SO, instead of restoring the screen unchanged.
 *
 * The regression: `DesktopGuidedOnboardingDialogHost` read the hook's
 * `connectState` for `Pending` only, and `ConnectGitHubPrompt` had no failure
 * slot at all — so a handoff the main process refused ran the spinner and then
 * put the screen back byte-identical to before the click. A silent dead click,
 * on the one connect surface in the app that still had one.
 *
 * Would fail before the change: no `role="alert"` is rendered anywhere in the
 * step, because there was no element to render one.
 *
 * `src/renderer/components/onboarding/__tests__/desktop-guided-onboarding-github-connect-outcome.test.tsx`
 * mounts that chain in jsdom with the leaf IPC stubbed. This spec covers what it
 * cannot: the real built Electron app, the real preload bridge, the real auth
 * provider and the real mounted dialog — through a click, with the handoff
 * refused for real over IPC (`helpers/github-connect-leg-gate-preload.cjs`).
 *
 * The step is SEEDED rather than walked, the same way
 * `guided-onboarding-action-row-in-flow.spec.ts` seeds the sync step: the GitHub
 * phase follows the organization and invite steps, which a signed-out harness
 * cannot complete. Every edge in the seeded history is in `PHASE_EDGES`, so the
 * restored cursor is one the machine could itself have produced.
 *
 * A signed-out reader settles at the SIGN-IN leg, which is the outcome this
 * profile can actually produce — `useDesktopGitHubConnect` runs that leg first
 * and returns early when it fails. That is the same terminal state the host used
 * to discard, through the same new prop and the same new element, so it pins the
 * wiring this ticket added. The connect leg's own sentence is pinned in jsdom.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
import { readGitHubConnectLegCounter } from "./helpers/github-connect-leg-gate";

/**
 * Re-typed rather than imported, for the reason `github-connect-leg-outcome.spec.ts`
 * states at length: the canonical maps live behind extension-less `@repo/app/*`
 * imports that do not resolve under the Playwright spec loader and abort the
 * WHOLE desktop-e2e suite at load. Both sentences are already pinned through
 * their constants by sibling unit suites
 * (`shared-branches/__tests__/desktop-github-connect-copy.test.ts` and
 * `packages/app/onboarding/components/__tests__/connect-github-prompt.test.tsx`),
 * so these literals are a trip-wire on top of that, not the only pin. Do not
 * "fix" them into an import.
 */
const CONNECT_CTA_LABEL = "Continue with GitHub";
const STEP_HEADING = "Connect GitHub to finish setup";
const SIGN_IN_LEG_MESSAGE = "GitHub sign-up was not completed. Try again.";

const STEP_BUDGET_MS = 30_000;

/** The ISS-10890-order walk that reaches the GitHub step. */
const GITHUB_STEP_RUN_HISTORY = [
  OnboardingPhase.Welcome,
  OnboardingPhase.SessionDiscovery,
  OnboardingPhase.Account,
  OnboardingPhase.CreateOrganization,
  OnboardingPhase.SyncPolicy,
  OnboardingPhase.InviteTeam,
];

test("ISS-10990: a refused connect handoff is reported on the onboarding GitHub step", async () => {
  test.setTimeout(240_000);

  const homes = createHarnessHomes();
  const userDataDir = await seedGuestProfileOnGitHubStep(
    "desktop-onboarding-github-refusal-",
    homes.env
  );
  const { app, page, pageErrors, cleanup } = await launchDesktopApp({
    env: homes.env,
    githubConnectLegGate: true,
    keepFirstRunState: true,
    userDataDir,
  });

  try {
    await gotoNav(page, "dashboard");

    // The GitHub step itself, not merely some dialog: the prompt's own heading.
    await expect(page.getByRole("heading", { name: STEP_HEADING })).toBeVisible(
      {
        timeout: STEP_BUDGET_MS,
      }
    );
    const connect = page
      .getByRole("button", { exact: true, name: CONNECT_CTA_LABEL })
      .first();
    await expect(connect).toBeVisible({ timeout: STEP_BUDGET_MS });

    // Pre-fix control: the step announces nothing before the click, so the
    // assertion below is read against a change this click caused.
    await expect(page.getByRole("alert")).toHaveCount(0);

    await connect.click();

    // The regression. Pre-fix the spinner ran and the screen came back
    // unchanged — no alert, no sentence, nothing to tell the reader the handoff
    // had been refused.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: STEP_BUDGET_MS });
    await expect(alert).toHaveText(SIGN_IN_LEG_MESSAGE);

    // …and the refusal was real rather than a message rendered on a happy path:
    // the gate counted the leg it rejected.
    expect(
      await readGitHubConnectLegCounter(app, "signInsRejected")
    ).toBeGreaterThan(0);

    // The CTA stands as the retry, which is the contract the prompt states for
    // its own error: an alert beside a control the reader can no longer use
    // would be a dead end rather than a report.
    await expect(connect).toBeEnabled();

    await page
      .getByRole("button", { name: "Skip for now", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: STEP_HEADING })).toHaveCount(
      0
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await cleanup();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    removeDirs(homes.dirs);
  }
});

function createHarnessHomes(): {
  dirs: string[];
  env: Record<string, string>;
} {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-github-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-onboarding-github-codex-")
  );
  return {
    dirs: [claudeHome, codexHome],
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
  };
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Boot once to create a signed-out profile with the tour already seen and the
 * guest run parked on the GitHub step, then shut down — the relaunch renders the
 * dashboard with no auto-armed tour competing for the screen and the takeover
 * restored on the step this spec drives. The onboarded marker is REMOVED rather
 * than set: its absence is what keeps the profile a first run, which is the
 * condition the guest run reads.
 */
async function seedGuestProfileOnGitHubStep(
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
          revision: GITHUB_STEP_RUN_HISTORY.length,
          state: serializeOnboardingState({
            ...createInitialOnboardingState(),
            history: GITHUB_STEP_RUN_HISTORY,
            organizationEstablished: true,
            phase: OnboardingPhase.ConnectGitHub,
          }),
        }),
      ]
    );
  } finally {
    await first.cleanup();
  }
  return userDataDir;
}
