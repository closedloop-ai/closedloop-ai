/**
 * ISS-12302 / PLN-2173 M3 (desktop adapter): custom fields on the Session
 * Details tab through a LAUNCHED Electron app.
 *
 * Cloud mode reads the definitions and values from the cloud and writes an
 * edit back through the renderer's IPC bridge, so the PUT the stand-in records
 * proves the bridge admits it (PLN-2173 M1). Local mode has no custom-field
 * data, so the section is not drawn.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import { expect, test } from "@playwright/test";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field.ts";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import { sessionDetailFixture } from "../../../../e2e/helpers/session-detail-fixtures";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import { seedAuthenticatedDesktopSession } from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  customFieldsSection,
  detailsCustomFieldCloudRoutes,
  expectCloudCustomFieldEditsSave,
} from "./helpers/details-custom-fields-cloud";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  withSeededSessionsProfile,
} from "./helpers/seeded-sessions-list";
import {
  CLOUD_SESSION_DETAIL_ID,
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

const MOUNT_TIMEOUT_MS = 30_000;
const ARM_TIMEOUT_MS = 240_000;
const LOCAL_SESSION_ID = "iss-12302-local-session";

test("Cloud mode draws the session's custom fields and saves edits through the bridge", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const customFields = detailsCustomFieldCloudRoutes({
    entityId: CLOUD_SESSION_DETAIL_ID,
    entityType: CustomFieldEntityType.Session,
    segment: "agent-sessions",
  });
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: customFields.route,
  });
  const dirs = makeSeededSessionsDirs("iss-12302-session-cloud");

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
        seedCloudSessionDetailProfile(userDataDir, server.origin, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });
    try {
      await expectCloudCustomFieldEditsSave(page, {
        detailsHash: `/sessions/${CLOUD_SESSION_DETAIL_ID}?tab=details`,
        itemLabel: sessionDetailFixture().name ?? "",
        writes: customFields.writes,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

test("Local mode draws no Custom fields section", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const dirs = makeSeededSessionsDirs("iss-12302-session-local");
  try {
    await withSeededSessionsProfile(
      dirs,
      {
        beforeRelaunch: (userDataDir) => {
          seedDesktopFeatureFlags(userDataDir, {
            [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
          });
        },
        sessions: [
          {
            at: new Date().toISOString(),
            name: "ISS-12302 local session",
            sessionId: LOCAL_SESSION_ID,
          },
        ],
      },
      async (page) => {
        await gotoHash(page, `/sessions/${LOCAL_SESSION_ID}?tab=details`);
        const details = page.getByRole("tabpanel", {
          exact: true,
          name: "Details",
        });
        await expect(
          details.getByText("Session ID", { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(customFieldsSection(page)).toHaveCount(0);
      }
    );
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});
