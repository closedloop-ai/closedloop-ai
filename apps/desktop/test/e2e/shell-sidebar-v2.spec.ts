/**
 * ISS-9734 (PLN-2016 M3) — the desktop mount of the shared v2 ShellSidebar.
 *
 * AUTHENTICATED, and that is the load-bearing part. Every case below asserts a
 * nav row is a LINK, and a v2 row is only navigable once
 * `GET /navigation/view-model` has answered READY for it. A signed-out desktop
 * launch has no cloud session, so that read fails and every row renders as an
 * inert "Unavailable" button — an honest outcome the renderer suite already
 * pins, and one no wait makes into a link. So this spec stands up the same
 * first-party session the authenticated Branch specs use, plus a stand-in cloud
 * that answers the projection.
 *
 * The launch, the stand-in cloud and why both origins point at it live in
 * `helpers/shell-navigation-cloud.ts`, shared with the ISS-8361 route matrix.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  closeServer,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash } from "./helpers/desktop-app";
import {
  currentHashRoute,
  launchShellSidebarApp,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

/**
 * The PostHog keys this spec seeds, pinned as literals for the same reason
 * `branch-detail-hide-unavailable-card.spec.ts` pins its own: a desktop e2e spec
 * cannot import an extension-less `@repo/*` subpath without aborting the whole
 * Electron suite at load time. Canonical homes are
 * `SHELL_SIDEBAR_V2_FLAG_KEY` (`packages/api/src/types/shell-sidebar-v2-flag.ts`)
 * and the desktop gate keys in
 * `packages/app/shared/lib/shell-navigation-contract.ts`.
 */
const SHELL_SIDEBAR_V2_FLAG_KEY = "shell-sidebar-v2";
const LABS_NAV_FLAG_KEY = "labsNav";
const AGENTS_NAV_FLAG_KEY = "agentsNav";

/**
 * The FULL gate set this spec depends on. A seeded assignment answers every
 * unlisted key `false`, so naming only the rollout key would close Labs and take
 * the rows underneath it with the section — and the assertions below would then
 * be about an empty tree.
 */
const V2_FLAGS: Record<string, boolean> = {
  [AGENTS_NAV_FLAG_KEY]: true,
  [LABS_NAV_FLAG_KEY]: true,
  [SHELL_SIDEBAR_V2_FLAG_KEY]: true,
};
const LEGACY_FLAGS: Record<string, boolean> = {
  ...V2_FLAGS,
  [SHELL_SIDEBAR_V2_FLAG_KEY]: false,
};

const PROFILE_ID = "iss-9734-shell-sidebar-v2-profile";
const PROFILE_NAME = "ISS-9734 Shell Sidebar v2 E2E";
const SHELL_TIMEOUT_MS = 120_000;
const NAV_READY_TIMEOUT_MS = 30_000;
/** The Labs search box's accessible name (inline in `SidebarSearchForm`). */
const SEARCH_TEXTBOX_NAME = "Search";

test("renders the v2 hierarchy, expands Labs, and navigates from it", async () => {
  test.setTimeout(SHELL_TIMEOUT_MS);
  const server = await startNavigationCloudServer();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-shell-sidebar-v2-")
  );
  try {
    const { page, pageErrors, cleanup } = await launchShell({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      apiOrigin: server.origin,
      flags: V2_FLAGS,
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");

      // Outside Labs: exactly what PRD-690 R3 keeps there.
      await expect(navLink(page, "Dashboard")).toBeVisible({
        timeout: NAV_READY_TIMEOUT_MS,
      });
      await expect(navLink(page, "Sessions")).toBeVisible();
      await expect(navLink(page, "Branches")).toBeVisible();
      // Labs ships CLOSED, so its rows and the Search control are not on screen.
      await expect(navLink(page, "Agents")).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Labs" }).click();
      await expect(navLink(page, "Agents")).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: SEARCH_TEXTBOX_NAME })
      ).toBeVisible();
      // The one structural thing ONLY the v2 tree has: Agents and Routines live
      // in Labs › Artifacts, so a SECOND Artifacts disclosure appears inside
      // Labs (PLN-2016 D2). Every other assertion in this case also passes
      // against `LegacyDesktopSidebar`, which ships Labs collapsed and offers
      // these same rows once expanded.
      await expect(page.getByRole("button", { name: "Artifacts" })).toHaveCount(
        2
      );

      await navLink(page, "Sessions").click();
      await expect
        .poll(() => currentHashRoute(page), { timeout: NAV_READY_TIMEOUT_MS })
        .toBe("/sessions");

      // Labs stays open across a navigation: the sidebar does not remount and
      // the section's open state is persisted, so a second click would close it.
      await expect(navLink(page, "Agents")).toBeVisible();
      await navLink(page, "Agents").click();
      await expect
        .poll(() => currentHashRoute(page), { timeout: NAV_READY_TIMEOUT_MS })
        .toBe("/agents");

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

test("keeps today's sidebar with the key off, and restores it on rollback", async () => {
  test.setTimeout(SHELL_TIMEOUT_MS);
  const server = await startNavigationCloudServer();
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-shell-sidebar-v2-rollback-")
  );
  try {
    // On: Labs holds a SECOND Artifacts disclosure. The count is what tells the
    // arms apart — the legacy `LabsNavSection` also ships `defaultOpen={false}`
    // and also renders a Dashboard link, so a visible-link assertion alone would
    // pass on a key that never switched trees.
    const on = await launchShell({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      apiOrigin: server.origin,
      flags: V2_FLAGS,
      userDataDir,
    });
    try {
      await gotoHash(on.page, "/dashboard");
      await expect(navLink(on.page, "Dashboard")).toBeVisible({
        timeout: NAV_READY_TIMEOUT_MS,
      });
      await on.page.getByRole("button", { name: "Labs" }).click();
      await expect(
        on.page.getByRole("button", { name: "Artifacts" })
      ).toHaveCount(2);
      expect(on.pageErrors).toEqual([]);
    } finally {
      await on.cleanup();
    }

    // Rollback is a flag flip, and the off arm is the tree every desktop user
    // has today: its rows are links whatever the cloud said, because they are
    // not built from the projection at all.
    const off = await launchShell({
      apiOrigin: server.origin,
      flags: LEGACY_FLAGS,
      userDataDir,
    });
    try {
      await gotoHash(off.page, "/dashboard");
      await expect(navLink(off.page, "Dashboard")).toBeVisible({
        timeout: NAV_READY_TIMEOUT_MS,
      });
      // The legacy tree has ONE Artifacts group; the v2 tree nests a second one
      // inside Labs (PLN-2016 D2).
      await off.page.getByRole("button", { name: "Labs" }).click();
      await expect(
        off.page.getByRole("button", { name: "Artifacts" })
      ).toHaveCount(1);
      expect(off.pageErrors).toEqual([]);
    } finally {
      await off.cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

function navLink(page: Page, name: string) {
  return page.getByRole("link", { name, exact: true });
}

function launchShell({
  apiOrigin,
  sameProcessSessionSeed,
  flags,
  userDataDir,
}: {
  apiOrigin: string;
  sameProcessSessionSeed?: ReturnType<
    typeof createAuthenticatedDesktopSessionRecord
  >;
  flags: Record<string, boolean>;
  userDataDir: string;
}) {
  return launchShellSidebarApp({
    sameProcessSessionSeed,
    apiOrigin,
    flags,
    profileId: PROFILE_ID,
    profileName: PROFILE_NAME,
    userDataDir,
  });
}
