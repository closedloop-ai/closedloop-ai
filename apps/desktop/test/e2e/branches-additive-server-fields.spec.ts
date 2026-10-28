/**
 * ISS-8884 regression, launched Desktop — the shared Branches server-page
 * boundary schema used to be `.strict()` on every nested object, so an
 * already-installed Desktop meeting a NEWER page producer (one additive field
 * inside `facets`, a facet result, a facet option, or `pageInfo`) errored the
 * whole Branches page. The renderer and the main process ship in one build, so
 * the skew is staged by the page-data gate preload: it adds those keys to each
 * real IPC response before it crosses to the renderer.
 *
 * On `origin/main` this spec fails: the seeded branch never renders.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { enableBranchesPageDataSkew } from "./helpers/branches-page-data-gate";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const REPOSITORY = "closedloop-e2e/additive-server-fields";
const BRANCH_NAME = "iss-8884-additive-fields";
const SESSION_ID = "iss-8884-additive-fields-session";

test("renders the Branches list when the page producer adds fields inside every nested object", async () => {
  test.setTimeout(240_000);
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-additive-udd-")
  );
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-additive-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-branches-additive-codex-")
  );
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
  };

  try {
    const bootstrap = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    await seedNoPullRequestBranch(userDataDir, {
      repoFullName: REPOSITORY,
      branchName: BRANCH_NAME,
      sessionId: SESSION_ID,
      activityAt: new Date().toISOString(),
    });

    const launched = await launchDesktopApp({
      branchesPageDataGate: true,
      env,
      keepUserDataDir: true,
      userDataDir,
      beforeLaunch: (profileDir) => seedDesktopFeatureFlags(profileDir, {}),
    });
    try {
      await enableBranchesPageDataSkew(launched.app);
      await gotoNav(launched.page, "branches");

      await expect(branchLink(launched.page, BRANCH_NAME)).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

function branchLink(page: Page, name: string) {
  return page
    .getByRole("region", { name: "Branches" })
    .getByRole("link", { name, exact: true });
}
