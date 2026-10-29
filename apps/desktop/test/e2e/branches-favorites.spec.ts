import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import {
  makeBranchRow,
  makeListResponse,
} from "../../../../e2e/helpers/branches-surface-fixtures";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const ARTIFACT_ID = "5c1c0a2e-6d1a-4f5b-9c3e-8a1d2f3b4c5d";
const BRANCH = makeBranchRow({ artifactId: ARTIFACT_ID });
const PROFILE_ID = "iss-12918-branches-favorites-profile";
const FAVORITE_PATH = `/artifacts/${ARTIFACT_ID}/favorite`;

test("Desktop Branches stars and unstars through the existing cloud favorite store", async () => {
  test.setTimeout(240_000);
  let favorited = false;
  const server = await startAuthenticatedBranchCloudServer({
    listFactory: () => makeListResponse([BRANCH]),
    extraRoutes: (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/artifacts/favorites" && request.method === "GET") {
        writeApiResult(response, favorited ? [{ id: ARTIFACT_ID }] : []);
        return true;
      }
      if (
        pathname === FAVORITE_PATH &&
        (request.method === "POST" || request.method === "DELETE")
      ) {
        favorited = request.method === "POST";
        writeApiResult(response, {});
        return true;
      }
      return false;
    },
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12918-desktop-udd-")
  );
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12918-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-12918-desktop-codex-")
  );

  try {
    const { cleanup, page } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: PROFILE_ID,
              name: "ISS-12918 Branch favorites E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        seedDesktopFeatureFlags(launchUserDataDir, {
          [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });
    try {
      await gotoNav(page, "branches");
      const row = page
        .getByRole("link", { name: BRANCH.branchName, exact: true })
        .locator("xpath=ancestor::*[@role='row'][1]");
      const add = row.getByRole("button", {
        name: `Add ${BRANCH.branchName} to favorites`,
      });
      await expect(add).toBeVisible({ timeout: 30_000 });
      await row.evaluate((element) =>
        element.scrollIntoView({ block: "center" })
      );
      await add.click();
      await expect(
        row.getByRole("button", {
          name: `Remove ${BRANCH.branchName} from favorites`,
        })
      ).toBeVisible();
      await row
        .getByRole("button", {
          name: `Remove ${BRANCH.branchName} from favorites`,
        })
        .click();
      await expect(add).toBeVisible();
      expect(
        server.requests
          .filter((request) => request.pathname === FAVORITE_PATH)
          .map((request) => request.method)
      ).toEqual(["POST", "DELETE"]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
  }
});
