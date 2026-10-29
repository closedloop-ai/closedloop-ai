/**
 * ISS-10411 launched-app regression: a connect-GitHub click that fails at the
 * SIGN-IN leg must say so, not blame the GitHub hand-off it never reached.
 *
 * The regression: `useDesktopGitHubConnect` ran the device authorization and
 * the GitHub connect hand-off inside ONE `try`, so a sign-in that rejected
 * settled as `Failed` and the banner read "GitHub connect could not be opened."
 * The step that broke and the step named on screen were different steps, and a
 * reader was sent to re-do a leg that had never run.
 *
 * `src/renderer/components/branches/__tests__/use-desktop-github-connect.test.tsx`
 * pins the hook with a stubbed bridge. This spec covers what it cannot: the
 * real built Electron app, the real preload bridge, the real auth provider, and
 * the real mounted Dashboard banner — through a click, with the sign-in leg
 * rejecting for real over IPC (`helpers/github-connect-leg-gate-preload.cjs`).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { readGitHubConnectLegCounter } from "./helpers/github-connect-leg-gate";
import {
  seedClosedAtOnlySinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * Re-typed rather than imported, for two independent reasons. (1) The canonical
 * map lives in `shared-branches/desktop-github-connect-copy.ts`, which reaches
 * `use-desktop-github-connect.ts` and its extension-less `@repo/app/*` imports;
 * those do not resolve under the Playwright spec loader and abort the WHOLE
 * desktop-e2e suite at load (`apps/desktop/test/AGENTS.md`). (2) These
 * are therefore a deliberate trip-wire ON TOP of coverage that already locates
 * through the constant: `shared-branches/__tests__/desktop-github-connect-copy.test.ts`
 * imports the map and pins both sentences, so a reworded label still reddens
 * that sibling. Do not "fix" these into an import — it would take the wording
 * pin out of the launched app entirely.
 */
const SIGN_IN_LEG_BANNER = "GitHub sign-up was not completed. Try again.";
const CONNECT_LEG_BANNER =
  "GitHub connect could not be opened. Local data remains available.";
/**
 * The DASHBOARD CARD's verb, which is where this spec clicks. ISS-11476 reworded
 * the gated `card` placement to the reporter's `web-master` prototype wording,
 * so the bare "Connect GitHub" this used to read no longer names any control on
 * that screen — it is the banner and centered placements' verb now.
 */
const CONNECT_GITHUB_LABEL = "Connect to GitHub";

const MOUNT_TIMEOUT_MS = 45_000;

const SEED = {
  repoFullName: "acme/web",
  branchName: "iss-10411-connect-leg-outcome",
  sessionId: "iss-10411-connect-leg-outcome-session",
  prNumber: 10_411,
  closedAt: "2026-07-07T12:00:00.000Z",
} as const;

test.describe("Desktop connect-GitHub leg outcomes (ISS-10411)", () => {
  test("a rejected sign-in names the sign-in leg, never the connect leg", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-connect-leg-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-connect-leg-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-connect-leg-udd-")
    );

    try {
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
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

      // A merged branch so the Dashboard renders its gated KPI cards — and with
      // them the connect affordance — instead of the empty state.
      await seedClosedAtOnlySinglePrBranch(userDataDir, SEED);

      const { app, page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        githubConnectLegGate: true,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "dashboard");

        const connect = page
          .getByRole("button", { exact: true, name: CONNECT_GITHUB_LABEL })
          .first();
        await expect(connect).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        await connect.click();

        // Positive control: the sign-in leg's own sentence renders, so the
        // absence assertion below is read against a live surface.
        await expect(page.getByText(SIGN_IN_LEG_BANNER)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The regression itself. Pre-fix this sentence is what the banner said,
        // because one `try` wrapped both legs.
        await expect(page.getByText(CONNECT_LEG_BANNER)).toHaveCount(0);

        // …and the connect leg genuinely never ran, which is what makes naming
        // it a lie rather than a wording preference. The rejection count is the
        // paired positive control for that zero.
        expect(
          await readGitHubConnectLegCounter(app, "signInsRejected")
        ).toBeGreaterThan(0);
        expect(await readGitHubConnectLegCounter(app, "connectsReached")).toBe(
          0
        );

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});
