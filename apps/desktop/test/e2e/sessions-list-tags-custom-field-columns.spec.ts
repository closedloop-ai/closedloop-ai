/**
 * ISS-12455: launched-app proof that a signed-in Desktop Sessions list renders
 * the Tags column and a custom-field column, and that unticking the custom
 * field in the View menu takes the header away.
 *
 * The renderer suite asserts the SEAM VALUES the host hands the surface
 * (`src/renderer/components/sessions/__tests__/sessions-view-tags-custom-fields-columns.test.tsx`)
 * and it replaces the surface to do it, so it cannot see a HEADER. That blind
 * spot is exactly where the defect lived (whitlockk review): the controller arrived,
 * the definitions loaded, and the surface filtered every custom-field header out
 * against a `visibleColumnIds` the host had rebuilt from built-in ids alone.
 * Nothing but a real surface over a real controlled host catches that, which is
 * what `apps/desktop/AGENTS.md` asks for on a renderer UI fix.
 *
 * The toggle half is the other direction of the same defect:
 * `toSessionsHostViewState` strips a `custom-field:*` id on the way back to the
 * host (FEA-4222, deliberately — the host's saved view cannot represent one), so
 * a shell that did not remember the reader's choice itself showed the column
 * again on the very next render. The assertion therefore has to be that the
 * header STAYS gone.
 *
 * ISS-12691 added the favorite-star assertion to this same spec rather than a
 * new one, per `apps/desktop/test/AGENTS.md` -> "Add the regression to the
 * existing harness spec rather than a new one where possible": it already
 * drives the one chain this capability needs proven end to end — controller
 * hook -> gateway allowlist -> mutation -> favorites-list invalidation ->
 * re-render — which no renderer-only suite can see.
 *
 * Harness copied from `sessions-list-project-edit.spec.ts`, which already drives
 * a populated cloud Sessions list through a launched app.
 *
 * Outside the smoke subset deliberately (`apps/desktop/test/AGENTS.md`): this
 * does not need to gate every `main` push, so it is not added to
 * `DESKTOP_SMOKE_SPECS`.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import { expect, type Locator, test } from "@playwright/test";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag.ts";
import {
  SESSIONS_COLUMN_SPECS,
  SESSIONS_TAGS_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import { seedAuthenticatedDesktopSession } from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNavSettled,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
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
  CLOUD_TAG,
  CUSTOM_FIELD_COLUMN_ID,
  CUSTOM_FIELD_NAME,
  CUSTOM_FIELD_VALUE,
  LIST_SESSION_NAME,
  sessionsListTagsCustomFieldsCloudRoutes,
} from "./helpers/sessions-list-tags-custom-fields-cloud";

const ARM_TIMEOUT_MS = 240_000;
const MOUNT_TIMEOUT_MS = 30_000;
const SESSIONS_NAV_ID = "sessions";
/**
 * The approved header word, read from the column specs rather than re-spelled
 * here — the View menu names a column by its label, and a literal copy here is
 * a second spelling of product copy this spec does not own.
 */
const TAGS_COLUMN_LABEL = sessionsColumnLabel(SESSIONS_TAGS_COLUMN_ID);

test("Signed in, the Sessions list renders Tags and custom-field columns and honours a View-menu toggle", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const cloud = sessionsListTagsCustomFieldsCloudRoutes();
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: cloud.route,
  });
  const dirs = makeSeededSessionsDirs("iss-12455-tags-custom-fields");

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
        // The Tags column carries a `gate`, so without the assignment the
        // column does not exist to be revealed and its absence would read as
        // this fix failing.
        mergeE2eFeatureFlagAssignment(userDataDir, {
          [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        // Without this the app cannot reach the stand-in's auth API and boots
        // into "Your session expired", so every cloud read comes back empty.
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

      // THE ASSERTION THE FIX IS FOR. A custom-field column ships VISIBLE — the
      // host stores the HIDDEN ids, so a field it has never been told about is
      // shown — and no reader action reveals it. Under the defect this header
      // never appears at all.
      const customHeader = columnHeader(panel, CUSTOM_FIELD_COLUMN_ID);
      await expect(customHeader).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(
        row.locator(`[data-column-id="${CUSTOM_FIELD_COLUMN_ID}"]`)
      ).toContainText(CUSTOM_FIELD_VALUE);

      // Tags ships default-OFF (`SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS`, ISS-8712,
      // the approved prototype's default), so revealing it is the reader's own
      // path rather than harness setup. Exact: every header also carries a
      // "<label> column options" button a substring match would also resolve.
      await panel.getByRole("button", { exact: true, name: "Options" }).click();
      await page.getByRole("menuitem", { name: TAGS_COLUMN_LABEL }).click();
      await page.keyboard.press("Escape");

      await expect(columnHeader(panel, SESSIONS_TAGS_COLUMN_ID)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(
        row.locator(`[data-column-id="${SESSIONS_TAGS_COLUMN_ID}"]`)
      ).toContainText(CLOUD_TAG.name);

      // The write half: the surface reports the custom id back, the host's own
      // store has to remember it, and the header must STAY gone across the
      // re-render the report causes.
      await panel.getByRole("button", { exact: true, name: "Options" }).click();
      await page.getByRole("menuitem", { name: CUSTOM_FIELD_NAME }).click();
      await page.keyboard.press("Escape");

      await expect(customHeader).toHaveCount(0, { timeout: MOUNT_TIMEOUT_MS });
      // Settled, not transient: the toggle survives a further commit, which is
      // the one the stripping used to undo it on.
      await expect(columnHeader(panel, SESSIONS_TAGS_COLUMN_ID)).toBeVisible();
      await expect(customHeader).toHaveCount(0);

      // ISS-12691: the shared favorite star. The row's session id IS a cloud
      // artifact id, so unlike local mode this is wired, not withheld.
      const star = row.getByRole("button", {
        name: `Add ${LIST_SESSION_NAME} to favorites`,
      });
      await expect(star).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await star.click();
      await expect(
        row.getByRole("button", {
          name: `Remove ${LIST_SESSION_NAME} from favorites`,
        })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

function columnHeader(panel: Locator, columnId: string): Locator {
  return panel.locator(`[role="columnheader"][data-column-id="${columnId}"]`);
}

/** A column's own declared label, or a loud failure rather than a silent miss. */
function sessionsColumnLabel(columnId: string): string {
  const spec = SESSIONS_COLUMN_SPECS.find((entry) => entry.id === columnId);
  if (!spec) {
    throw new Error(`No Sessions column spec declares ${columnId}.`);
  }
  return spec.label;
}
