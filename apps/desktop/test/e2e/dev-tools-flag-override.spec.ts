import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  closeServer,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash } from "./helpers/desktop-app";
import {
  launchShellSidebarApp,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

// Desktop E2E cannot load extension-less @repo subpaths. These are the keys in
// packages/api/src/types and the shared Dev Tools copy module.
const FLAGS = {
  "dev-mode": true,
  docsHelp: true,
  labsNav: true,
  "shell-sidebar-v2": true,
};
const OVERRIDES_STORAGE_KEY = "closedloop:feature-flag-overrides";

test("Dev Tools forces a Desktop flag off in the renderer, then restores its prod value", async () => {
  test.setTimeout(120_000);
  const server = await startNavigationCloudServer({
    staffIdentity: true,
    featureFlags: FLAGS,
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-dev-tools-override-")
  );
  try {
    const launched = await launchShellSidebarApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      apiOrigin: server.origin,
      flags: FLAGS,
      profileId: "iss-12048-dev-tools-profile",
      profileName: "ISS-12048 Dev Tools E2E",
      userDataDir,
    });
    try {
      const { page } = launched;
      await gotoHash(page, "/dashboard");
      await expect(
        page.getByRole("button", { name: "Dev Tools" })
      ).toBeVisible();
      await page.getByRole("button", { name: "Labs" }).click();
      const help = page.getByRole("link", { name: "Help", exact: true });
      await expect(help).toBeVisible();

      await page.getByRole("button", { name: "Dev Tools" }).click();
      const panel = page.getByRole("dialog", { name: "Dev Tools" });
      await panel.getByRole("switch", { name: "All flags" }).click();
      const flag = panel.getByRole("radiogroup", { name: "docsHelp" });
      await expect(
        flag.getByRole("radio", { checked: true })
      ).toHaveAccessibleName("On");
      await flag.getByRole("radio", { name: "Off" }).click();
      await expect(help).toHaveCount(0);
      await expect(
        flag.getByRole("radio", { checked: true })
      ).toHaveAccessibleName("Off, local override");
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
          OVERRIDES_STORAGE_KEY
        )
      ).toMatchObject({ docsHelp: false });

      await flag.getByRole("radio", { name: "On" }).click();
      await expect(help).toBeVisible();
      await expect(
        flag.getByRole("radio", { checked: true })
      ).toHaveAccessibleName("On");
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
          OVERRIDES_STORAGE_KEY
        )
      ).toEqual({});
      expect(launched.pageErrors).toEqual([]);
    } finally {
      await launched.cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
