/**
 * ISS-12454: filing a session into a project from the Sessions LIST, through a
 * launched Electron app.
 *
 * The renderer suites already assert the request shape
 * (`packages/app/agents/components/sessions/__tests__/sessions-list-project-write.test.tsx`).
 * What only a launched app settles is the COMPOSITION: that the column can be
 * revealed from the real Options menu, that the picker opens inside a real grid
 * cell, that selecting a project issues an authenticated write the server
 * actually receives, and that the cell then repaints to what the list reports —
 * a chain of real Electron, real surface, real Radix popover and real cloud
 * transport that no jsdom mount reproduces.
 *
 * It does NOT prove the desktop IPC batch-mutation allowlist carries this write,
 * and an earlier version of this docblock claimed it did. Measured: emptying BOTH
 * structures `cloud-api-fetch-ipc.ts` derives from `BatchMutationRoute`
 * (`BATCH_MUTATION_ROUTE_PATTERNS` and `batchMutationPaths`), rebuilding, and
 * re-running leaves this spec GREEN. So this write does not travel that path, and
 * the ticket's "verify the bridge admits it" is answered statically — the route
 * is a `BatchMutationRoute` member and appears in both structures — not by this
 * spec. A spec that wants to pin the allowlist has to drive whatever path
 * actually consults it.
 *
 * A new spec rather than an addition, because no existing spec drives a POPULATED
 * cloud Sessions list — the authenticated stand-in's own `/agent-sessions` serves
 * an empty list, which is why these routes override it.
 *
 * Outside the smoke subset deliberately (`apps/desktop/test/AGENTS.md`): this
 * does not need to gate every `main` push, so it is not added to
 * `DESKTOP_SMOKE_SPECS`.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import { expect, test } from "@playwright/test";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract.ts";
import {
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_LABEL,
} from "@repo/app/agents/lib/sessions-table-columns.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import { seedAuthenticatedDesktopSession } from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNavSettled,
} from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";
import {
  FILED_PROJECT,
  LIST_SESSION_ID,
  LIST_SESSION_NAME,
  sessionsListProjectCloudRoutes,
  TARGET_PROJECT,
} from "./helpers/sessions-list-project-cloud";

const ARM_TIMEOUT_MS = 240_000;
const MOUNT_TIMEOUT_MS = 30_000;
const SESSIONS_NAV_ID = "sessions";

test("Signed in, the Sessions list files a session into a project through the bridge", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const cloud = sessionsListProjectCloudRoutes();
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: cloud.route,
  });
  const dirs = makeSeededSessionsDirs("iss-12454-project-edit");

  try {
    const seedLaunch = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome },
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
      await seedAuthenticatedDesktopSession(seedLaunch.app, dirs.userDataDir);
    } finally {
      await seedLaunch.cleanup();
    }

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedCloudSessionDetailProfile(userDataDir, server.origin, {});
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        // Without this the app cannot reach the stand-in's auth API and boots
        // into "Your session expired", so every cloud read comes back empty and
        // the list has no row to act on.
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });

    try {
      const panel = await gotoNavSettled(page, SESSIONS_NAV_ID);
      // Scoped to the active panel: keep-alive leaves Dashboard mounted and its
      // Recent Sessions grid renders rows of its own.
      const row = panel
        .locator('[role="row"]', { hasText: LIST_SESSION_NAME })
        .first();
      await expect(row).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

      // The column ships default-OFF: `SESSIONS_PROJECTS_COLUMN_ID` is in
      // `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS` (ISS-5770, the approved prototype's
      // default), so a brand-new view does not render it and a reader turns it on
      // first. Revealing it here is the user's own path, not harness setup.
      // Exact: every column header also carries a "<label> column options"
      // button, and a substring match resolves to all twelve of them.
      await panel.getByRole("button", { exact: true, name: "Options" }).click();
      // `menuitem` with a sibling `switch`, not `menuitemcheckbox`: the switch
      // carries no text of its own, so the row is what has the name.
      await page
        .getByRole("menuitem", { name: SESSIONS_PROJECTS_COLUMN_LABEL })
        .click();
      await page.keyboard.press("Escape");

      // The cell renders the project it is FILED into, which is the read half —
      // without it, a passing write could be filing a row nobody could see.
      const cell = row.locator(
        `[data-column-id="${SESSIONS_PROJECTS_COLUMN_ID}"]`
      );
      await expect(cell).toContainText(FILED_PROJECT.name);

      await cell.getByRole("combobox").click();
      // The stand-in serves the projects reverse-alphabetically, so an unsorted
      // picker lists them in the opposite order (ISS-12568).
      const projectNames = [TARGET_PROJECT.name, FILED_PROJECT.name];
      await expect
        .poll(async () => {
          const texts = await page.getByRole("option").allTextContents();
          return texts.flatMap((text) => {
            const name = projectNames.find((candidate) =>
              text.startsWith(candidate)
            );
            return name ? [name] : [];
          });
        })
        .toEqual(projectNames);
      await page.getByRole("option", { name: TARGET_PROJECT.name }).click();

      // The REQUEST, not the label: the cell repainting would also follow from a
      // local cache write that never left the app.
      await expect
        .poll(() => cloud.writes.length, { timeout: MOUNT_TIMEOUT_MS })
        .toBe(1);
      // `artifactId` pinned, not `expect.any(String)` (tamsinb review): the
      // launched app is the only place a wrong id gets caught, and the stand-in
      // does not reject one either. `toEqual`, as the web spec does, so an extra
      // field cannot ride along unnoticed.
      expect(cloud.writes[0]?.body).toEqual({
        artifactId: LIST_SESSION_ID,
        targetProjectId: TARGET_PROJECT.id,
        includeDownstream: false,
        expectedProjectId: FILED_PROJECT.id,
        // ISS-9489 (#8967): the cell names its edit surface as provenance.
        surface: ArtifactStatusEditSurface.InlineCell,
      });
      // The LIST now reports the new project, and the cell repaints to it
      // (whitlockk review). The stand-in used to keep answering `FILED_PROJECT`, so
      // this assertion could not fail: the request above proved the write left
      // the app, and nothing proved the surface ever took the answer back.
      await expect(cell).toContainText(TARGET_PROJECT.name, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // The write arrived authenticated. This says the transport attached the
      // token, NOT which transport it was — see the docblock: the IPC
      // batch-mutation allowlist is demonstrably not on this path.
      expect(cloud.unauthorizedCount()).toBe(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});
