/**
 * @file read-source-cutover-parity.spec.ts
 * @description ISS-5714, through a LAUNCHED Electron app.
 *
 * The reported defect: a populated machine signs in, its history has not
 * finished uploading, and the app then tells the user their data lives in two
 * places at once — Sessions renders `Local` over the real local corpus while
 * Branches renders `Cloud` over an empty workspace, because the two surfaces
 * chose their read store from two different predicates.
 *
 * WHY THIS EXISTS ALONGSIDE THE RENDERER SUITE (review thread on #4707). The
 * renderer parity test (`shared-branches/__tests__/read-source-cross-surface-parity`)
 * mounts the providers directly, so it never exercises the readiness IPC channel,
 * the preload bridge, or the real Branches source behind the visible surface —
 * exactly the layers where the two halves are wired together, and exactly where
 * this class of defect hides. The desktop UI bug-fix rule wants the regression
 * driven through a launched app, so this drives it through the shipped nav, the
 * shipped surfaces, and the shipped `ReadSourceBadge`.
 *
 * ISS-6005 — WHY THE FIRST LEG IS THE DASHBOARD, NOT SESSIONS. The Sessions
 * toolbar's read-source pill was dropped at operator direction ("no one asked
 * for it"), so Sessions no longer renders a badge for this spec to read. The
 * cutover DECISION machinery is untouched, and its two remaining surface-level
 * expressions on desktop are the Dashboard header and the Branches toolbar —
 * so those two are what a launched app can still compare. The Dashboard badge
 * derives from the canonical `useDesktopAppCoreMode()` (see
 * `DashboardReadSourceBadge`), i.e. the same one-cutover decision Sessions'
 * list read consumes, which is what keeps this a parity assertion rather than
 * two unrelated reads. The per-query `sessions.data.readSource` half of the
 * original claim is still pinned, unchanged, by the renderer parity test named
 * above — it builds its own harness around `ReadSourceBadge` and never mounted
 * `SessionsToolbar`, so the pill's removal does not weaken it.
 *
 * The readiness snapshot is the ONE substituted input — see
 * `cloudReadReadinessLaunchArgs` for why the production sampler cannot answer
 * inside a spec's lifetime. Everything from the IPC handler down is shipped code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DesktopAuthStatus } from "../../src/shared/contracts";
import {
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainingCloudReadReadiness,
  gotoNav,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  seedMergedUnenrichedSinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The local corpus that must stay on screen. A distinctive, non-default name
 * (default branches are hidden by the Branches PR read).
 *
 * Merged INSIDE the default 30-day window, computed from `Date.now()` rather than
 * pinned. That is what lets this spec read the Branches surface without touching
 * the date-range toggle: the "All time" control lives in a toolbar that shares an
 * `aria-label` with the keep-alive-hidden Sessions toolbar, and clicking it after
 * a cross-surface navigation was measurably flaky on CI (visible in the
 * flake-repeat lane: one attempt timed out on actionability while the next
 * passed). The window is a precondition of this test, not its subject, so it is
 * satisfied by the fixture instead of by a UI interaction that can race.
 */
const SEED = {
  repoFullName: "acme/web",
  branchName: "iss-5714-read-source-parity-e2e",
  sessionId: "iss-5714-read-source-parity-session",
  prNumber: 5714,
  mergedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
} as const;

const PROFILE_ID = "read-source-parity-profile";
const GATEWAY_ID = "44734473-4473-4473-8473-447344734473";

test.describe("Sessions and Branches read-source parity (ISS-5714)", () => {
  test("keeps BOTH surfaces on the local store while the upload backlog drains", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "read-source-parity-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "read-source-parity-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "read-source-parity-udd-")
    );
    const server = await startAuthenticatedBranchCloudServer({
      repositoryFullNames: [SEED.repoFullName],
    });

    try {
      // Launch 1 — create + migrate the SQLite schema and encrypt a first-party
      // session the next launch restores through the production refresh lane.
      const seedLaunch = await launchAuthenticatedDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
      });
      try {
        await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
        await waitForBranchesSchema(userDataDir);
      } finally {
        await seedLaunch.cleanup();
      }

      // Populate the LOCAL corpus while the app is DOWN (no WAL contention).
      // Without rows here the "stayed local" claim would be unfalsifiable: an
      // empty local read and an empty cloud read look identical on screen.
      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED);

      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          // THE STATE UNDER TEST: signed in, online, and the machine's history is
          // still on its way up. The cloud therefore holds none of it, and any
          // surface reading the cloud here shows the user an empty workspace.
          cloudReadReadiness: drainingCloudReadReadiness(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: PROFILE_ID,
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: GATEWAY_ID,
                  id: PROFILE_ID,
                  name: "Read Source Parity E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
          },
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          userDataDir,
        }
      );

      try {
        // The gate only exists for an AUTHENTICATED reader — signed out, both
        // surfaces are trivially local and this would prove nothing.
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });

        await gotoNav(page, "dashboard");
        const dashboardSource = await settledReadSource(page);

        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        // Prove the local corpus is genuinely ON SCREEN. This is what makes the
        // badge assertion below falsifiable rather than a claim about an empty
        // page: `local` over nothing is not the state this ticket is about. The
        // seed is dated into the default window (see `SEED`), so no date-range
        // interaction is needed to get here.
        //
        // `filter({ visible: true })`, not `.first()`: keep-alive leaves the
        // other surfaces mounted-but-hidden and they carry their own copy of
        // this name, so `.first()` can resolve to a hidden node and assert
        // nothing about the page the user is looking at.
        const seededRow = page
          .getByText(SEED.branchName, { exact: true })
          .filter({ visible: true });
        await expect(seededRow).toHaveCount(1, { timeout: 30_000 });
        await expect(seededRow).toBeVisible();
        const branchesSource = await settledReadSource(page);

        // The DISAGREEMENT is the bug, so the two are compared to each other...
        expect({
          branches: branchesSource,
          dashboard: dashboardSource,
        }).toEqual({
          branches: dashboardSource,
          dashboard: dashboardSource,
        });
        // ...but equality alone would also pass if BOTH went to the wrong store,
        // so the store they agree on is pinned too. Mid-drain the cloud holds
        // nothing, so the only honest answer for either surface is `local`.
        expect(dashboardSource).toBe("local");

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

/**
 * The active surface's rendered read-source, from the shipped `ReadSourceBadge`.
 *
 * Scoped to `:visible` and pinned to EXACTLY ONE match: keep-alive leaves the
 * other views mounted-but-hidden and they carry their own badges, so a page-wide
 * match would resolve to several and could read the wrong surface's answer —
 * which on this spec's subject is the difference between catching the defect and
 * reporting it fixed. The count of 1 is also what would fail loudly if a THIRD
 * badge were ever added to a surface this spec navigates to.
 */
async function settledReadSource(page: import("@playwright/test").Page) {
  const badge = page.locator('[data-testid="read-source-badge"]:visible');
  await expect(badge).toHaveCount(1, { timeout: 30_000 });
  return await badge.getAttribute("data-read-source");
}
