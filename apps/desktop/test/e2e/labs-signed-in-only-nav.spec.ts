/**
 * Operator instruction: "Documents and Issues shouldn't even show up as menu
 * items under Labs on desktop unless logged in."
 *
 * Both launches open the Labs container and the Issues flag, so the account is
 * the only thing that can take the Issues row away. Each case runs on both
 * sidebar trees, because the legacy and v2 sidebars build their rows
 * differently and both read `hiddenNavIds`. Desktop maps no nav id to the
 * Documents route yet, so only Issues has a row to assert on.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { closeServer } from "./helpers/branch-details-authenticated-cloud";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  launchShellSidebarApp,
  seedShellSidebarSession,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

/**
 * Literal PostHog keys: an Electron spec cannot import an extension-less
 * `@repo/*` subpath without aborting the suite at load time
 * (`test/AGENTS.md`). Canonical homes: `DESKTOP_LABS_NAV_FEATURE_FLAG_KEY`
 * (`src/shared/feature-flags-labs-detail.ts`), `ArtifactFlag.Issues` and
 * `ArtifactFlag.Documents` (`packages/app/shared/lib/artifact-flags.ts`) and
 * `SHELL_SIDEBAR_V2_FLAG_KEY`
 * (`packages/api/src/types/shell-sidebar-v2-flag.ts`).
 */
const LABS_NAV_FLAG_KEY = "labsNav";
const ISSUES_NAV_FLAG_KEY = "issues-nav";
/** The Issues row also needs Documents (Kerensa Whitlock, 2026-10-21, #9083). */
const DOCUMENTS_NAV_FLAG_KEY = "documents-nav";
const SHELL_SIDEBAR_V2_FLAG_KEY = "shell-sidebar-v2";

const ISSUES_LABEL = "Issues";
/** A Labs row the account does not gate: proves the section is open. */
const INSIGHTS_LABEL = "Insights";
const ADD_ISSUE_LABEL = "Add issue";
const SPEC_TIMEOUT_MS = 180_000;
const NAV_READY_TIMEOUT_MS = 30_000;

const SIDEBAR_TREES = [
  { name: "legacy sidebar", v2: false },
  { name: "v2 sidebar", v2: true },
] as const;

function flagsFor(v2: boolean): Record<string, boolean> {
  return {
    [LABS_NAV_FLAG_KEY]: true,
    [ISSUES_NAV_FLAG_KEY]: true,
    [DOCUMENTS_NAV_FLAG_KEY]: true,
    [SHELL_SIDEBAR_V2_FLAG_KEY]: v2,
  };
}

function sidebarRow(page: Page, label: string) {
  return page
    .locator('[data-slot="sidebar"]')
    .getByText(label, { exact: true });
}

async function openLabs(page: Page): Promise<void> {
  await gotoHash(page, "/dashboard");
  const labs = page.getByRole("button", { name: "Labs", exact: true });
  await expect(labs).toBeVisible({ timeout: NAV_READY_TIMEOUT_MS });
  await labs.click();
  await expect(sidebarRow(page, INSIGHTS_LABEL)).toBeVisible();
}

for (const tree of SIDEBAR_TREES) {
  test(`hides Labs Issues while signed out (${tree.name})`, async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-signed-out-nav-",
      beforeLaunch: (userDataDir) =>
        seedDesktopFeatureFlags(userDataDir, flagsFor(tree.v2)),
    });
    try {
      await openLabs(page);
      await expect(sidebarRow(page, ISSUES_LABEL)).toHaveCount(0);
      // The Issues flag did resolve open: the route still renders the page, so
      // the missing row is the account gate, not a closed `issues-nav`.
      await gotoHash(page, "/issues");
      await expect(
        page.getByRole("button", { name: ADD_ISSUE_LABEL, exact: true })
      ).toBeVisible({ timeout: NAV_READY_TIMEOUT_MS });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test(`shows Labs Issues while signed in (${tree.name})`, async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);
    const flags = flagsFor(tree.v2);
    const server = await startNavigationCloudServer({ featureFlags: flags });
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-labs-signed-in-nav-")
    );
    try {
      await seedShellSidebarSession(userDataDir);
      const { page, pageErrors, cleanup } = await launchShellSidebarApp({
        apiOrigin: server.origin,
        flags,
        profileId: "labs-signed-in-only-nav",
        profileName: "Labs signed-in-only nav",
        userDataDir,
      });
      try {
        await openLabs(page);
        await expect(sidebarRow(page, ISSUES_LABEL)).toBeVisible();
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await closeServer(server.server);
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
}
