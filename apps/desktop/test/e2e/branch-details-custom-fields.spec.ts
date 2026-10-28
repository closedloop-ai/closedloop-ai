/**
 * ISS-12302 / PLN-2173 M4 (desktop adapter): custom fields on the Branch
 * Details tab through a LAUNCHED Electron app.
 *
 * Cloud mode reads the definitions and the branch artifact's values from the
 * cloud and writes an edit back through the renderer's IPC bridge, so the PUT
 * the stand-in records proves the bridge admits it (PLN-2173 M1). Local mode
 * has no custom-field data, so the section is not drawn.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { encodeBranchId } from "@repo/api/src/types/branch.ts";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field.ts";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import {
  BRANCH_ID,
  BRANCH_NAME,
  detailFor,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  customFieldsSection,
  detailsCustomFieldCloudRoutes,
  expectCloudCustomFieldEditsSave,
} from "./helpers/details-custom-fields-cloud";
import {
  type BranchDetailsSeed,
  seedBranchDetails,
} from "./helpers/seed-branch-details-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const MOUNT_TIMEOUT_MS = 30_000;
const ARM_TIMEOUT_MS = 240_000;
const PROFILE_ID = "iss-12302-branch-details-custom-fields-profile";
/** Not the row id: the values service resolves `artifacts.id` (ISS-12302). */
const BRANCH_ARTIFACT_ID = "0199f1c4-12d3-7a00-8b00-000000012302";

const LOCAL_SEED: BranchDetailsSeed = {
  activePullRequest: {
    number: 12_303,
    openedAt: "2026-10-05T16:00:00.000Z",
    title: "Draw custom fields on Branch Details",
  },
  branchName: "feat/iss-12302-local-custom-fields",
  mergedPullRequest: {
    mergedAt: "2026-10-04T15:00:00.000Z",
    number: 12_302,
    title: "Add self-saving Details rows",
  },
  repoFullName: "closedloop-ai/closedloop-ai",
  sessionId: "iss-12302-local-branch-session",
};

test("Cloud mode draws the branch's custom fields and saves edits through the bridge", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const customFields = detailsCustomFieldCloudRoutes({
    entityId: BRANCH_ARTIFACT_ID,
    entityType: CustomFieldEntityType.Branch,
    segment: "branches",
  });
  const server = await startAuthenticatedBranchCloudServer({
    detailFactory: (pullRequestNumber) => ({
      ...detailFor(pullRequestNumber),
      artifactId: BRANCH_ARTIFACT_ID,
    }),
    extraRoutes: customFields.route,
  });
  const dirs = tempDirs("iss-12302-branch-cloud");

  try {
    const seedLaunch = await launchAuthenticatedDesktopApp({
      env: dirs.env,
      userDataDir: dirs.userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(seedLaunch.app, dirs.userDataDir);
    } finally {
      await seedLaunch.cleanup();
    }

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopSettings(userDataDir, {
          activeConfigId: PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: PROFILE_ID,
              name: "ISS-12302 Branch Details custom fields E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(userDataDir, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: { ...dirs.env, CL_AUTH_API_ORIGIN: server.origin },
      userDataDir: dirs.userDataDir,
    });
    try {
      await expectCloudCustomFieldEditsSave(page, {
        detailsHash: `/branches/${BRANCH_ID}?tab=details`,
        itemLabel: BRANCH_NAME,
        writes: customFields.writes,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    dirs.remove();
  }
});

test("Local mode draws no Custom fields section", async () => {
  test.setTimeout(ARM_TIMEOUT_MS);
  const dirs = tempDirs("iss-12302-branch-local");

  try {
    const migrationLaunch = await launchDesktopApp({
      env: dirs.env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      await waitForBranchesSchema(dirs.userDataDir);
    } finally {
      await migrationLaunch.cleanup();
    }
    await seedBranchDetails(dirs.userDataDir, LOCAL_SEED);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedDesktopFeatureFlags(userDataDir, {
          [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true,
        });
      },
      env: dirs.env,
      keepUserDataDir: true,
      userDataDir: dirs.userDataDir,
    });
    try {
      const localId = encodeBranchId({
        branchName: LOCAL_SEED.branchName,
        repoFullName: LOCAL_SEED.repoFullName,
      });
      await gotoHash(
        page,
        `/branches/${encodeURIComponent(localId)}?tab=details`
      );
      const details = page.getByRole("tabpanel", {
        exact: true,
        name: "Details",
      });
      await expect(
        details.getByText("Repository", { exact: true })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(customFieldsSection(page)).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    dirs.remove();
  }
});

function tempDirs(prefix: string) {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  return {
    env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
    remove: () => {
      for (const dir of [claudeHome, codexHome, userDataDir]) {
        fs.rmSync(dir, { force: true, recursive: true });
      }
    },
    userDataDir,
  };
}
