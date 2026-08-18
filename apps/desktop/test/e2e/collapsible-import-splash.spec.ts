/**
 * E2E regression (ISS-5258): the first-launch import splash can be collapsed to
 * a compact row, and the choice survives a relaunch — proven through the
 * LAUNCHED app.
 *
 * The renderer suites cover the derivation and the persistence hook in
 * isolation, but none of them launches Electron and drives the real disclosure
 * against a live import. This spec closes that gap (the launched-app coverage
 * `apps/desktop/AGENTS.md` requires for a new renderer surface).
 *
 * Would fail before the change: the splash had no disclosure control at all, so
 * "Hide import details" does not exist and the panel is always expanded.
 *
 * WHY THE SECOND LAUNCH GETS A SECOND TRANSCRIPT HOME: the preference lives in
 * the renderer's local storage inside the Electron user-data dir, so proving
 * persistence needs the SAME profile twice. But the same profile has already
 * imported the first batch, and the splash only mounts while a real import is
 * in flight — relaunching against the same transcripts would show no splash at
 * all and the assertion would be vacuous. A fresh home with new session ids
 * gives the second launch genuine work to do.
 *
 * ISS-6118 retired `collapsible-import-splash` ENABLED, so this launches
 * unseeded: the disclosure is unconditional and there is no key left to set. A
 * spec that kept seeding the deleted key would silently stop testing what it
 * claims. Only the disclosure COPY is still pinned as a literal here — importing
 * `src/shared/feature-flags` from a spec aborts the whole Electron run under
 * Playwright's Node loader (see the same note in `honest-sync-footer.spec.ts`
 * and `db-ahead-banner.spec.ts`).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const HIDE_DETAILS_LABEL = "Hide import details";
const SHOW_DETAILS_LABEL = "Show import details";
const STEPPER_LABEL = "Import progress steps";
const BANNER_TEST_ID = "first-launch-import-banner";
/**
 * What survives the collapse: the row still states its count. ISS-5258's own
 * contract is that the essentials outlive the breakdown, not which noun carries
 * them — ISS-5281 re-nouned the pair from sessions to TRANSCRIPTS (a source-file
 * unit; one OpenCode source is a whole `opencode.db` holding many sessions) in
 * the collapsed row, the expanded body and the rail together, so this asserts
 * the count in the population the splash actually measures. Both collapsed
 * phrasings are admitted because the phase the collapse lands on is a race:
 * "N / M transcripts" while importing, "N transcripts imported" once the import
 * has finished and the rebuild is still running.
 */
const COLLAPSED_COUNT_PATTERN =
  /[\d,]+ (?:\/ [\d,]+ )?transcripts(?: imported)?/;

// Enough sessions that the import is still in flight when the assertions run —
// the splash is only visible while importing, plus a short settle bridge.
const SEEDED_SESSION_COUNT = 60;

function seedTranscriptHome(prefix: string): string {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  seedClaudeTranscripts(
    claudeHome,
    Array.from({ length: SEEDED_SESSION_COUNT }, (_, index) => ({
      sessionId: `${prefix}${index}`,
      slug: `${prefix}${index}`,
    })),
    "collapsible-import-splash-project"
  );
  return claudeHome;
}

test("ISS-5258: the import splash collapses to a compact row and stays collapsed across a relaunch", async () => {
  // The suite-wide budget in `playwright.config.ts` is 60s, sized for ONE
  // launch. This test boots Electron twice and imports twice, and the 60s
  // `expect` timeouts below do not extend the test budget — they only bound an
  // individual assertion — so without this a slower runner reaches the test
  // deadline mid-relaunch and never evaluates the persistence assertion at all.
  test.setTimeout(300_000);

  const firstHome = seedTranscriptHome("collapsible-splash-a-");
  const secondHome = seedTranscriptHome("collapsible-splash-b-");
  // Reused across BOTH launches: the collapsed preference lives in the
  // renderer's local storage under this profile, so a fresh dir on the second
  // launch would prove nothing about persistence. BOTH launches therefore keep
  // it, and the single outer `finally` below is its only owner — split
  // ownership is what let an early failure leak it.
  let userDataDir: string | undefined;

  try {
    const first = await launchDesktopApp({
      userDataPrefix: "desktop-collapsible-import-splash-e2e-",
      env: { CLAUDE_HOME: firstHome },
      keepUserDataDir: true,
    });
    userDataDir = first.userDataDir;

    try {
      const banner = first.page.getByTestId(BANNER_TEST_ID);
      await expect(banner).toBeVisible({ timeout: 60_000 });

      // Expanded on a genuine first launch: the stepper is there and so is the
      // control that collapses it.
      await expect(
        banner.getByRole("list", { name: STEPPER_LABEL })
      ).toBeVisible({ timeout: 60_000 });
      await banner.getByRole("button", { name: HIDE_DETAILS_LABEL }).click();

      // Collapsed: the essentials survive, the breakdown does not.
      await expect(
        banner.getByRole("button", { name: SHOW_DETAILS_LABEL })
      ).toBeVisible();
      await expect(
        banner.getByRole("list", { name: STEPPER_LABEL })
      ).toHaveCount(0);
      await expect(banner).toContainText(COLLAPSED_COUNT_PATTERN);
    } finally {
      await first.cleanup();
    }

    // Relaunch against the SAME profile with NEW transcripts: the stored choice
    // must survive, and the fresh import gives the splash a reason to mount.
    const second = await launchDesktopApp({
      userDataDir,
      env: { CLAUDE_HOME: secondHome },
      keepUserDataDir: true,
    });

    try {
      const banner = second.page.getByTestId(BANNER_TEST_ID);
      await expect(banner).toBeVisible({ timeout: 60_000 });
      await expect(
        banner.getByRole("button", { name: SHOW_DETAILS_LABEL })
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        banner.getByRole("list", { name: STEPPER_LABEL })
      ).toHaveCount(0);

      // ...and expanding restores the full panel.
      await banner.getByRole("button", { name: SHOW_DETAILS_LABEL }).click();
      await expect(
        banner.getByRole("list", { name: STEPPER_LABEL })
      ).toBeVisible();
    } finally {
      await second.cleanup();
    }
  } finally {
    fs.rmSync(firstHome, { recursive: true, force: true });
    fs.rmSync(secondHome, { recursive: true, force: true });
    if (userDataDir !== undefined) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
